import { google } from 'googleapis';
import { env } from '../config/env.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

/**
 * Gmail Service
 * Wrapper around Google Gmail API
 */

function normalizeAccountEmail(email) {
    return typeof email === 'string' ? email.trim().toLowerCase() : null;
}

/**
 * Helper: Retry with exponential backoff
 */
async function withRetry(fn, retries = 3, delayMs = 2000) {
    try {
        return await fn();
    } catch (err) {
        if (retries <= 1) throw err;
        logger.warn('Gmail', 'Retry', `API call failed, retrying in ${delayMs}ms. Err: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return withRetry(fn, retries - 1, delayMs * 2);
    }
}

export const gmailService = {

    /**
     * Resolves the Gmail account row to use for a request.
     * If the user has multiple accounts connected, userEmail becomes required.
     */
    async getAccount(userId, userEmail) {
        const normalizedEmail = normalizeAccountEmail(userEmail);
        let query = supabase
            .from('user_accounts')
            .select('email, gmail_token, updated_at')
            .eq('user_id', userId);

        if (normalizedEmail) {
            const { data: account, error } = await query
                .eq('email', normalizedEmail)
                .maybeSingle();

            if (error) {
                throw error;
            }

            if (!account?.gmail_token) {
                throw new Error(`Gmail tokens not found for user ${userId} and email ${normalizedEmail}`);
            }

            return account;
        }

        const { data: accounts, error } = await query
            .order('updated_at', { ascending: false })
            .limit(2);

        if (error) {
            throw error;
        }

        if (!accounts || accounts.length === 0) {
            throw new Error(`No Gmail accounts connected for user ${userId}`);
        }

        if (accounts.length > 1) {
            throw new Error(`Multiple Gmail accounts connected for user ${userId}; userEmail is required`);
        }

        return accounts[0];
    },

    /**
     * Initializes an OAuth client for a specific user and Gmail account.
     */
    async getAuthClient(userId, userEmail) {
        const account = await this.getAccount(userId, userEmail);
        const oauth2Client = new google.auth.OAuth2(
            env.googleClientId,
            env.googleClientSecret,
            env.googleRedirectUri
        );

        oauth2Client.setCredentials(account.gmail_token);

        oauth2Client.on('tokens', async (tokens) => {
            if (!tokens || Object.keys(tokens).length === 0) {
                return;
            }

            const mergedTokens = {
                ...account.gmail_token,
                ...tokens,
            };

            const { error } = await supabase
                .from('user_accounts')
                .update({
                    gmail_token: mergedTokens,
                    updated_at: new Date().toISOString(),
                })
                .eq('user_id', userId)
                .eq('email', account.email);

            if (error) {
                logger.error('GmailService', 'TokenRefresh', `Failed to persist refreshed token for ${account.email}`, error);
                return;
            }

            account.gmail_token = mergedTokens;
        });

        return oauth2Client;
    },

    /**
     * Initializes a Gmail client for a specific user and email account.
     */
    async getClient(userId, userEmail) {
        const auth = await this.getAuthClient(userId, userEmail);
        return google.gmail({ version: 'v1', auth });
    },

    /**
     * Fetches the full content of an email.
     */
    async getEmail(userId, messageId, userEmail) {
        try {
            const gmail = await this.getClient(userId, userEmail);
            const res = await withRetry(() => gmail.users.messages.get({
                userId: 'me',
                id: messageId,
                format: 'full',
            }));
            return res.data;
        } catch (err) {
            logger.error('GmailService', 'GetEmail', `Failed to fetch email ${messageId}`, err);
            throw err;
        }
    },

    /**
     * Fetches the last 5 messages in a thread for context.
     */
    async getThreadHistory(userId, threadId, userEmail) {
        try {
            const gmail = await this.getClient(userId, userEmail);
            const res = await withRetry(() => gmail.users.threads.get({
                userId: 'me',
                id: threadId,
                format: 'metadata',
            }));

            return (res.data.messages || [])
                .slice(-5)
                .map((msg) => ({
                    from: msg.payload.headers.find((header) => header.name === 'From')?.value,
                    date: msg.payload.headers.find((header) => header.name === 'Date')?.value,
                    snippet: msg.snippet,
                }));
        } catch (err) {
            logger.error('GmailService', 'GetThreadHistory', `Failed to fetch thread ${threadId}`, err);
            return [];
        }
    },

    /**
     * Sends an email via the Gmail API.
     * @param {string} userId
     * @param {Object} draft { to, subject, body, threadId, attachments }
     */
    async sendEmail(userId, draft, userEmail) {
        try {
            const gmail = await this.getClient(userId, userEmail);

            const messageParts = [
                `To: ${draft.to}`,
                `Subject: ${draft.subject}`,
                'Content-Type: text/html; charset=utf-8',
                'MIME-Version: 1.0',
                '',
            ];

            if (draft.threadId) {
                messageParts.push(`In-Reply-To: ${draft.threadId}`);
                messageParts.push(`References: ${draft.threadId}`);
            }

            messageParts.push(draft.body);

            const raw = Buffer.from(messageParts.join('\n'))
                .toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');

            const res = await withRetry(() => gmail.users.messages.send({
                userId: 'me',
                requestBody: {
                    raw,
                    threadId: draft.threadId || undefined,
                },
            }));

            logger.info('GmailService', 'Sent', `Email sent successfully (ID: ${res.data.id})`);
            return res.data;
        } catch (err) {
            logger.error('GmailService', 'SendEmail', 'Failed to send email via API', err);
            throw err;
        }
    },

    /**
     * Moves a message to trash (Undo Send).
     */
    async trashMessage(userId, messageId, userEmail) {
        try {
            const gmail = await this.getClient(userId, userEmail);
            await withRetry(() => gmail.users.messages.trash({
                userId: 'me',
                id: messageId,
            }));
            logger.info('GmailService', 'Trash', `Trashed message ${messageId}`);
            return true;
        } catch (err) {
            logger.error('GmailService', 'TrashMessage', `Failed to trash message ${messageId}`, err);
            throw err;
        }
    },

    /**
     * List messages matching a Gmail search query.
     * @param {string} userId
     * @param {string} query
     * @param {number} maxResults
     * @returns {Array<{id: string, threadId: string}>}
     */
    async listMessages(userId, query, maxResults = 10, userEmail) {
        try {
            const gmail = await this.getClient(userId, userEmail);
            const res = await withRetry(() => gmail.users.messages.list({
                userId: 'me',
                q: query,
                maxResults,
            }));
            return res.data.messages || [];
        } catch (err) {
            logger.error('GmailService', 'ListMessages', `Failed to list messages for query: ${query}`, err);
            return [];
        }
    },

    /**
     * Fetch a single message with parsed headers and body.
     * @param {string} userId
     * @param {string} messageId
     * @returns {Object}
     */
    async getMessage(userId, messageId, userEmail) {
        try {
            const gmail = await this.getClient(userId, userEmail);
            const res = await withRetry(() => gmail.users.messages.get({
                userId: 'me',
                id: messageId,
                format: 'full',
            }));

            const msg = res.data;
            const headers = msg.payload?.headers || [];
            const getHeader = (name) => headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value || '';

            const fromRaw = getHeader('From');
            const nameMatch = fromRaw.match(/^(.+?)\s*<(.+?)>$/);
            const fromName = nameMatch ? nameMatch[1].replace(/"/g, '').trim() : '';
            const fromEmail = nameMatch ? nameMatch[2] : fromRaw;

            let body = '';
            if (msg.payload?.body?.data) {
                body = Buffer.from(msg.payload.body.data, 'base64').toString('utf-8');
            } else if (msg.payload?.parts) {
                const textPart = msg.payload.parts.find((part) => part.mimeType === 'text/plain');
                if (textPart?.body?.data) {
                    body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
                }
            }

            return {
                id: msg.id,
                threadId: msg.threadId,
                from: fromEmail,
                fromName,
                to: getHeader('To'),
                subject: getHeader('Subject'),
                snippet: msg.snippet || '',
                body,
                labelIds: msg.labelIds || [],
            };
        } catch (err) {
            logger.error('GmailService', 'GetMessage', `Failed to get message ${messageId}`, err);
            throw err;
        }
    },

    /**
     * Modify labels on a message (add/remove).
     */
    async modifyLabels(userId, messageId, addLabels = [], removeLabels = [], userEmail) {
        try {
            const gmail = await this.getClient(userId, userEmail);
            await withRetry(() => gmail.users.messages.modify({
                userId: 'me',
                id: messageId,
                requestBody: {
                    addLabelIds: addLabels,
                    removeLabelIds: removeLabels,
                },
            }));
            logger.info('GmailService', 'ModifyLabels', `Modified labels on ${messageId}: +[${addLabels}] -[${removeLabels}]`);
            return true;
        } catch (err) {
            logger.error('GmailService', 'ModifyLabels', `Failed to modify labels on ${messageId}`, err);
            throw err;
        }
    },

    /**
     * Fetch recent sent emails for memory bootstrapping / tone drift analysis.
     * @param {string} userId
     * @param {number} count
     * @returns {Array<{to, subject, snippet, body}>}
     */
    async getRecentSentEmails(userId, count = 50, userEmail) {
        try {
            const gmail = await this.getClient(userId, userEmail);
            const res = await withRetry(() => gmail.users.messages.list({
                userId: 'me',
                labelIds: ['SENT'],
                maxResults: count,
            }));

            const messages = res.data.messages || [];
            if (messages.length === 0) {
                return [];
            }

            const emails = [];
            for (const msg of messages) {
                try {
                    const detail = await this.getMessage(userId, msg.id, userEmail);
                    emails.push({
                        to: detail.to || detail.from,
                        subject: detail.subject,
                        snippet: detail.snippet,
                        body: detail.body,
                    });
                } catch {
                    continue;
                }
            }

            return emails;
        } catch (err) {
            logger.error('GmailService', 'GetRecentSent', 'Failed to fetch recent sent emails', err);
            return [];
        }
    },
};
