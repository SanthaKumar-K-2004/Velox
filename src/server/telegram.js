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

        if (text.startsWith('/')) {
            const parts = text.split(' ');
            const cmd = parts[0].toLowerCase().replace('@', '');
            const args = parts.slice(1).join(' ');

            if (cmd === '/start') return telegramCommands.handleStart(chatId);

            // Resolve userId for all other commands
            const userId = await telegramCommands.resolveUser(chatId);
            if (!userId) {
                return telegramService.sendMessage(chatId, '👋 Please type /start to register before using other commands.');
            }

            switch (cmd) {
            case '/help': return telegramCommands.handleHelp(chatId);
            case '/status': return telegramCommands.handleStatus(chatId);
            case '/inbox': return telegramCommands.handleInbox(chatId, userId);
            case '/pending': return telegramCommands.handlePending(chatId, userId);
            case '/vault': return telegramCommands.handleVault(chatId, userId);
            case '/find': return telegramCommands.handleFind(chatId, args, userId);
            case '/vip': return telegramCommands.handleVip(chatId, args, userId);
            case '/ignore': return telegramCommands.handleIgnore(chatId, args, userId);
            case '/away': return telegramCommands.handleAway(chatId, args, userId);
            case '/sent': return telegramCommands.handleSent(chatId, userId);
            case '/search': return telegramCommands.handleSearch(chatId, args, userId);
            case '/back': return telegramCommands.handleBack(chatId, userId);
            case '/pause': return telegramCommands.handlePause(chatId, userId);
            case '/resume': return telegramCommands.handleResume(chatId, userId);
            case '/tone': return telegramCommands.handleTone(chatId, args, userId);
            case '/whitelist': return telegramCommands.handleWhitelist(chatId, args, userId);
            case '/undo': return telegramCommands.handleUndo(chatId, userId);
            default: return telegramCommands.handleUnknown(chatId);
            }
        }

        // Handle interaction or Onboarding
        const userId = await telegramCommands.resolveUser(chatId);
        if (!userId) return telegramService.sendMessage(chatId, '👋 Please type /start to register.');

        // Check onboarding state
        const { data: user } = await supabase.from('users').select('onboarding_status').eq('id', userId).single();
        if (user?.onboarding_status && user.onboarding_status !== 'done') {
            return memoryAgent.handleOnboardingMessage(userId, text);
        }

        // Wire up natural language agent
        return nlHandler.handle(userId, chatId, text);
    }

    if (update.callback_query) {
        const queryId = update.callback_query.id;
        const chatId = update.callback_query.message.chat.id.toString();
        const data = update.callback_query.data;
        const messageId = update.callback_query.message.message_id;

        const userId = await telegramCommands.resolveUser(chatId);
        if (!userId) return telegramService.answerCallbackQuery(queryId, 'Please type /start first.');

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
