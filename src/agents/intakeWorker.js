import { intakeAgent } from './intake.js';
import { filterAgent } from './filter.js';
import { contextBuilderAgent } from './contextBuilder.js';
import { aiBrainAgent } from './aiBrain.js';
import { autonomyAgent } from './autonomy.js';
import { notificationAgent } from './notification.js';
import { logger } from '../utils/logger.js';
import { supabase } from '../config/supabase.js';
import { gmailService } from '../services/gmail.js';
import { helpers } from '../utils/helpers.js';

/**
 * Velox â€” Intake Worker
 * Coordinates the full email processing pipeline:
 * Intake â†’ Filter â†’ Context â†’ AI Brain â†’ Autonomy â†’ Notification
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
            const messages = await gmailService.listMessages(userId, 'is:unread', 3, userEmail);

            for (const msg of messages) {
                const { data: existing } = await supabase
                    .from('email_history')
                    .select('message_id')
                    .eq('message_id', msg.id)
                    .maybeSingle();
                if (existing) continue;

                const detail = await gmailService.getMessage(userId, msg.id, userEmail);
                const payload = {
                    messageId: detail.id,
                    threadId: detail.threadId,
                    subject: detail.subject,
                    from: detail.from,
                    fromName: detail.fromName,
                    date: detail.timestamp || new Date().toISOString(),
                    snippet: detail.snippet,
                    body: detail.body,
                    userId,
                    userEmail,
                };

                logger.info('IntakeWorker', 'PushMatch', `New pushed email picked up for ${userEmail}: ${detail.id}`);
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
            const record = await intakeAgent.processEmail(emailData);
            if (!record) return;

            const classification = filterAgent.classify(emailData);
            logger.info('Pipeline', 'Filter', `${messageId} â†’ ${classification.bucket} (${classification.signals.join(', ') || 'no signals'})`);

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
            default:
                break;
            }

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
     * Bucket A â€” Urgent notifications (payments, OTPs, security alerts)
     */
    async handleAlwaysNotify(emailData, classification) {
        const { userId } = emailData;
        const { data: user } = await supabase
            .from('users')
            .select('telegram_chat_id')
            .eq('id', userId)
            .single();
        const chatId = user?.telegram_chat_id;

        logger.info('Pipeline', 'BucketA', `${emailData.messageId} â†’ Immediate notification for user ${userId}`);

        if (chatId) {
            await notificationAgent.notifyBucketA(chatId, emailData, classification.signals);
        } else {
            logger.warn('Pipeline', 'NoChatId', `Cannot notify user ${userId} â€” no Telegram chat ID found`);
        }

        await this.storeClassification(emailData, classification, 'notified');
    },

    /**
     * Bucket B â€” Store for daily digest, no immediate notification
     */
    async handleStoreAndDigest(emailData, classification) {
        logger.info('Pipeline', 'BucketB', `${emailData.messageId} â†’ Stored for digest`);
        await this.storeClassification(emailData, classification, 'digest');
    },

    /**
     * Bucket C â€” True trash, silent delete
     */
    async handleTrash(emailData, classification) {
        logger.info('Pipeline', 'BucketC', `${emailData.messageId} â†’ Trashed silently`);
        await this.storeClassification(emailData, classification, 'trashed');
    },

    /**
     * Bucket D â€” Needs AI analysis
     */
    async handleNeedsAI(emailData, classification) {
        const { messageId, userId } = emailData;
        const { data: user } = await supabase
            .from('users')
            .select('telegram_chat_id')
            .eq('id', userId)
            .single();
        const chatId = user?.telegram_chat_id;

        logger.info('Pipeline', 'BucketD', `${messageId} â†’ AI processing for user ${userId}`);

        const context = await contextBuilderAgent.buildContext(userId, emailData, emailData.userEmail);
        context.isHardStop = classification.isHardStop;

        const aiResult = await aiBrainAgent.process(userId, context);
        logger.info('Pipeline', 'AIResult', `${messageId} â†’ Confidence: ${aiResult.confidence}% | Intent: ${aiResult.intent}`);

        const decision = await autonomyAgent.handleDecision(userId, aiResult, context);
        logger.info('Pipeline', 'Autonomy', `${messageId} â†’ Level ${decision.autonomy_level}`);

        let pendingSend = null;
        if (decision.autonomy_level === 2) {
            pendingSend = await autonomyAgent.createPendingSend(userId, {
                email_to: context.email.replyTo || context.email.from,
                subject: helpers.buildReplySubject(context.email.subject),
                body: decision.draft_reply,
                thread_id: context.email.threadId || emailData.threadId,
            }, decision.delay_mins, emailData.userEmail);
        }

        if (chatId) {
            if (decision.autonomy_level !== 2 || pendingSend) {
                await notificationAgent.notifyEmailResult(chatId, decision, context.email, decision);
            } else {
                await notificationAgent.sendSystemAlert(
                    chatId,
                    'Queue Error',
                    'A reply was drafted, but it could not be queued for auto-send. Please review it manually.'
                );
            }
        } else {
            logger.warn('Pipeline', 'NoChatId', `Cannot notify user ${userId} â€” no Telegram chat ID found`);
        }

        await this.storeClassification(context.email, classification, 'ai_processed', decision);
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
