import { supabase } from '../config/supabase.js';
import { gmailService } from '../services/gmail.js';
import { telegramService } from '../services/telegram.js';
import { logger } from '../utils/logger.js';

/**
 * Agent 8 - Send Agent
 * Only agent that touches the Gmail send API.
 */
export const sendAgent = {

    /**
     * Send structured email (typically from a pending_send or drafted directly)
     * @param {string} userId
     * @param {Object} draft
     * @param {number} delayMs
     */
    async sendEmail(userId, draft, delayMs = 0, userEmail) {
        try {
            const accountEmail = userEmail || draft.user_email || draft.userEmail || null;

            if (draft.hard_stop) {
                throw new Error('Hard stop - cannot send without user approval');
            }

            if (delayMs > 0) {
                logger.debug('SendAgent', 'Delay', `Waiting ${delayMs}ms before sending to ${draft.email_to}`);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }

            const result = await gmailService.sendEmail(userId, {
                to: draft.email_to,
                subject: draft.subject,
                body: draft.body,
                threadId: draft.thread_id,
                attachments: [],
            }, accountEmail);

            const sentMessageId = result.id;

            await supabase.from('email_history').insert({
                user_id: userId,
                user_email: accountEmail,
                message_id: sentMessageId,
                thread_id: draft.thread_id,
                recipient: draft.email_to,
                subject: draft.subject,
                ai_draft: draft.ai_draft || draft.body,
                final_sent: draft.body,
                was_edited: draft.was_edited || false,
                edit_diff: draft.edit_diff || null,
                sent_at: new Date().toISOString(),
            });

            logger.info('SendAgent', 'Sent', `Successfully sent email to ${draft.email_to} (ID: ${sentMessageId})`);
            return result;
        } catch (err) {
            logger.error('SendAgent', 'Failed', `Failed to send email to ${draft.email_to}`, err);
            throw err;
        }
    },

    /**
     * Undo a sent email (move to trash within the undo window)
     */
    async undoSend(userId, messageId, userEmail) {
        try {
            const { data: history } = await supabase
                .from('email_history')
                .select('*')
                .eq('message_id', messageId)
                .single();

            if (!history) {
                return { success: false, message: 'Message not found in history' };
            }

            const sentTime = new Date(history.sent_at).getTime();
            const now = Date.now();
            const minsPassed = (now - sentTime) / 60000;

            if (minsPassed > 15) {
                return { success: false, message: 'Undo window (15m) expired' };
            }

            await gmailService.trashMessage(userId, messageId, userEmail || history.user_email);

            const { data: user } = await supabase
                .from('users')
                .select('telegram_chat_id')
                .eq('id', userId)
                .single();

            if (user?.telegram_chat_id) {
                await telegramService.sendMessage(user.telegram_chat_id, 'Email recalled successfully and moved to trash.');
            }

            logger.info('SendAgent', 'Undo', `Successfully recalled message ${messageId}`);
            return { success: true };
        } catch (err) {
            logger.error('SendAgent', 'UndoFailed', `Failed to undo message ${messageId}`, err);
            return { success: false, message: 'Failed to communicate with Gmail' };
        }
    },
};
