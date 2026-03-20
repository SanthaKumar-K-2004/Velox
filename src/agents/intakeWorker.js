import { intakeAgent } from './intake.js';
import { filterAgent } from './filter.js';
import { contextBuilderAgent } from './contextBuilder.js';
import { aiBrainAgent } from './aiBrain.js';
import { autonomyAgent } from './autonomy.js';
import { notificationAgent } from './notification.js';
import { logger } from '../utils/logger.js';
import { supabase } from '../config/supabase.js';
import { gmailService } from '../services/gmail.js';

/**
 * Velox — Intake Worker
 * Coordinates the full email processing pipeline:
 * Intake → Filter → Context → AI Brain → Autonomy → Notification
 */
export const intakeWorker = {

    /**
     * Process incoming push from Google Cloud Pub/Sub
     * @param {string} userId 
     * @param {string} userEmail 
     * @param {string} historyId 
     */
    async processFromPush(userId, userEmail, historyId) {
        try {
            logger.debug('IntakeWorker', 'PushInit', `Checking pushed emails for ${userEmail}. HistoryId: ${historyId}`);
            // Find recent unread emails (limit to 3 just in case multiple arrived at once)
            const messages = await gmailService.listMessages(userId, 'is:unread', 3, userEmail);

            for (const msg of messages) {
                // Check if we already processed it
                const { data: existing } = await supabase.from('email_history').select('message_id').eq('message_id', msg.id).maybeSingle();
                if (existing) continue;

                // We found a new message. Fetch the full message data.
                const detail = await gmailService.getMessage(userId, msg.id, userEmail);

                const payload = {
                    messageId: detail.id,
                    threadId: detail.threadId,
                    subject: detail.subject,
                    from: detail.from,
                    date: new Date().toISOString(), // Fallback
                    snippet: detail.snippet,
                    userId,
                    userEmail
                };

                logger.info('IntakeWorker', 'PushMatch', `New pushed email picked up for ${userEmail}: ${detail.id}`);

                // Route through the standard pipeline
                await this.process(payload);
            }
        } catch (err) {
            logger.error('IntakeWorker', 'ProcessFromPush', `Failed to process push for ${userEmail}`, err);
        }
    },

    /**
     * Main processing pipeline
     * @param {Object} emailData - Raw email data from webhook
     */
    async process(emailData) {
        const { messageId, userEmail } = emailData;

        try {
            // ═══ Stage 1: Intake Agent — Deduplicate and Lock ═══
            const record = await intakeAgent.processEmail(emailData);
            if (!record) return; // Duplicate or error — stop here

            // ═══ Stage 2: Filter Agent — Classify ═══
            const classification = filterAgent.classify(emailData);
            logger.info('Pipeline', 'Filter', `${messageId} → ${classification.bucket} (${classification.signals.join(', ') || 'no signals'})`);

            // ═══ Stage 3: Route based on classification ═══
            switch (classification.bucket) {
            case 'ALWAYS_NOTIFY':
                await this.handleAlwaysNotify(emailData, classification);
                break;
            case 'STORE_AND_DIGEST':
                await this.handleStoreAndDigest(emailData, classification);
                break;
            case 'TRUE_TRASH':
                await this.handleTrash(emailData, classification);
                break;
            case 'NEEDS_AI':
                await this.handleNeedsAI(emailData, classification);
                break;
            }

            // ═══ Stage 4: Mark as complete ═══
            await intakeAgent.updateStatus(messageId, userEmail, 'done');
            logger.info('Pipeline', 'Complete', `${messageId} processed successfully`);

        } catch (err) {
            logger.error('Pipeline', 'Error', `Failed to process ${messageId}`, err);
            if (messageId) {
                await intakeAgent.updateStatus(messageId, userEmail, 'failed');
            }
        }
    },

    /**
     * Bucket A — Urgent notifications (payments, OTPs, security alerts)
     * Notify user immediately via Telegram
     */
    async handleAlwaysNotify(emailData, classification) {
        const { userId } = emailData;

        // Fetch user's telegram_chat_id
        const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
        const chatId = user?.telegram_chat_id;

        logger.info('Pipeline', 'BucketA', `${emailData.messageId} → Immediate notification for user ${userId}`);

        if (chatId) {
            await notificationAgent.notifyBucketA(chatId, emailData, classification.signals);
        } else {
            logger.warn('Pipeline', 'NoChatId', `Cannot notify user ${userId} — no Telegram chat ID found`);
        }

        // Store classification record
        await this.storeClassification(emailData, classification, 'notified');
    },

    /**
     * Bucket B — Store for daily digest, no immediate notification
     */
    async handleStoreAndDigest(emailData, classification) {
        logger.info('Pipeline', 'BucketB', `${emailData.messageId} → Stored for digest`);

        // Store classification record for digest generation
        await this.storeClassification(emailData, classification, 'digest');
    },

    /**
     * Bucket C — True trash, silent delete
     */
    async handleTrash(emailData, classification) {
        logger.info('Pipeline', 'BucketC', `${emailData.messageId} → Trashed silently`);

        await this.storeClassification(emailData, classification, 'trashed');
    },

    /**
     * Bucket D — Needs AI analysis
     * Full pipeline: Context Builder → AI Brain → Autonomy → Notification
     */
    async handleNeedsAI(emailData, classification) {
        const { messageId, userId } = emailData;

        // Fetch user's telegram_chat_id
        const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
        const chatId = user?.telegram_chat_id;

        logger.info('Pipeline', 'BucketD', `${messageId} → AI processing for user ${userId}`);

        // 3.1 Build context for AI
        const context = await contextBuilderAgent.buildContext(userId, emailData, emailData.userEmail);

        // Pass hard stop info into context
        context.isHardStop = classification.isHardStop;

        // 3.2 AI Brain — analyze and draft reply
        const aiResult = await aiBrainAgent.process(userId, context);
        logger.info('Pipeline', 'AIResult', `${messageId} → Confidence: ${aiResult.confidence}% | Intent: ${aiResult.intent}`);

        // 3.3 Autonomy Agent — decide what to do with the AI result
        const decision = await autonomyAgent.handleDecision(userId, aiResult, context);
        logger.info('Pipeline', 'Autonomy', `${messageId} → Level ${decision.autonomy_level}`);

        // 3.4 Notification Agent — notify user via Telegram
        if (chatId) {
            await notificationAgent.notifyEmailResult(chatId, decision, emailData, decision);
        } else {
            logger.warn('Pipeline', 'NoChatId', `Cannot notify user ${userId} — no Telegram chat ID found`);
        }

        // 3.5 If Level 2 (whitelisted auto-send), create pending send
        if (decision.autonomy_level === 2) {
            await autonomyAgent.createPendingSend(userId, {
                email_to: emailData.from,
                subject: `Re: ${emailData.subject}`,
                body: decision.draft_reply,
                thread_id: emailData.threadId,
            }, decision.delay_mins, emailData.userEmail);
        }

        // Store classification record
        await this.storeClassification(emailData, classification, 'ai_processed', aiResult);
    },

    /**
     * Store email classification record in email_history for analytics
     */
    async storeClassification(emailData, classification, action, aiResult = null) {
        try {
            await supabase.from('email_history').insert({
                user_id: emailData.userId,
                user_email: emailData.userEmail,
                message_id: emailData.messageId,
                thread_id: emailData.threadId || null,
                recipient: emailData.from,
                subject: emailData.subject,
                ai_draft: aiResult?.draft_reply || null,
                autonomy_level: aiResult?.autonomy_level || null,
                confidence: aiResult?.confidence || null,
            });
        } catch (err) {
            logger.error('Pipeline', 'StoreClassification', `Failed for ${emailData.messageId}`, err);
        }
    },
};
