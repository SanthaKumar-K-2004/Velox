import express from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { telegramCommands } from './telegramCommands.js';
import { telegramService } from '../services/telegram.js';
import { sendAgent } from '../agents/send.js';
import { memoryAgent } from '../agents/memory.js';
import { supabase } from '../config/supabase.js';
import { nlHandler } from '../agents/nlHandler.js';
import { vaultAgent } from '../agents/vault.js';
import { gmailService } from '../services/gmail.js';
import { aiBrainAgent } from '../agents/aiBrain.js';
import { contextBuilderAgent } from '../agents/contextBuilder.js';
import { helpers } from '../utils/helpers.js';

const router = express.Router();
const editSessions = new Map();

// Ignore messages older than 30 seconds to prevent replaying backlogs on restart.
const STALE_MESSAGE_SECONDS = 30;

const DIRECT_CALLBACKS = new Set([
    'send_all_pending',
    'dismiss_all_pending',
    'view_inbox',
    'handle_routine',
    'update_tone',
    'keep_tone',
    'show_help',
    'refresh_status',
]);

const MESSAGE_CALLBACK_PREFIXES = [
    'ai_reply',
    'send',
    'edit',
    'read',
    'trash',
    'undo',
    'reject',
    'ignore',
    'skip',
    'later',
];

const ID_CALLBACK_PREFIXES = [
    'followup',
    'dismiss_fw',
    'ai_draft',
    'cancel_draft',
];

function escape(value) {
    return telegramService.escapeMarkdown(value ?? '');
}

function parseCallbackData(data) {
    if (DIRECT_CALLBACKS.has(data)) {
        return { action: data };
    }

    for (const prefix of MESSAGE_CALLBACK_PREFIXES) {
        if (data.startsWith(`${prefix}_`)) {
            const rest = data.slice(prefix.length + 1);
            const [messageId, ...emailParts] = rest.split('_');
            return {
                action: prefix,
                messageId,
                userEmail: emailParts.join('_'),
            };
        }
    }

    for (const prefix of ID_CALLBACK_PREFIXES) {
        if (data.startsWith(`${prefix}_`)) {
            return {
                action: prefix,
                entityId: data.slice(prefix.length + 1),
            };
        }
    }

    return { action: data };
}

async function upsertDraftRecord(userId, messageId, userEmail, draftBody = null) {
    const detail = await gmailService.getMessage(userId, messageId, userEmail);
    const payload = {
        user_id: userId,
        user_email: userEmail || null,
        message_id: messageId,
        thread_id: detail.threadId,
        recipient: detail.replyTo || detail.from,
        subject: helpers.buildReplySubject(detail.subject),
        ai_draft: draftBody,
        confidence: null,
        autonomy_level: null,
    };

    const { data: existing } = await supabase
        .from('email_history')
        .select('id')
        .eq('user_id', userId)
        .eq('message_id', messageId)
        .maybeSingle();

    if (existing?.id) {
        await supabase.from('email_history')
            .update(payload)
            .eq('id', existing.id);
    } else {
        await supabase.from('email_history').insert(payload);
    }

    return payload;
}

async function processEditedDraft(userId, chatId, text, session) {
    const cleanedDraft = text.trim();
    if (!cleanedDraft) {
        await telegramService.sendMessage(chatId, 'The edited draft was empty, so nothing changed.');
        return;
    }

    const record = await upsertDraftRecord(userId, session.messageId, session.userEmail, cleanedDraft);

    await supabase.from('email_history')
        .update({
            ai_draft: cleanedDraft,
            was_edited: true,
        })
        .eq('user_id', userId)
        .eq('message_id', session.messageId);

    const preview =
        '*Draft Updated*\n' +
        `To: *${escape(record.recipient)}*\n` +
        `Subject: ${escape(record.subject)}\n\n` +
        `_${escape(cleanedDraft)}_`;

    await telegramService.sendWithButtons(chatId, preview, [[
        { text: '✅ Send', callback_data: `send_${session.messageId}_${session.userEmail || ''}` },
        { text: '✍️ Edit Again', callback_data: `edit_${session.messageId}_${session.userEmail || ''}` }
    ]]);
}

/**
 * Velox — Telegram Webhook Handler
 */
