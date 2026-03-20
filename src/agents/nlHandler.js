import { memoryAgent } from './memory.js';
import { aiService } from '../services/ai.js';
import { vaultAgent } from './vault.js';
import { supabase } from '../config/supabase.js';
import { telegramService } from '../services/telegram.js';
import { telegramCommands } from '../server/telegramCommands.js';
import { logger } from '../utils/logger.js';
import { helpers } from '../utils/helpers.js';

const ALLOWED_INTENTS = new Set([
    'chat',
    'inbox',
    'pending',
    'vault_search',
    'email_search',
    'status_query',
    'help',
]);

function escape(value) {
    return telegramService.escapeMarkdown(value ?? '');
}

/**
 * Natural Language Handler (Omni-Router)
 * Classifies free-form messages and routes them to the correct agent or command.
 */
export const nlHandler = {

    async handle(userId, chatId, text) {
        try {
            logger.info('NLHandler', 'Conversational', `User: "${text.substring(0, 50)}"`);

            const memory = await memoryAgent.getCoreMemory(userId);
            const { data: history } = await supabase.from('conversation_history')
                .select('role, content')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(6);

            await supabase.from('conversation_history').insert({
                user_id: userId,
                role: 'user',
                content: text
            });

            const intent = await this.classifyIntent(userId, text, memory, history || []);

            switch (intent.type) {
            case 'inbox':
                return telegramCommands.handleInbox(chatId, userId);
            case 'pending':
                return telegramCommands.handlePending(chatId, userId);
            case 'vault_search':
                return this.handleVaultSearch(userId, chatId, text, intent.extracted_params || {});
            case 'email_search':
                return this.handleEmailSearch(userId, chatId, intent.extracted_params || {});
            case 'status_query':
                return this.handleStatusQuery(userId, chatId, intent.extracted_params || {});
            case 'help':
                return telegramCommands.handleHelp(chatId);
            case 'chat':
            default: {
                const reply = await this.generateChatReply(userId, text, memory, history || []);
                await telegramService.sendMessage(chatId, reply);
                await supabase.from('conversation_history').insert({
                    user_id: userId,
                    role: 'assistant',
                    content: reply
                });
                return;
            }
            }
        } catch (err) {
            logger.error('NLHandler', 'Error', `Failed to process text: "${text}"`, err);
            await telegramService.sendMessage(chatId, 'I hit an internal error while processing that request. Please try again.');
        }
    },

    async classifyIntent(userId, text, memory, history) {
        const contextHistory = history
            .slice()
            .reverse()
            .map((entry) => `${entry.role}: ${entry.content}`)
            .join('\n');

        const systemPrompt = `
You classify the user's latest Telegram message for an email assistant.
Do not roleplay tool execution. Do not claim you already searched, checked, sent, or found anything.
Return JSON only.
Allowed intents:
- chat
- inbox
- pending
- vault_search
- email_search
- status_query
- help`;

        const userPrompt = `
Conversation context:
${contextHistory || '[none]'}

User profile:
- Tone: ${memory.tone_style || 'friendly'}
- Formality: ${memory.formality_score || 50}

Latest user message:
"${text}"

Return JSON:
{
  "type": "chat | inbox | pending | vault_search | email_search | status_query | help",
  "extracted_params": {
    "query": "string or empty"
  }
}`;

        const raw = await aiService.callAI(userPrompt, systemPrompt, userId);
        const parsed = helpers.parseJSON(raw, {});
        const type = ALLOWED_INTENTS.has(parsed.type) ? parsed.type : 'chat';

        return {
            type,
            extracted_params: typeof parsed.extracted_params === 'object' && parsed.extracted_params !== null
                ? parsed.extracted_params
                : { query: text },
        };
    },

    async generateChatReply(userId, text, memory, history) {
        const contextHistory = history
            .slice()
            .reverse()
            .map((entry) => `${entry.role}: ${entry.content}`)
            .join('\n');

        const systemPrompt = `
You are Velox, an email assistant speaking to its user on Telegram.
Stay grounded and concise.
Do not claim you searched the inbox, checked status, or looked up documents unless the caller already completed that action.
If the user asks for an inbox, draft, vault, search, or status action, answer briefly that you are routing it rather than inventing results.`;

        const userPrompt = `
Conversation context:
${contextHistory || '[none]'}

User profile:
- Tone: ${memory.tone_style || 'friendly'}
- Sign-off: ${memory.sign_off || 'Best,'}

Reply to this message in 1-3 sentences:
"${text}"`;

        const raw = await aiService.callAI(userPrompt, systemPrompt, userId);
        return helpers.cleanText(raw, 'How can I help with your inbox?');
    },

    async handleVaultSearch(userId, chatId, originalText, params) {
        const query = helpers.cleanText(params.query, originalText);
        await telegramService.sendMessage(chatId, `Searching the vault for _${escape(query)}_...`);

        const docs = await vaultAgent.findDocument(userId, query);
        if (!docs || docs.length === 0) {
            return telegramService.sendMessage(chatId, `No stored documents matched _${escape(query)}_.`);
        }

        let text = '*Search Results*\n\n';
        docs.forEach((doc) => {
            text += `• ${escape(doc.vendor || 'Unknown')} - ${escape(doc.doc_type || 'document')}\n`;
            text += `_${escape(doc.summary || 'No summary available')}_\n\n`;
        });
        await telegramService.sendMessage(chatId, text);
    },

    async handleEmailSearch(userId, chatId, params) {
        const sender = helpers.cleanText(params.sender || params.query, '');
        const { data: emails } = await supabase.from('email_history')
            .select('recipient, subject, sent_at, confidence')
            .eq('user_id', userId)
            .or(`recipient.ilike.%${sender}%,subject.ilike.%${sender}%`)
            .order('sent_at', { ascending: false })
            .limit(5);

        if (!emails || emails.length === 0) {
            return telegramService.sendMessage(chatId, `No past emails matched _${escape(sender || 'that search')}_.`);
        }

        let text = `*Emails Matching "${escape(sender || 'recent')}"*\n\n`;
        emails.forEach((email, index) => {
            const date = email.sent_at ? new Date(email.sent_at).toLocaleDateString() : 'unknown';
            text += `${index + 1}. *To:* ${escape(email.recipient || 'Unknown')}\n`;
            text += `_${escape(email.subject || 'No subject')}_\n`;
            text += `Date: ${escape(date)}\n\n`;
        });
        await telegramService.sendMessage(chatId, text);
    },

    async handleDraftRequest(userId, chatId, params) {
        if (!params.recipient) {
            return telegramService.sendMessage(chatId, 'To draft an email, include the recipient address.');
        }

        await telegramService.sendMessage(chatId, `Drafting email to *${escape(params.recipient)}*...\n_Subject: ${escape(params.subject || 'TBD')}_`);

        const { data } = await supabase.from('pending_sends').insert({
            user_id: userId,
            email_to: params.recipient,
            subject: params.subject || '',
            body: '',
            status: 'drafting',
        }).select().single();

        if (data) {
            await telegramService.sendWithButtons(chatId,
                'Draft outline created. Send me the body text, or tap below to generate a draft.',
                [[
                    { text: 'AI Generate', callback_data: `ai_draft_${data.id}` },
                    { text: 'Cancel', callback_data: `cancel_draft_${data.id}` }
                ]]
            );
        }
    },

    async handleStatusQuery(userId, chatId, params) {
        const query = helpers.cleanText(params.sender || params.query, '');

        if (!query || query.toLowerCase() === 'system' || query.toLowerCase() === 'status') {
            return telegramCommands.handleStatus(chatId);
        }

        const { data: recent } = await supabase.from('email_history')
            .select('*')
            .eq('user_id', userId)
            .or(`recipient.ilike.%${query}%,subject.ilike.%${query}%`)
            .order('sent_at', { ascending: false })
            .limit(3);

        if (!recent || recent.length === 0) {
            return telegramService.sendMessage(chatId, `I don't have any records matching _${escape(query)}_.`);
        }

        let text = `*Status for "${escape(query)}"*\n\n`;
        recent.forEach((entry) => {
            const sentDate = entry.sent_at ? new Date(entry.sent_at).toLocaleDateString() : 'unknown';
            text += `• *${escape(entry.recipient || 'Unknown')}* - ${escape(entry.subject || 'No subject')}\n`;
            text += `Sent: ${escape(sentDate)}\n\n`;
        });
        await telegramService.sendMessage(chatId, text);
    },
};
