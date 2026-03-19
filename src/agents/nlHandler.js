import { aiService } from '../services/ai.js';
import { vaultAgent } from './vault.js';
import { supabase } from '../config/supabase.js';
import { telegramService } from '../services/telegram.js';
import { logger } from '../utils/logger.js';
import { helpers } from '../utils/helpers.js';

/**
 * Natural Language Handler
 * Classifies free-form Telegram messages and routes them
 * to the correct agent (vault search, email search, draft, status query).
 */
export const nlHandler = {

    /**
     * Main entry point — classify and route a natural language message
     * @param {string} userId - Internal user ID
     * @param {string} chatId - Telegram chat ID
     * @param {string} text - Raw user message
     */
    async handle(userId, chatId, text) {
        try {
            logger.info('NLHandler', 'Classify', `Classifying: "${text.substring(0, 50)}..."`);

            const prompt = `
Classify this user message into exactly one of these categories:
- vault_search: looking for a stored document (receipt, ticket, invoice, etc.)
- email_search: looking for a past email or checking if someone replied
- draft_request: wants to compose/send a new email
- status_query: asking about an email thread or system status
- command: wants to perform a specific action

Message: "${text}"

Return ONLY valid JSON:
{
  "type": "vault_search | email_search | draft_request | status_query | command",
  "extracted_params": {
    "query": "search term if applicable",
    "recipient": "email address if applicable",
    "subject": "subject if applicable",
    "sender": "sender name if applicable"
  }
}`;

            const result = await aiService.callAI(prompt, 'Reply ONLY with valid JSON. No explanation.', userId);
            const intent = JSON.parse(helpers.extractJSON(result));

            switch (intent.type) {
            case 'vault_search':
                return this.handleVaultSearch(userId, chatId, text, intent.extracted_params);
            case 'email_search':
                return this.handleEmailSearch(userId, chatId, intent.extracted_params);
            case 'draft_request':
                return this.handleDraftRequest(userId, chatId, intent.extracted_params);
            case 'status_query':
                return this.handleStatusQuery(userId, chatId, intent.extracted_params);
            default:
                await telegramService.sendMessage(chatId,
                    '🤔 I\'m not sure what you mean. Try commands like:\n' +
                        '• _"Find my Swiggy receipt"_\n' +
                        '• _"Did Rahul reply?"_\n' +
                        '• _"Draft an email to john@x.com"_\n' +
                        '• Type /help for all commands');
            }
        } catch (err) {
            logger.error('NLHandler', 'Error', `Failed to classify: "${text}"`, err);
            await telegramService.sendMessage(chatId,
                '❌ I couldn\'t process that. Try /help to see available commands.');
        }
    },

    /**
     * Vault search — find stored documents
     */
    async handleVaultSearch(userId, chatId, originalText, params) {
        await telegramService.sendMessage(chatId, `🔍 Searching vault for: _${params.query || originalText}_...`);

        const result = await vaultAgent.findDocument(userId, params.query || originalText);

        if (!result.found) {
            return telegramService.sendMessage(chatId, `❌ ${result.message}`);
        }

        let text = '📎 *Search Results*\n━━━━━━━━━━━━━━━━━\n\n';
        result.docs.forEach(d => {
            text += `• ${d.vendor || 'Unknown'} — ${d.doc_type}\n  _${d.summary}_\n\n`;
        });
        await telegramService.sendMessage(chatId, text);
    },

    /**
     * Email search — check history for replies, past emails
     */
    async handleEmailSearch(userId, chatId, params) {
        const sender = params.sender || params.query || '';

        const { data: emails } = await supabase.from('email_history')
            .select('recipient, subject, sent_at, confidence')
            .eq('user_id', userId)
            .or(`recipient.ilike.%${sender}%,subject.ilike.%${sender}%`)
            .order('sent_at', { ascending: false })
            .limit(5);

        if (!emails || emails.length === 0) {
            return telegramService.sendMessage(chatId, `❌ No emails found matching _"${sender}"_.`);
        }

        let text = `📧 *Emails matching "${sender}"*\n━━━━━━━━━━━━━━━━━\n\n`;
        emails.forEach((e, i) => {
            const date = e.sent_at ? new Date(e.sent_at).toLocaleDateString() : 'unknown';
            text += `${i + 1}. *To:* ${e.recipient}\n   _${e.subject}_\n   📅 ${date}\n\n`;
        });
        await telegramService.sendMessage(chatId, text);
    },

    /**
     * Draft request — compose a new email via AI
     */
    async handleDraftRequest(userId, chatId, params) {
        if (!params.recipient) {
            return telegramService.sendMessage(chatId,
                '✍️ To draft an email, include the recipient:\n' +
                '_"Draft an email to john@example.com about the project delay"_');
        }

        await telegramService.sendMessage(chatId,
            `✍️ Drafting email to *${params.recipient}*...\n_Subject: ${params.subject || 'TBD'}_`);

        // Store as pending draft for further refinement
        const { data } = await supabase.from('pending_sends').insert({
            user_id: userId,
            email_to: params.recipient,
            subject: params.subject || '',
            body: '',
            status: 'drafting',
        }).select().single();

        if (data) {
            await telegramService.sendWithButtons(chatId,
                '📝 Draft created. Send me the body text, or I can generate it.\n\n_Reply with the email content or tap below._',
                [[{ text: '🤖 AI Generate', callback_data: `ai_draft_${data.id}` },
                    { text: '❌ Cancel', callback_data: `cancel_draft_${data.id}` }]]
            );
        }
    },

    /**
     * Status query — check thread status or ask about specific emails
     */
    async handleStatusQuery(userId, chatId, params) {
        const query = params.sender || params.query || '';

        const { data: recent } = await supabase.from('email_history')
            .select('*')
            .eq('user_id', userId)
            .or(`recipient.ilike.%${query}%,subject.ilike.%${query}%`)
            .order('sent_at', { ascending: false })
            .limit(3);

        if (!recent || recent.length === 0) {
            return telegramService.sendMessage(chatId,
                `❓ I don't have any records matching _"${query}"_.`);
        }

        let text = `📊 *Status for "${query}"*\n━━━━━━━━━━━━━━━━━\n\n`;
        recent.forEach(e => {
            const sentDate = e.sent_at ? new Date(e.sent_at).toLocaleDateString() : '?';
            text += `• *${e.recipient}* — ${e.subject}\n  Sent: ${sentDate}\n\n`;
        });
        await telegramService.sendMessage(chatId, text);
    },
};
