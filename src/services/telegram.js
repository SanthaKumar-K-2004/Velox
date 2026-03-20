import TelegramBot from 'node-telegram-bot-api';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Velox — Telegram Bot Service
 * Wrapper around node-telegram-bot-api for sending messages,
 * inline keyboards, and handling callback queries.
 */

let bot = null;

function getBot() {
    if (!bot) {
        bot = new TelegramBot(env.telegramBotToken);
    }
    return bot;
}

export const telegramService = {

    /**
     * Send a plain text message (Markdown V2 supported)
     */
    async sendMessage(chatId, text, options = {}) {
        try {
            const result = await getBot().sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                ...options,
            });
            logger.debug('Telegram', 'SendMessage', `Sent to ${chatId}`);
            return result;
        } catch (err) {
            logger.error('Telegram', 'SendMessage', `Failed to send to ${chatId}`, err);
            throw err;
        }
    },

    /**
     * Send a message with inline keyboard buttons
     * @param {string} chatId
     * @param {string} text - Message text (Markdown)
     * @param {Array<Array<{text: string, callback_data: string}>>} buttons - rows of buttons
     */
    async sendWithButtons(chatId, text, buttons) {
        try {
            const result = await getBot().sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: buttons,
                },
            });
            logger.debug('Telegram', 'SendWithButtons', `Sent to ${chatId}`);
            return result;
        } catch (err) {
            logger.error('Telegram', 'SendWithButtons', `Failed to send to ${chatId}`, err);
            throw err;
        }
    },

    /**
     * Answer a callback query (acknowledge button press)
     */
    async answerCallbackQuery(queryId, text = '') {
        try {
            await getBot().answerCallbackQuery(queryId, { text });
        } catch (err) {
            logger.error('Telegram', 'AnswerCallback', `Failed for query ${queryId}`, err);
        }
    },

    /**
     * Edit an existing message's text
     */
    async editMessage(chatId, messageId, text, buttons = null) {
        try {
            const options = {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
            };
            if (buttons) {
                options.reply_markup = { inline_keyboard: buttons };
            }
            await getBot().editMessageText(text, options);
        } catch (err) {
            logger.error('Telegram', 'EditMessage', `Failed to edit ${messageId}`, err);
        }
    },

    /**
     * Set the webhook URL for Telegram updates
     */
    async setWebhook(url) {
        try {
            const webhookUrl = `${url}/webhook/telegram/${env.telegramBotToken}`;
            await getBot().setWebHook(webhookUrl);
            logger.info('Telegram', 'Webhook', `Webhook set: ${webhookUrl}`);
        } catch (err) {
            logger.error('Telegram', 'Webhook', 'Failed to set webhook', err);
        }
    },

    /**
     * Process an incoming update from Telegram webhook
     */
    processUpdate(update) {
        getBot().processUpdate(update);
    },

    /**
     * Get the underlying bot instance (for registering handlers)
     */
    getBot() {
        return getBot();
    },

    /**
     * Get a direct download link for a Telegram file ID
     */
    async getFileLink(fileId) {
        try {
            return await getBot().getFileLink(fileId);
        } catch (err) {
            logger.error('Telegram', 'GetFileLink', `Failed to get link for ${fileId}`, err);
            throw err;
        }
    }
};