router.post(`/${env.telegramBotToken}`, async (req, res, next) => {
    try {
        const update = req.body;
        res.status(200).send('OK');

        handleUpdate(update).catch((err) => {
            logger.error('Telegram', 'UpdateHandler', 'Failed to process update', err);
        });
    } catch (err) {
        next(err);
    }
});

async function handleUpdate(update) {
    // ── Stale message guard ──────────────────────────────────
    const msgDate = update.message?.date || update.callback_query?.message?.date;
    if (msgDate) {
        const ageSeconds = Math.floor(Date.now() / 1000) - msgDate;
        if (ageSeconds > STALE_MESSAGE_SECONDS) {
            logger.debug('Telegram', 'Stale', `Skipping stale update (${ageSeconds}s old)`);
            return;
        }
    }

    if (update.message?.text) {
        const chatId = update.message.chat.id.toString();
        const text = update.message.text.trim();
        const normalized = text.toLowerCase();

        logger.debug('Telegram', 'Message', `From ${chatId}: ${text}`);

        const userId = await telegramCommands.resolveUser(chatId);

        if (!userId) {
            if (normalized === '/start' || normalized === 'start' || normalized === 'hi' || normalized === 'hello') {
                return telegramCommands.handleStart(chatId);
            }
            return telegramService.sendMessage(chatId, '👋 Please say "start" to register before using the assistant\.');
        }

        if (normalized === '/start' || normalized === 'start') {
            return telegramCommands.handleStart(chatId);
        }

        const pendingEdit = editSessions.get(chatId);
        if (pendingEdit) {
            if (normalized === '/cancel') {
                editSessions.delete(chatId);
                return telegramService.sendMessage(chatId, '❌ Edit cancelled\.');
            }

            editSessions.delete(chatId);
            return processEditedDraft(userId, chatId, text, pendingEdit);
        }

        const { data: user } = await supabase
            .from('users')
            .select('onboarding_status')
            .eq('id', userId)
            .single();

        if (user?.onboarding_status && user.onboarding_status !== 'done') {
            return memoryAgent.handleOnboardingMessage(userId, text);
        }

        return nlHandler.handle(userId, chatId, text);
    }

    if (update.message?.document || update.message?.photo) {
        const chatId = update.message.chat.id.toString();
        const userId = await telegramCommands.resolveUser(chatId);
        if (!userId) return telegramService.sendMessage(chatId, '👋 Please say "start" to register first\.');

        await telegramService.sendMessage(chatId, '📎 File received\. Analyzing and storing it now\.\.\.');

        try {
            const isDocument = Boolean(update.message.document);
            const fileId = isDocument
                ? update.message.document.file_id
                : update.message.photo[update.message.photo.length - 1].file_id;
            const fileName = isDocument
                ? update.message.document.file_name || `document_${Date.now()}`
                : `photo_${Date.now()}.jpg`;
            const mimeType = isDocument
                ? update.message.document.mime_type || 'application/octet-stream'
                : 'image/jpeg';

            const fileLink = await telegramService.getFileLink(fileId);
            const response = await fetch(fileLink);
            const arrayBuffer = await response.arrayBuffer();

            const fileObj = {
                name: fileName,
                mimeType,
                buffer: Buffer.from(arrayBuffer),
            };

            const result = await vaultAgent.processDocument(fileObj, 'Telegram', null, userId);

            if (!result) {
                await telegramService.sendMessage(chatId, 'ℹ️ The file was analyzed, but it didn\'t look like a document worth storing\.');
            }
        } catch (err) {
            logger.error('Telegram', 'FileDownload', 'Failed to process attachment', err);
            await telegramService.sendMessage(chatId, '⚠️ Attachment processing failed\. Please try again\.');
        }
        return;
    }

    if (update.callback_query) {
        const queryId = update.callback_query.id;
        const chatId = update.callback_query.message.chat.id.toString();
        const data = update.callback_query.data;
        const telegramMessageId = update.callback_query.message.message_id;

        const userId = await telegramCommands.resolveUser(chatId);
        if (!userId) {
            return telegramService.answerCallbackQuery(queryId, 'Please say /start first.');
        }

        const callback = parseCallbackData(data);
        logger.debug('Telegram', 'Callback', `Action: ${callback.action} Msg: ${callback.messageId || callback.entityId || 'n/a'} Email: ${callback.userEmail || ''}`);

        await handleCallbackQuery(queryId, chatId, telegramMessageId, callback, userId);
    }
}

