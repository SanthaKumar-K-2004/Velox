import { telegramService } from '../services/telegram.js';
import { logger } from '../utils/logger.js';
import { CONSTANTS } from '../config/constants.js';

/**
 * Agent 7 - Notification Agent
 * Telegram interface. Beautiful, clean, consistent.
 * Rate limited. Timezone aware. Never floods.
 */

const lastSentMap = new Map();

function canSend(chatId) {
    const lastSent = lastSentMap.get(chatId) || 0;
    if (Date.now() - lastSent < 1000) {
        return false;
    }

    lastSentMap.set(chatId, Date.now());
    return true;
}

async function waitForRateLimit(chatId) {
    while (!canSend(chatId)) {
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}

function escape(value) {
    return telegramService.escapeMarkdown(value ?? '');
}

function truncate(value, max = 260) {
    const text = String(value ?? '').trim();
    if (text.length <= max) {
        return text;
    }

    return `${text.slice(0, max - 1).trim()}…`;
}

function getAccountLabel(email) {
    return email.userEmail ? `[${escape(email.userEmail)}] ` : '';
}

function formatDraftPreview(result) {
    const draft = result.draft_reply || result.holding_reply;
    if (!draft) {
        return '_Manual review required. No safe draft was generated._';
    }

    return `_${escape(truncate(draft, 700))}_`;
}

function formatSummary(result, fallback) {
    return escape(truncate(result.summary || fallback, 240));
}

function formatSubject(email) {
    return escape(email.subject || 'No subject');
}

function formatSender(email) {
    return escape(email.fromName || email.from || 'Unknown sender');
}

export const notificationAgent = {

    /**
     * Notify user about an email that needs AI-level attention.
     * Formats based on autonomy level.
     */
    async notifyEmailResult(chatId, aiResult, emailData, autonomyDecision) {
        await waitForRateLimit(chatId);

        const level = autonomyDecision.autonomy_level;

        switch (level) {
        case CONSTANTS.AUTONOMY_LEVELS.ALWAYS_HUMAN:
            return this.sendLevel3(chatId, aiResult, emailData, autonomyDecision);
        case CONSTANTS.AUTONOMY_LEVELS.DRAFT_READY:
            return this.sendLevel1(chatId, aiResult, emailData);
        case CONSTANTS.AUTONOMY_LEVELS.WHITELISTED:
            return this.sendLevel2Confirmation(chatId, aiResult, emailData, autonomyDecision);
        default:
            return this.sendLevel1(chatId, aiResult, emailData);
        }
    },

    /**
     * Level 3 - urgent, needs user attention.
     */
    async sendLevel3(chatId, result, email, decision) {
        const messageId = email.messageId || 'unknown';
        const userEmail = email.userEmail || '';
        const text =
            `*Urgent Review* ${getAccountLabel(email)}\n` +
            `From: *${formatSender(email)}*\n` +
            `Subject: ${formatSubject(email)}\n\n` +
            `*AI Analysis*\n${formatSummary(result, 'Manual review required')}\n\n` +
            `*Draft Reply*\n${formatDraftPreview(result)}\n\n` +
            `Confidence: ${result.confidence || 0}% | ${escape(result.intent || 'unknown')}\n` +
            `Reason: ${escape(decision.autonomy_reason || 'Manual approval requested')}`;

        const buttons = [
            [
                { text: '✅ Send Draft', callback_data: `send_${messageId}_${userEmail}` },
                { text: '✍️ Edit', callback_data: `edit_${messageId}_${userEmail}` }
            ],
            [
                { text: '📖 Mark Read', callback_data: `read_${messageId}_${userEmail}` },
                { text: '🗑️ Delete', callback_data: `trash_${messageId}_${userEmail}` },
                { text: '❌ Reject', callback_data: `reject_${messageId}_${userEmail}` }
            ]
        ];

        const msg = await telegramService.sendWithButtons(chatId, text, buttons);
        logger.info('Notification', 'Level3', `Urgent notification sent for ${messageId}`);
        return msg;
    },

    /**
     * Level 1 - draft ready, tap to send.
     */
    async sendLevel1(chatId, result, email) {
        const messageId = email.messageId || 'unknown';
        const userEmail = email.userEmail || '';
        const text =
            `*New Email* ${getAccountLabel(email)}\n` +
            `From: *${formatSender(email)}*\n` +
            `Subject: ${formatSubject(email)}\n\n` +
            `*Summary*\n${formatSummary(result, 'New email received')}\n\n` +
            `*Draft*\n${formatDraftPreview(result)}\n\n` +
            `Confidence: ${result.confidence || 0}% | ${escape(result.intent || 'unknown')}`;

        const buttons = [
            [
                { text: '✅ Send', callback_data: `send_${messageId}_${userEmail}` },
                { text: '✍️ Edit', callback_data: `edit_${messageId}_${userEmail}` }
            ],
            [
                { text: '📖 Mark Read', callback_data: `read_${messageId}_${userEmail}` },
                { text: '🗑️ Delete', callback_data: `trash_${messageId}_${userEmail}` }
            ],
            [
                { text: '⏳ Later', callback_data: `later_${messageId}_${userEmail}` },
                { text: '⏭️ Skip', callback_data: `skip_${messageId}_${userEmail}` }
            ]
        ];

        const msg = await telegramService.sendWithButtons(chatId, text, buttons);
        logger.info('Notification', 'Level1', `Draft notification sent for ${messageId}`);
        return msg;
    },

    /**
     * Level 2 - queued for auto-send with delay.
     */
    async sendLevel2Confirmation(chatId, result, email, decision) {
        const delayMins = decision.delay_mins || 3;
        const text =
            `*Auto-Send Scheduled* ${getAccountLabel(email)}\n` +
            `To: *${formatSender(email)}*\n` +
            `Subject: ${formatSubject(email)}\n\n` +
            `${formatDraftPreview(result)}\n\n` +
            `Queued to send in ${delayMins} minute(s) if nothing changes.`;

        const msg = await telegramService.sendMessage(chatId, text);
        logger.info('Notification', 'Level2', `Queued auto-send notification for ${email.messageId || 'unknown'}`);
        return msg;
    },

    /**
     * Bucket A - always notify (payments, OTPs, security alerts, etc.).
     */
    async notifyBucketA(chatId, email, signals) {
        await waitForRateLimit(chatId);
        const messageId = email.messageId || 'unknown';
        const userEmail = email.userEmail || '';
        const snippet = escape(truncate(email.snippet || 'No preview available', 260));
        const tags = signals.map((signal) => `\`#${escape(signal)}\``).join(' ');

        const text =
            `*Attention Required* ${getAccountLabel(email)}\n` +
            `From: *${formatSender(email)}*\n` +
            `Subject: ${formatSubject(email)}\n\n` +
            `${snippet}\n\n` +
            (tags ? `Tags: ${tags}` : '');

        const buttons = [
            [
                { text: '🤖 Smart Reply', callback_data: `ai_reply_${messageId}_${userEmail}` },
                { text: '📖 Mark Read', callback_data: `read_${messageId}_${userEmail}` }
            ],
            [
                { text: '🗑️ Delete', callback_data: `trash_${messageId}_${userEmail}` },
                { text: '📞 Open Thread', url: `https://mail.google.com/mail/u/${userEmail}/#inbox/${email.threadId || ''}` }
            ]
        ];

        const msg = await telegramService.sendWithButtons(chatId, text, buttons);
        logger.info('Notification', 'BucketA', `Alert sent for ${email.messageId}`);
        return msg;
    },

    /**
     * System alert (errors, API limits, etc.).
     */
    async sendSystemAlert(chatId, title, message) {
        await waitForRateLimit(chatId);

        const text = `*${escape(title)}*\n\n${escape(message)}`;
        return telegramService.sendMessage(chatId, text);
    },
};
