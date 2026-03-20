import { supabase } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { CONSTANTS } from '../config/constants.js';
import { v4 as uuidv4 } from 'uuid';
import { sendAgent } from './send.js';
import { telegramService } from '../services/telegram.js';

/**
 * Agent 5 — Autonomy Agent
 * Decides what happens after AI Brain returns.
 * Enforces THE ONE LAW. Manages pending sends. Handles timeout logic.
 */
export const autonomyAgent = {

    /**
     * Main decision: determine what autonomy level to apply
     * @param {Object} aiResult - Result from AI Brain Agent
     * @param {Object} userSettings - User's whitelist/settings
     * @param {boolean} isHardStop - Whether hard stop keywords were detected
     * @returns {Object} - { level: 1|2|3, reason?: string, delay_mins?: number, undo_mins?: number }
     */
    decideAutonomy(aiResult, userSettings = {}, isHardStop = false) {

        // Hard stops ALWAYS override everything → Level 3
        if (isHardStop || aiResult.hard_stop) {
            return {
                level: CONSTANTS.AUTONOMY_LEVELS.ALWAYS_HUMAN,
                reason: aiResult.hard_stop_reason || 'Hard stop keyword detected',
            };
        }

        // Meeting/scheduling → always Level 3
        if (aiResult.intent === 'meeting_request') {
            return {
                level: CONSTANTS.AUTONOMY_LEVELS.ALWAYS_HUMAN,
                reason: 'Meeting scheduling requires your decision',
            };
        }

        // Financial/payment → always Level 3
        if (aiResult.intent === 'payment') {
            return {
                level: CONSTANTS.AUTONOMY_LEVELS.ALWAYS_HUMAN,
                reason: 'Financial matters require your approval',
            };
        }

        // Low confidence → always Level 3
        if (aiResult.confidence < 75) {
            return {
                level: CONSTANTS.AUTONOMY_LEVELS.ALWAYS_HUMAN,
                reason: `Confidence only ${aiResult.confidence}%`,
            };
        }

        // First contact from unknown → always Level 3
        if (aiResult.classification === 'unknown') {
            return {
                level: CONSTANTS.AUTONOMY_LEVELS.ALWAYS_HUMAN,
                reason: 'First contact from unknown sender',
            };
        }

        // Check user whitelist for Level 2 (auto-send with delay)
        const whitelisted = userSettings.auto_send_categories || [];
        if (whitelisted.includes(aiResult.intent) && aiResult.confidence >= 90) {
            return {
                level: CONSTANTS.AUTONOMY_LEVELS.WHITELISTED,
                delay_mins: userSettings.delay_mins || 3,
                undo_mins: userSettings.undo_mins || 15,
            };
        }

        // Default — Level 1 (draft + notify, user taps send)
        return { level: CONSTANTS.AUTONOMY_LEVELS.DRAFT_READY };
    },

    /**
     * Get user's auto-send whitelist settings
     */
    async getUserSettings(userId) {
        const { data } = await supabase
            .from('auto_send_whitelist')
            .select('*')
            .eq('user_id', userId)
            .eq('enabled', true);

        if (!data || data.length === 0) {
            return { auto_send_categories: [] };
        }

        return {
            auto_send_categories: data.map(d => d.email_intent),
            delay_mins: data[0]?.delay_mins || 3,
            undo_mins: data[0]?.undo_mins || 15,
        };
    },

    /**
     * Create a pending send record in Supabase (survives server restarts)
     */
    async createPendingSend(userId, draft, delayMins = 3, userEmail) {
        const sendAt = new Date(Date.now() + delayMins * 60 * 1000);

        const { data, error } = await supabase
            .from('pending_sends')
            .insert({
                id: uuidv4(),
                user_id: userId,
                user_email: userEmail,
                email_to: draft.email_to,
                subject: draft.subject,
                body: draft.body,
                attachments: draft.attachments || null,
                thread_id: draft.thread_id || null,
                send_at: sendAt.toISOString(),
                status: 'pending',
                telegram_message_id: draft.telegram_message_id || null,
            })
            .select()
            .single();

        if (error) {
            logger.error('Autonomy', 'PendingSend', 'Failed to create pending send', error);
            return null;
        }

        logger.info('Autonomy', 'PendingSend', `Scheduled send at ${sendAt.toISOString()} for ${draft.email_to}`);
        return data;
    },

    /**
     * Generate a context-aware holding reply
     * Used when confidence is low or during away/night mode
     */
    generateHoldingReply(email, memory = {}) {
        const now = new Date();
        const hour = now.getHours();
        let timeEstimate;

        if (hour >= 22 || hour < 7) {
            timeEstimate = 'first thing tomorrow morning';
        } else if (hour >= 7 && hour < 12) {
            timeEstimate = 'later today';
        } else if (hour >= 12 && hour < 17) {
            timeEstimate = 'within the next few hours';
        } else {
            timeEstimate = 'tomorrow morning';
        }

        const senderName = email.fromName || email.from?.split('@')[0] || 'there';
        const signOff = memory.sign_off || 'Best,';

        return `Hi ${senderName}, thanks for reaching out. I will review this properly and get back to you ${timeEstimate}. ${signOff}`;
    },

    /**
     * Check and process pending sends that are due
     * (called periodically by a scheduler)
     */
    async checkPendingSends() {
        const { data: due, error } = await supabase
            .from('pending_sends')
            .select('*')
            .eq('status', 'pending')
            .lte('send_at', new Date().toISOString());

        if (error || !due || due.length === 0) return;

        logger.info('Autonomy', 'PendingSends', `${due.length} pending send(s) due for processing`);

        for (const send of due) {
            try {
                logger.info('Autonomy', 'SendPending', `Dispatching ${send.id} to Send Agent`);

                const sentResult = await sendAgent.sendEmail(send.user_id, {
                    email_to: send.email_to,
                    subject: send.subject,
                    body: send.body,
                    thread_id: send.thread_id
                }, 0, send.user_email);

                const sentMessageId = sentResult.id;

                await supabase
                    .from('pending_sends')
                    .update({ status: 'sent' })
                    .eq('id', send.id);

                const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', send.user_id).single();
                if (user?.telegram_chat_id) {
                    const notifyText = `🚀 *Sent via Velox*\n\nYour draft to *${send.email_to}* regarding "${send.subject}" has been dispatched automatically.`;
                    await telegramService.sendMessage(user.telegram_chat_id, notifyText, {
                        reply_markup: {
                            inline_keyboard: [[{ text: '↩️ Undo', callback_data: `undo_${sentMessageId}_${send.user_email}` }]]
                        }
                    });
                }
            } catch (err) {
                logger.error('Autonomy', 'SendPending', `Failed to process ${send.id}`, err);
                await supabase.from('pending_sends').update({ status: 'error' }).eq('id', send.id);
            }
        }
    },

    /**
     * Handle the full autonomy decision flow
     */
    async handleDecision(userId, aiResult, context) {
        const userSettings = await this.getUserSettings(userId);
        const isHardStop = context.email?.isHardStop || aiResult.hard_stop || false;

        const decision = this.decideAutonomy(aiResult, userSettings, isHardStop);

        logger.info('Autonomy', 'Decision', `Level ${decision.level} | Reason: ${decision.reason || 'default'}`);

        return {
            ...aiResult,
            autonomy_level: decision.level,
            autonomy_reason: decision.reason || null,
            delay_mins: decision.delay_mins || null,
            undo_mins: decision.undo_mins || null,
        };
    },
};
