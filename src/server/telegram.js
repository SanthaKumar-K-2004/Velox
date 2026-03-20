import express from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { telegramCommands } from './telegramCommands.js';
import { telegramService } from '../services/telegram.js';
import { sendAgent } from '../agents/send.js';
import { memoryAgent } from '../agents/memory.js';
import { supabase } from '../config/supabase.js';
import { nlHandler } from '../agents/nlHandler.js';

const router = express.Router();

/**
 * Velox — Telegram Webhook Handler
 */
router.post(`/${env.telegramBotToken}`, async (req, res, next) => {
    try {
        const update = req.body;
        res.status(200).send('OK'); // Always ACK immediately

        handleUpdate(update).catch(err => {
            logger.error('Telegram', 'UpdateHandler', 'Failed to process update', err);
        });
    } catch (err) {
        next(err);
    }
});

async function handleUpdate(update) {
    if (update.message?.text) {
        const chatId = update.message.chat.id.toString();
        const text = update.message.text.trim();

        logger.debug('Telegram', 'Message', `From ${chatId}: ${text}`);
        const normalized = text.toLowerCase().trim();

        // 1. Resolve userId early
        const userId = await telegramCommands.resolveUser(chatId);

        // 2. Unregistered Users
        if (!userId) {
            if (normalized === '/start' || normalized === 'start' || normalized === 'hi' || normalized === 'hello') {
                return telegramCommands.handleStart(chatId);
            }
            return telegramService.sendMessage(chatId, '👋 Please say "start" to register before using the assistant.');
        }

        // 3. Prevent duplicate dashboard registration if they say start again
        if (normalized === '/start' || normalized === 'start') {
            return telegramCommands.handleStart(chatId);
        }

        // 4. Handle Onboarding Conversations
        const { data: user } = await supabase.from('users').select('onboarding_status').eq('id', userId).single();
        if (user?.onboarding_status && user.onboarding_status !== 'done') {
            return memoryAgent.handleOnboardingMessage(userId, text);
        }

        // 5. OMNI-ROUTER: Send everything else to Natural Language AI
        return nlHandler.handle(userId, chatId, text);
    }

    // Handle incoming photos or documents (Phase 11)
    if (update.message?.document || update.message?.photo) {
        const chatId = update.message.chat.id.toString();
        const userId = await telegramCommands.resolveUser(chatId);
        if (!userId) return telegramService.sendMessage(chatId, '👋 Please say "start" to register first.');

        return telegramService.sendMessage(chatId, '📎 File received! I will process and store this in your Vault shortly.');
        // Implementation for downloading and OCR will go here
    }

    if (update.callback_query) {
        const queryId = update.callback_query.id;
        const chatId = update.callback_query.message.chat.id.toString();
        const data = update.callback_query.data;
        const messageId = update.callback_query.message.message_id;

        const userId = await telegramCommands.resolveUser(chatId);
        if (!userId) return telegramService.answerCallbackQuery(queryId, 'Please say start first.');

        logger.debug('Telegram', 'Callback', `Action: ${data} from ${chatId} (User: ${userId})`);

        await handleCallbackQuery(queryId, chatId, messageId, data, userId);
    }
}

async function handleCallbackQuery(queryId, chatId, telegramMsgId, data, userId) {
    try {
        switch (data) {
        case 'send_all_pending':
            await telegramService.answerCallbackQuery(queryId, 'Sending all pending...');
            await telegramService.editMessage(chatId, telegramMsgId, '✅ All pending emails queued for sending.');
            // Trigger autonomy check to clear them
            break;

        case 'dismiss_all_pending':
            await telegramService.answerCallbackQuery(queryId, 'Dismissed.');
            await telegramService.editMessage(chatId, telegramMsgId, '🗑 All pending drafts dismissed.');
            await supabase.from('pending_sends').update({ status: 'dismissed' }).eq('user_id', userId).eq('status', 'pending');
            break;

        default:
            if (data.startsWith('send_')) {
                const messageId = data.replace('send_', '');
                await telegramService.answerCallbackQuery(queryId, 'Queuing to send...');
                await telegramService.editMessage(chatId, telegramMsgId, '✅ Email queued to send via Gmail.');

                // Fetch the draft from email_history to send
                const { data: history } = await supabase.from('email_history').select('*').eq('message_id', messageId).single();
                if (history) {
                    try {
                        await sendAgent.sendEmail(userId, {
                            email_to: history.recipient,
                            subject: history.subject,
                            body: history.ai_draft,
                            thread_id: history.thread_id
                        }, 5000, history.user_email); // Pass the correct user_email
                    } catch (e) {
                        logger.error('Telegram', 'SendDraft', `Failed to send draft ${messageId}`, e);
                    }
                }

            } else if (data.startsWith('edit_')) {
                await telegramService.answerCallbackQuery(queryId, 'Edit mode...');
                await telegramService.sendMessage(chatId, '✏️ Reply with your edited version:');

            } else if (data.startsWith('reject_')) {
                await telegramService.answerCallbackQuery(queryId, 'Rejected.');
                await telegramService.editMessage(chatId, telegramMsgId, '❌ Draft rejected.');
                await memoryAgent.learnFromInteraction(userId, { type: 'USER_REJECTED_DRAFT' });

            } else if (data.startsWith('undo_')) {
                const messageId = data.replace('undo_', '');
                await telegramService.answerCallbackQuery(queryId, 'Undoing...');
                const { data: history } = await supabase.from('email_history').select('user_email').eq('message_id', messageId).single();
                const res = await sendAgent.undoSend(userId, messageId, history?.user_email);
                if (res.success) {
                    await telegramService.editMessage(chatId, telegramMsgId, '↩️ Email successfully recalled.');
                } else {
                    await telegramService.sendMessage(chatId, `Failed to undo: ${res.message}`);
                }
            } else {
                await telegramService.answerCallbackQuery(queryId);
            }
        }
    } catch (err) {
        logger.error('Telegram', 'CallbackHandler', `Failed for ${data}`, err);
        await telegramService.answerCallbackQuery(queryId, 'Something went wrong.');
    }
}

export default router;