async function handleCallbackQuery(queryId, chatId, telegramMsgId, callback, userId) {
    try {
        switch (callback.action) {
            case 'send': {
                await telegramService.answerCallbackQuery(queryId, 'Sending...');
                const { data: history } = await supabase
                    .from('email_history')
                    .select('*')
                    .eq('user_id', userId)
                    .eq('message_id', callback.messageId)
                    .maybeSingle();

                if (!history?.ai_draft) {
                    await telegramService.sendMessage(chatId, '⚠️ No draft is stored for that email yet\.');
                    return;
                }

                await sendAgent.sendEmail(userId, {
                    email_to: history.recipient,
                    subject: history.subject,
                    body: history.ai_draft,
                    thread_id: history.thread_id,
                }, 0, callback.userEmail || history.user_email);

                await telegramService.editMessage(chatId, telegramMsgId, `✅ *Email Sent*\nTo: ${escape(history.recipient)}`);
                break;
            }

            case 'read':
                await telegramService.answerCallbackQuery(queryId, 'Marked as read');
                await gmailService.markAsRead(userId, callback.messageId, callback.userEmail);
                await telegramService.editMessage(chatId, telegramMsgId, '✅ Email marked as read in Gmail\.');
                break;

            case 'trash':
                await telegramService.answerCallbackQuery(queryId, 'Moved to trash');
                await gmailService.trashMessage(userId, callback.messageId, callback.userEmail);
                await telegramService.editMessage(chatId, telegramMsgId, '🗑 Email moved to trash\.');
                break;

            case 'ai_reply': {
                await telegramService.answerCallbackQuery(queryId, 'Drafting reply…');
                const detail = await gmailService.getMessage(userId, callback.messageId, callback.userEmail);
                const emailData = {
                    messageId: detail.id,
                    threadId: detail.threadId,
                    subject: detail.subject,
                    from: detail.from,
                    fromName: detail.fromName,
                    snippet: detail.snippet,
                    body: detail.body,
                    timestamp: detail.timestamp,
                    hasAttachment: detail.hasAttachment,
                };

                const context = await contextBuilderAgent.buildContext(userId, emailData, callback.userEmail);
                const aiResult = await aiBrainAgent.process(userId, context);
                const draftBody = aiResult.draft_reply || aiResult.holding_reply;

                if (!draftBody) {
                    await telegramService.sendMessage(chatId, '⚠️ I could not produce a safe draft for that email\. Please review it manually\.');
                    return;
                }

                const record = await upsertDraftRecord(userId, callback.messageId, callback.userEmail, draftBody);
                await supabase.from('email_history')
                    .update({
                        ai_draft: draftBody,
                        confidence: aiResult.confidence,
                        autonomy_level: aiResult.autonomy_level,
                    })
                    .eq('user_id', userId)
                    .eq('message_id', callback.messageId);

                const confPct = aiResult.confidence || 0;
                const confEmoji = confPct >= 80 ? '🟢' : confPct >= 50 ? '🟡' : '🔴';
                const preview =
                    '📝 *Draft Ready*\n\n' +
                    `*To:* ${escape(record.recipient)}\n` +
                    `*Subject:* ${escape(record.subject)}\n\n` +
                    `_${escape(draftBody)}_\n\n` +
                    `${confEmoji} Confidence: *${escape(String(confPct))}%*`;

                await telegramService.sendWithButtons(chatId, preview, [[
                    { text: '✅ Send', callback_data: `send_${callback.messageId}_${callback.userEmail || ''}` },
                    { text: '✍️ Edit', callback_data: `edit_${callback.messageId}_${callback.userEmail || ''}` }
                ]]);
                break;
            }

            case 'edit': {
                await telegramService.answerCallbackQuery(queryId, 'Reply with your revised draft');
                await upsertDraftRecord(userId, callback.messageId, callback.userEmail, null);
                editSessions.set(chatId, {
                    messageId: callback.messageId,
                    userEmail: callback.userEmail || '',
                    createdAt: Date.now(),
                });
                await telegramService.sendMessage(chatId, '✍️ Send your revised email text as the next message.\n\nSend /cancel to stop editing.');
                break;
            }

            case 'undo': {
                await telegramService.answerCallbackQuery(queryId, 'Trying to undo…');
                const result = await sendAgent.undoSend(userId, callback.messageId, callback.userEmail);
                if (result.success) {
                    await telegramService.editMessage(chatId, telegramMsgId, '↩️ *Email Recalled*\n_Moved to trash within Gmail\'s undo window\._');
                } else {
                    await telegramService.sendMessage(chatId, `❌ Undo failed: ${escape(result.message)}`);
                }
                break;
            }

            case 'reject':
                await telegramService.answerCallbackQuery(queryId, 'Draft dismissed');
                await telegramService.editMessage(chatId, telegramMsgId, '🚫 *Draft Dismissed*\n_No email was sent\._');
                break;

            case 'ignore':
            case 'skip':
            case 'later':
                await telegramService.answerCallbackQuery(queryId, 'Acknowledged');
                await telegramService.editMessage(chatId, telegramMsgId, `✅ *${escape(callback.action.charAt(0).toUpperCase() + callback.action.slice(1))}*\n_No email was sent\._`);
                break;

            case 'view_inbox':
                await telegramService.answerCallbackQuery(queryId, 'Refreshing inbox…');
                await telegramCommands.handleInbox(chatId, userId);
                break;

            case 'handle_routine':
                await telegramService.answerCallbackQuery(queryId, 'Refreshing drafts…');
                await telegramCommands.handlePending(chatId, userId);
                break;

            case 'send_all_pending': {
                await telegramService.answerCallbackQuery(queryId, 'Sending queued drafts...');
                const { data: drafts } = await supabase
                    .from('pending_sends')
                    .select('*')
                    .eq('user_id', userId)
                    .eq('status', 'pending')
                    .order('created_at', { ascending: true });

                if (!drafts || drafts.length === 0) {
                    await telegramService.sendMessage(chatId, '✅ There are no pending drafts to send\.');
                    return;
                }

                let sentCount = 0;
                for (const draft of drafts) {
                    try {
                        await sendAgent.sendEmail(userId, draft, 0, draft.user_email);
                        await supabase.from('pending_sends')
                            .update({ status: 'sent' })
                            .eq('id', draft.id);
                        sentCount++;
                    } catch (err) {
                        logger.error('Telegram', 'SendAllPending', `Failed to send pending draft ${draft.id}`, err);
                    }
                }

                await telegramService.sendMessage(chatId, `✅ Sent *${sentCount}* pending draft\(s\)\.`);
                break;
            }

            case 'dismiss_all_pending':
                await telegramService.answerCallbackQuery(queryId, 'Not supported');
                await telegramService.sendMessage(chatId, '⚠️ Bulk dismiss is not enabled\. Use /pending to review drafts individually\.');
                break;

            case 'update_tone':
                await telegramService.answerCallbackQuery(queryId, 'Tone review noted');
                await telegramCommands.handleTone(chatId, '', userId);
                break;

            case 'show_help':
                await telegramService.answerCallbackQuery(queryId, 'Loading commands…');
                await telegramCommands.handleHelp(chatId);
                break;

            case 'refresh_status':
                await telegramService.answerCallbackQuery(queryId, 'Refreshing…');
                await telegramCommands.handleStatus(chatId);
                break;

            case 'keep_tone':
                await telegramService.answerCallbackQuery(queryId, 'Keeping current tone');
                await telegramService.sendMessage(chatId, '🎨 Kept the current tone guidance\.');
                break;

            case 'ai_draft':
            case 'cancel_draft':
            case 'followup':
            case 'dismiss_fw':
                await telegramService.answerCallbackQuery(queryId, 'Not implemented');
                await telegramService.sendMessage(chatId, 'ℹ️ That workflow is not fully configured yet\. No action was taken\.');
                break;

            default:
                // Handle set_tone_* callbacks dynamically
                if (callback.action.startsWith('set_tone_')) {
                    const tone = callback.action.replace('set_tone_', '');
                    await telegramService.answerCallbackQuery(queryId, `Setting tone: ${tone}`);
                    await telegramCommands.handleTone(chatId, tone, userId);
                    break;
                }
                await telegramService.answerCallbackQuery(queryId);
        }
    } catch (err) {
        logger.error('Telegram', 'CallbackHandler', `Failed for ${callback.action}`, err);
        await telegramService.answerCallbackQuery(queryId, 'Action failed.');
    }
}

export { handleUpdate };
export default router;
