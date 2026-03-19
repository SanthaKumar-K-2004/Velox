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

function getAccountLabel(email) {
    return email.userEmail ? `[${email.userEmail}] ` : '';
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
            return this.sendLevel2Confirmation(chatId, aiResult, emailData);
        default:
            return this.sendLevel1(chatId, aiResult, emailData);
        }
    },

    /**
     * Level 3 - urgent, needs user attention.
     */
    async sendLevel3(chatId, result, email, decision) {
        const messageId = email.messageId || 'unknown';
        const text =
            `${getAccountLabel(email)}URGENT\n\n` +
            `From: ${email.fromName || email.from}\n` +
            `Subject: ${email.subject}\n\n` +
            'What they need\n' +
            `${result.summary || 'Review required'}\n\n` +
            'My draft reply\n' +
            `_${result.draft_reply || 'No draft generated'}_\n\n` +
            `Confidence: ${result.confidence || 0}% | ${result.intent || 'unknown'}\n` +
            `${decision.autonomy_reason || 'Requires your approval'}`;

        const buttons = [[
            { text: 'Send', callback_data: `send_${messageId}` },
            { text: 'Edit', callback_data: `edit_${messageId}` },
            { text: 'Reject', callback_data: `reject_${messageId}` },
        ]];

        const msg = await telegramService.sendWithButtons(chatId, text, buttons);
        logger.info('Notification', 'Level3', `Urgent notification sent for ${messageId}`);
        return msg;
    },

    /**
     * Level 1 - draft ready, tap to send.
     */
    async sendLevel1(chatId, result, email) {
        const messageId = email.messageId || 'unknown';
        const text =
            `${getAccountLabel(email)}Email from ${email.fromName || email.from}\n` +
            `_${email.subject}_\n\n` +
            `${result.summary || 'New email received'}\n\n` +
            `_${result.draft_reply || 'No draft generated'}_\n\n` +
            `Confidence: ${result.confidence || 0}% | ${result.intent || 'unknown'}`;

        const buttons = [
            [
                { text: 'Send', callback_data: `send_${messageId}` },
                { text: 'Edit', callback_data: `edit_${messageId}` },
            ],
            [
                { text: 'Later', callback_data: `later_${messageId}` },
                { text: 'Skip', callback_data: `skip_${messageId}` },
            ],
        ];

        const msg = await telegramService.sendWithButtons(chatId, text, buttons);
        logger.info('Notification', 'Level1', `Draft notification sent for ${messageId}`);
        return msg;
    },

    /**
     * Level 2 - whitelisted auto-send confirmation.
     */
    async sendLevel2Confirmation(chatId, result, email) {
        const messageId = email.messageId || 'unknown';
        const text =
            `${getAccountLabel(email)}Sent - ${email.fromName || email.from}\n\n` +
            `_${(result.draft_reply || '').substring(0, 100)}..._\n\n` +
            'Sent just now';

        const buttons = [[
            { text: 'Undo (15m left)', callback_data: `undo_${messageId}` },
        ]];

        const msg = await telegramService.sendWithButtons(chatId, text, buttons);
        logger.info('Notification', 'Level2', `Auto-sent confirmation for ${messageId}`);
        return msg;
    },

    /**
     * Bucket A - always notify (payments, OTPs, security alerts, etc.).
     */
    async notifyBucketA(chatId, email, signals) {
        await waitForRateLimit(chatId);

        const text =
            `${getAccountLabel(email)}Important Email Detected\n\n` +
            `From: ${email.fromName || email.from}\n` +
            `Subject: ${email.subject}\n\n` +
            `${email.snippet || 'No preview available'}\n\n` +
            `Signals: ${signals.join(', ')}`;

        const msg = await telegramService.sendMessage(chatId, text);
        logger.info('Notification', 'BucketA', `Alert sent for ${email.messageId}`);
        return msg;
    },

    /**
     * System alert (errors, API limits, etc.).
     */
    async sendSystemAlert(chatId, title, message) {
        await waitForRateLimit(chatId);

        const text = `${title}\n\n${message}`;
        return telegramService.sendMessage(chatId, text);
    },
};
