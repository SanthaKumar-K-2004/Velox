import { randomUUID } from 'node:crypto';
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

function sanitizeHeader(value) {
    return String(value ?? '').replace(/\r?\n/g, ' ').trim();
}

function sanitizeFilename(value) {
    return sanitizeHeader(value).replace(/"/g, '\'') || 'attachment';
}

function encodeBase64Url(value) {
    return Buffer.from(value)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function decodeBase64Url(value) {
    if (!value) return '';

    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));

    return Buffer.from(normalized + padding, 'base64').toString('utf-8');
}

function wrapBase64(value) {
    return value.match(/.{1,76}/g)?.join('\r\n') || value;
}

function getHeader(headers, name) {
    return headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

function extractEmailAddress(value) {
    if (!value) return '';

    const match = value.match(/<([^>]+)>/);
    return (match ? match[1] : value).replace(/^mailto:/i, '').trim().toLowerCase();
}

function extractDisplayName(value) {
    if (!value) return '';

    const match = value.match(/^(.+?)\s*<.+>$/);
    if (!match) return '';

    return match[1].replace(/"/g, '').trim();
}

function decodeHtmlEntities(value) {
    return value
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, '\'');
}

function stripHtml(value) {
    if (!value) return '';

    return decodeHtmlEntities(
        value
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
    )
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function collectBodyParts(part, bucket) {
    if (!part) return;

    if (Array.isArray(part.parts) && part.parts.length > 0) {
        part.parts.forEach((child) => collectBodyParts(child, bucket));
    }

    const mimeType = (part.mimeType || '').toLowerCase();
    const data = part.body?.data;

    if (!data) {
        return;
    }

    const decoded = decodeBase64Url(data);

    if (mimeType === 'text/plain') {
        bucket.plain.push(decoded.trim());
    } else if (mimeType === 'text/html') {
        bucket.html.push(stripHtml(decoded));
    }
}

function extractBody(payload) {
    if (!payload) return '';

    const bucket = { plain: [], html: [] };
    collectBodyParts(payload, bucket);

    const plain = bucket.plain.filter(Boolean).join('\n\n').trim();
    if (plain) return plain;

    const html = bucket.html.filter(Boolean).join('\n\n').trim();
    if (html) return html;

    if (payload.body?.data) {
        return stripHtml(decodeBase64Url(payload.body.data));
    }

    return '';
}

function hasAttachment(payload) {
    if (!payload) return false;

    if (payload.filename && payload.body?.attachmentId) {
        return true;
    }

    if (!Array.isArray(payload.parts)) {
        return false;
    }

    return payload.parts.some((part) => hasAttachment(part));
}

function buildRawMessage(draft) {
    const attachments = Array.isArray(draft.attachments)
        ? draft.attachments.filter((attachment) => attachment?.content)
        : [];

    const headers = [
        `To: ${sanitizeHeader(draft.to)}`,
        `Subject: ${sanitizeHeader(draft.subject)}`,
        'MIME-Version: 1.0',
    ];

    if (draft.inReplyTo) {
        headers.push(`In-Reply-To: ${sanitizeHeader(draft.inReplyTo)}`);
    }

    if (draft.references) {
        headers.push(`References: ${sanitizeHeader(draft.references)}`);
    }

    if (attachments.length === 0) {
        headers.push('Content-Type: text/html; charset="UTF-8"');
        return `${headers.join('\r\n')}\r\n\r\n${draft.body || ''}`;
    }

    const boundary = `velox_${randomUUID()}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

    const parts = [
        `--${boundary}`,
        'Content-Type: text/html; charset="UTF-8"',
        'Content-Transfer-Encoding: 7bit',
        '',
        draft.body || '',
    ];

    for (const attachment of attachments) {
        const contentBuffer = Buffer.isBuffer(attachment.content)
            ? attachment.content
            : Buffer.from(attachment.content);
        const base64 = wrapBase64(contentBuffer.toString('base64'));
        const filename = sanitizeFilename(attachment.filename);

        parts.push(
            '',
            `--${boundary}`,
            `Content-Type: ${sanitizeHeader(attachment.contentType || 'application/octet-stream')}; name="${filename}"`,
            `Content-Disposition: attachment; filename="${filename}"`,
            'Content-Transfer-Encoding: base64',
            '',
            base64
        );
    }

    parts.push('', `--${boundary}--`);
    return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
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
        const query = supabase
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
                metadataHeaders: ['From', 'Date', 'Subject'],
            }));

            return (res.data.messages || [])
                .slice(-5)
                .map((msg) => {
                    const headers = msg.payload?.headers || [];
                    return {
                        from: getHeader(headers, 'From'),
                        date: getHeader(headers, 'Date'),
                        snippet: msg.snippet,
                    };
                });
        } catch (err) {
            logger.error('GmailService', 'GetThreadHistory', `Failed to fetch thread ${threadId}`, err);
            return [];
        }
    },

    /**
     * Sends an email via the Gmail API.
     * @param {string} userId
     * @param {Object} draft { to, subject, body, threadId, attachments, inReplyTo, references }
     */
    async sendEmail(userId, draft, userEmail) {
        try {
            const gmail = await this.getClient(userId, userEmail);
            const raw = encodeBase64Url(buildRawMessage(draft));

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
     * Moves a message to trash (Undo Send / delete).
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
            const fromRaw = getHeader(headers, 'From');
            const replyToRaw = getHeader(headers, 'Reply-To');
            const dateHeader = getHeader(headers, 'Date');
            const body = extractBody(msg.payload);

            let timestamp = new Date().toISOString();
            if (msg.internalDate) {
                timestamp = new Date(Number(msg.internalDate)).toISOString();
            } else if (dateHeader) {
                const parsedDate = new Date(dateHeader);
                if (!Number.isNaN(parsedDate.getTime())) {
                    timestamp = parsedDate.toISOString();
                }
            }

            return {
                id: msg.id,
                threadId: msg.threadId,
                from: extractEmailAddress(fromRaw),
                fromName: extractDisplayName(fromRaw),
                replyTo: extractEmailAddress(replyToRaw) || extractEmailAddress(fromRaw),
                to: getHeader(headers, 'To'),
                subject: getHeader(headers, 'Subject') || 'No subject',
                snippet: msg.snippet || body.slice(0, 240),
                body,
                labelIds: msg.labelIds || [],
                messageIdHeader: getHeader(headers, 'Message-ID'),
                references: getHeader(headers, 'References'),
                date: dateHeader,
                timestamp,
                hasAttachment: hasAttachment(msg.payload),
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

    /**
     * Mark an email as read (remove UNREAD label)
     */
    async markAsRead(userId, messageId, userEmail) {
        const gmail = await this.getClient(userId, userEmail);
        return withRetry(() => gmail.users.messages.batchModify({
            userId: 'me',
            requestBody: {
                ids: [messageId],
                removeLabelIds: ['UNREAD'],
            }
        }));
    },

    /**
     * Set up push notifications (watch) for an account.
     * @param {string} userId
     * @param {string} userEmail
     */
    async watchAccount(userId, userEmail) {
        if (!process.env.GMAIL_PUBSUB_TOPIC) return null;
        try {
            const gmail = await this.getClient(userId, userEmail);
            const res = await withRetry(() => gmail.users.watch({
                userId: 'me',
                requestBody: {
                    labelIds: ['INBOX'],
                    topicName: process.env.GMAIL_PUBSUB_TOPIC,
                }
            }));
            logger.info('GmailService', 'Watch', `Push watch enabled for ${userEmail}. HistoryId: ${res.data.historyId}`);
            return res.data;
        } catch (err) {
            logger.error('GmailService', 'Watch', `Failed to set up watch for ${userEmail}`, err);
            throw err;
        }
    },

    /**
     * Stop push notifications.
     */
    async stopWatch(userId, userEmail) {
        try {
            const gmail = await this.getClient(userId, userEmail);
            await withRetry(() => gmail.users.stop({ userId: 'me' }));
            logger.info('GmailService', 'StopWatch', `Push watch disabled for ${userEmail}`);
            return true;
        } catch (err) {
            logger.error('GmailService', 'StopWatch', `Failed to stop watch for ${userEmail}`, err);
            throw err;
        }
    }
};
