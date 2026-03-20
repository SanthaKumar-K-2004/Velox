import { aiService } from '../services/ai.js';
import { vaultAgent } from './vault.js';
import { supabase } from '../config/supabase.js';
import { telegramService } from '../services/telegram.js';
import { telegramCommands } from '../server/telegramCommands.js';
import { logger } from '../utils/logger.js';
import { helpers } from '../utils/helpers.js';

/**
 * Natural Language Handler (Omni-Router)
 * Classifies free-form messages and routes them to the correct agent or command.
 */
export const nlHandler = {

    async handle(userId, chatId, text) {
        try {
            logger.info('NLHandler', 'Classify', `Classifying: "${text.substring(0, 50)}..."`);

            // Fast-path common phrases to save API tokens
            const lower = text.toLowerCase().trim();
            if (lower === 'help' || lower === 'menu') return telegramCommands.handleHelp(chatId);
            if (lower === 'inbox') return telegramCommands.handleInbox(chatId, userId);
            if (lower === 'pending') return telegramCommands.handlePending(chatId, userId);
            if (lower === 'vault') return telegramCommands.handleVault(chatId, userId);

            const prompt = `
Classify this user message into exactly one of these categories:
- inbox: wants to check today's important emails or unread messages
- pending: wants to check drafts awaiting approval
- vault_list: wants to see recent stored documents
- vault_search: looking for a specific stored document (receipt, ticket, invoice, etc.)
- email_search: looking for a past email or checking if someone replied
- draft_request: wants to compose/send a new email
- status_query: asking about an email thread, API usage, or system health status
- sent_list: wants to check emails sent today
- away_mode: wants to pause auto-sending or go on vacation
- resume_mode: wants to resume auto-sending or come back from vacation
- vip_add: wants to mark a sender as VIP or prioritize them
- ignore_add: wants to silence/ignore a sender or mute them
- tone_update: wants to change the AI's writing style (formal, casual, friendly, direct)
- help: wants to see commands or needs assistance

Message: "${text}"

Return ONLY valid JSON:
{
  "type": "inbox | pending | vault_list | vault_search | email_search | draft_request | status_query | sent_list | away_mode | resume_mode | vip_add | ignore_add | tone_update | help",
  "extracted_params": {
    "query": "search term if applicable",
    "recipient": "email address if applicable",
    "subject": "subject if applicable",
    "sender": "sender name or email if applicable",
    "hours": "number of hours if away mode (default 24)",
    "tone": "formal | casual | friendly | direct"
  }
}`;

            const result = await aiService.callAI(prompt, 'Reply ONLY with valid JSON. No explanation.', userId);
            const intent = JSON.parse(helpers.extractJSON(result));

            logger.info('NLHandler', 'IntentParsed', `Mapped to type: ${intent.type}`);

            switch (intent.type) {
            case 'inbox': return telegramCommands.handleInbox(chatId, userId);
            case 'pending': return telegramCommands.handlePending(chatId, userId);
            case 'vault_list': return telegramCommands.handleVault(chatId, userId);
            case 'sent_list': return telegramCommands.handleSent(chatId, userId);
            case 'away_mode': return telegramCommands.handleAway(chatId, intent.extracted_params?.hours || 24, userId);
            case 'resume_mode': return telegramCommands.handleBack(chatId, userId);
            case 'vip_add': return telegramCommands.handleVip(chatId, `add ${intent.extracted_params?.sender || ''}`, userId);
            case 'ignore_add': return telegramCommands.handleIgnore(chatId, `add ${intent.extracted_params?.sender || ''}`, userId);
            case 'tone_update': return telegramCommands.handleTone(chatId, intent.extracted_params?.tone || 'casual', userId);
            case 'help': return telegramCommands.handleHelp(chatId);

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
                    '🤔 I am not quite sure what you mean. Try saying:\n' +
                        '• _"Show my inbox"_\n' +
                        '• _"Did Rahul reply?"_\n' +
                        '• _"Draft an email to john@x.com"_\n' +
                        '• _"I\'m going away for 48 hours"_');
            }
        } catch (err) {
            logger.error('NLHandler', 'Error', `Failed to classify: "${text}"`, err);
            await telegramService.sendMessage(chatId,
                '❌ I couldn\'t process that intent. Try saying "help".');
        }
    },

    async handleVaultSearch(userId, chatId, originalText, params) {
        await telegramService.sendMessage(chatId, `🔍 Searching vault for: _${params.query || originalText}_...`);
        const result = await vaultAgent.findDocument(userId, params.query || originalText);

        if (!result.found) return telegramService.sendMessage(chatId, `❌ ${result.message}`);

        let text = '📎 *Search Results*\n━━━━━━━━━━━━━━━━━\n\n';
        result.docs.forEach(d => { text += `• ${d.vendor || 'Unknown'} — ${d.doc_type}\n  _${d.summary}_\n\n`; });
        await telegramService.sendMessage(chatId, text);
    },

    async handleEmailSearch(userId, chatId, params) {
        const sender = params.sender || params.query || '';
        const { data: emails } = await supabase.from('email_history')
            .select('recipient, subject, sent_at, confidence')
            .eq('user_id', userId)
            .or(`recipient.ilike.%${sender}%,subject.ilike.%${sender}%`)
            .order('sent_at', { ascending: false })
            .limit(5);

        if (!emails || emails.length === 0) return telegramService.sendMessage(chatId, `❌ No past emails found matching _"${sender}"_.`);

        let text = `📧 *Emails matching "${sender}"*\n━━━━━━━━━━━━━━━━━\n\n`;
        emails.forEach((e, i) => {
            const date = e.sent_at ? new Date(e.sent_at).toLocaleDateString() : 'unknown';
            text += `${i + 1}. *To:* ${e.recipient}\n   _${e.subject}_\n   📅 ${date}\n\n`;
        });
        await telegramService.sendMessage(chatId, text);
    },

    async handleDraftRequest(userId, chatId, params) {
        if (!params.recipient) {
            return telegramService.sendMessage(chatId, '✍️ To draft an email, please include the recipient (e.g., "Draft an email to john@example.com about the project").');
        }
        await telegramService.sendMessage(chatId, `✍️ Drafting email to *${params.recipient}*...\n_Subject: ${params.subject || 'TBD'}_`);

        // Store as pending draft
        const { data } = await supabase.from('pending_sends').insert({
            user_id: userId, email_to: params.recipient, subject: params.subject || '', body: '', status: 'drafting',
        }).select().single();

        if (data) {
            await telegramService.sendWithButtons(chatId,
                '📝 Draft outline created. Send me the body text, or I can generate it for you.\n\n_Reply directly with the email content or tap below._',
                [[{ text: '🤖 AI Generate', callback_data: `ai_draft_${data.id}` }, { text: '❌ Cancel', callback_data: `cancel_draft_${data.id}` }]]
            );
        }
    },

    async handleStatusQuery(userId, chatId, params) {
        const query = params.sender || params.query || '';

        // If query is empty or specifically asks for system status, use global status
        if (!query || query.toLowerCase() === 'system' || query.toLowerCase() === 'status') {
            return telegramCommands.handleStatus(chatId);
        }

        const { data: recent } = await supabase.from('email_history')
            .select('*').eq('user_id', userId)
            .or(`recipient.ilike.%${query}%,subject.ilike.%${query}%`)
            .order('sent_at', { ascending: false }).limit(3);

        if (!recent || recent.length === 0) return telegramService.sendMessage(chatId, `❓ I don't have any records matching _"${query}"_.`);

        let text = `📊 *Status for "${query}"*\n━━━━━━━━━━━━━━━━━\n\n`;
        recent.forEach(e => {
            const sentDate = e.sent_at ? new Date(e.sent_at).toLocaleDateString() : '?';
            text += `• *${e.recipient}* — ${e.subject}\n  Sent: ${sentDate}\n\n`;
        });
        await telegramService.sendMessage(chatId, text);
    },
};
