import { telegramService } from '../services/telegram.js';
import { supabase } from '../config/supabase.js';
import { env } from '../config/env.js';
import { VELOX } from '../config/constants.js';
import { vaultAgent } from '../agents/vault.js';
import { memoryAgent } from '../agents/memory.js';
import { logger } from '../utils/logger.js';

/**
 * Velox — Telegram Command Handlers
 */
export const telegramCommands = {

    async handleStart(chatId) {
        try {
            // 1. Check if user exists
            let { data: user, error: _error } = await supabase
                .from('users')
                .select('id')
                .eq('telegram_chat_id', chatId.toString())
                .single();

            if (!user) {
                // 2. Register new user
                const { data: newUser, error: createError } = await supabase
                    .from('users')
                    .insert({ telegram_chat_id: chatId.toString(), plan: 'free' })
                    .select('id')
                    .single();

                if (createError) throw createError;
                user = newUser;
                logger.info('Telegram', 'NewUser', `Registered user ${user.id} for chat ${chatId}`);
            }

            const text =
                `⚡ *Welcome to Velox v${VELOX.VERSION}*\n\n` +
                'I am your AI email assistant. I read your emails, draft replies, ' +
                'and notify you right here on Telegram.\n\n' +
                '🔗 *Setup:* Connect your Gmail first:\n' +
                `${(process.env.RENDER_EXTERNAL_URL ? process.env.RENDER_EXTERNAL_URL + '/auth/google' : env.googleRedirectUri.replace('/auth/google/callback', '/auth/google'))}?userId=${user.id}\n\n` +
                'Reuse the same link anytime to connect another Gmail account.\n\n' +
                'Type /help to see all commands.';

            await telegramService.sendMessage(chatId, text);
        } catch (err) {
            logger.error('Telegram', 'StartFail', 'Failed to handle /start', err);
            await telegramService.sendMessage(chatId, '❌ Something went wrong during registration. Please try again later.');
        }
    },

    /**
     * Helper to get internal UUID from Telegram Chat ID
     */
    async resolveUser(chatId) {
        const { data } = await supabase
            .from('users')
            .select('id')
            .eq('telegram_chat_id', chatId.toString())
            .single();
        return data?.id;
    },

    async handleHelp(chatId) {
        const text =
            '⚡ *Velox Commands*\n' +
            '━━━━━━━━━━━━━━━━━\n\n' +
            '📥 *Inbox*\n' +
            '/inbox — Today\'s important emails\n' +
            '/pending — Drafts awaiting your approval\n\n' +
            '📎 *Vault*\n' +
            '/vault — Recent stored documents\n' +
            '/find [text] — Search documents\n\n' +
            '👤 *Contacts*\n' +
            '/vip add [email] — Mark as VIP\n' +
            '/ignore add [email] — Silence sender\n\n' +
            '⚙️ *Settings*\n' +
            '/status — System health\n' +
            '/away [hours] — Away mode\n\n' +
            '💬 Or just type naturally!\n' +
            '_"Did Rahul reply?" • "Find my Swiggy receipt"_';

        await telegramService.sendMessage(chatId, text);
    },

    async handleStatus(chatId) {
        try {
            const userId = await this.resolveUser(chatId);
            if (!userId) return telegramService.sendMessage(chatId, '👋 Please type /start to register.');

            const uptimeMs = process.uptime() * 1000;
            const uptimeMins = Math.floor(uptimeMs / 60000);
            const uptimeHrs = Math.floor(uptimeMins / 60);

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            // 1. Emails today
            const { count: emailCount } = await supabase
                .from('processed_emails')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId)
                .gte('locked_at', today.toISOString());

            // 2. API Usage
            const { count: apiCalls } = await supabase
                .from('api_usage')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId)
                .eq('provider', 'gemini')
                .gte('timestamp', today.toISOString());

            // 3. Vault Usage
            const { data: vaultDocs } = await supabase
                .from('vault_metadata')
                .select('size_kb')
                .eq('user_id', userId);
            const totalSizeKB = vaultDocs?.reduce((sum, d) => sum + (d.size_kb || 0), 0) || 0;
            const sizeMB = (totalSizeKB / 1024).toFixed(2);

            const text =
                '⚡ *Your Velox Status*\n' +
                '━━━━━━━━━━━━━━━━━\n\n' +
                '🟢 Status: *Optimal*\n' +
                `⏱ Uptime: ${uptimeHrs}h ${uptimeMins % 60}m\n` +
                `📧 Emails today: ${emailCount || 0}\n` +
                `🤖 API (Gemini): ${apiCalls || 0}/1500\n` +
                `📎 Vault: ${sizeMB} MB\n\n` +
                `_v${VELOX.VERSION}_`;

            await telegramService.sendMessage(chatId, text);
        } catch (err) {
            logger.error('Telegram', 'StatusFail', 'Failed to handle /status', err);
        }
    },

    async handleInbox(chatId, userId) {
        const { data: pending } = await supabase
            .from('processed_emails')
            .select('*')
            .eq('user_id', userId)
            .eq('status', 'processing')
            .order('locked_at', { ascending: false })
            .limit(10);

        if (!pending || pending.length === 0) {
            await telegramService.sendMessage(chatId, '✅ *Inbox clear!* No emails need your attention.');
            return;
        }

        let text = `📥 *${pending.length} email(s) need attention*\n━━━━━━━━━━━━━━━━━\n\n`;
        pending.forEach((e, i) => {
            text += `${i + 1}. [${e.user_email || 'General'}] — \`${e.message_id}\` — _${e.status}_\n`;
        });

        await telegramService.sendMessage(chatId, text);
    },

    async handlePending(chatId, userId) {
        const { data: drafts } = await supabase
            .from('pending_sends')
            .select('*')
            .eq('user_id', userId)
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(10);

        if (!drafts || drafts.length === 0) {
            await telegramService.sendMessage(chatId, '✅ *No pending drafts.* All caught up!');
            return;
        }

        let text = `📝 *${drafts.length} draft(s) pending*\n━━━━━━━━━━━━━━━━━\n\n`;
        drafts.forEach((d, i) => {
            text += `${i + 1}. [${d.user_email || 'General'}] *To:* ${d.email_to}\n   _${d.subject}_\n\n`;
        });

        await telegramService.sendWithButtons(chatId, text, [
            [{ text: '✅ Send All', callback_data: 'send_all_pending' }],
            [{ text: '❌ Dismiss All', callback_data: 'dismiss_all_pending' }],
        ]);
    },

    async handleVault(chatId, userId) {
        const { data: docs } = await supabase.from('vault_metadata').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(5);
        if (!docs || docs.length === 0) {
            await telegramService.sendMessage(chatId, '📎 *Vault is empty.*');
            return;
        }
        let text = '📎 *Recent Documents*\n━━━━━━━━━━━━━━━━━\n\n';
        docs.forEach(d => { text += `• ${d.vendor || 'Unknown'} — ${d.doc_type}\n  _${d.summary}_\n\n`; });
        await telegramService.sendMessage(chatId, text);
    },

    async handleFind(chatId, query, userId) {
        if (!query) return telegramService.sendMessage(chatId, 'Type `/find [what you are looking for]`');
        await telegramService.sendMessage(chatId, `🔍 Searching vault for: _${query}_...`);
        const result = await vaultAgent.findDocument(userId, query);
        if (!result.found) return telegramService.sendMessage(chatId, `❌ ${result.message}`);

        let text = '📎 *Search Results*\n━━━━━━━━━━━━━━━━━\n\n';
        result.docs.forEach(d => { text += `• ${d.vendor || 'Unknown'} — ${d.doc_type}\n  _${d.summary}_\n\n`; });
        await telegramService.sendMessage(chatId, text);
    },

    async handleVip(chatId, params, userId) {
        const [_action, email] = params.split(' ');
        if (!email) return telegramService.sendMessage(chatId, 'Type `/vip add person@email.com`');
        await memoryAgent.updateContactMemory(userId, email, { is_vip: true });
        await telegramService.sendMessage(chatId, `🌟 *${email}* added to VIP list.`);
    },

    async handleIgnore(chatId, params, userId) {
        const [_action, email] = params.split(' ');
        if (!email) return telegramService.sendMessage(chatId, 'Type `/ignore add person@email.com`');
        await memoryAgent.updateContactMemory(userId, email, { is_ignored: true });
        await telegramService.sendMessage(chatId, `🔇 *${email}* added to Ignore list.`);
    },

    async handleAway(chatId, hours, userId) {
        const h = parseInt(hours) || 24;
        const until = new Date();
        until.setHours(until.getHours() + h);

        await supabase.from('user_status').upsert({ user_id: userId, status: 'away', away_until: until.toISOString() });
        await telegramService.sendMessage(chatId, `🌴 *Away mode activated* for ${h} hours. I will hold important emails for your return.`);
    },

    async handleUnknown(chatId) {
        await telegramService.sendMessage(
            chatId,
            '🤔 I didn\'t understand that. Type /help to see available commands.'
        );
    },

    async handleSent(chatId, userId) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const { data: emails } = await supabase.from('email_history')
            .select('recipient, subject, sent_at, user_email')
            .eq('user_id', userId)
            .gte('sent_at', today.toISOString())
            .order('sent_at', { ascending: true });

        if (!emails || emails.length === 0) return telegramService.sendMessage(chatId, '📭 No emails sent today via AI.');

        let text = '📤 *Sent Today*\n━━━━━━━━━━━━━━━━━\n\n';
        emails.forEach(e => { text += `• [${e.user_email || 'General'}] *To:* ${e.recipient}\n  _${e.subject}_\n\n`; });
        await telegramService.sendMessage(chatId, text);
    },

    async handleSearch(chatId, query, userId) {
        if (!query) return telegramService.sendMessage(chatId, 'Type `/search [person or topic]`');
        const { nlHandler } = await import('../agents/nlHandler.js'); // lazy import to avoid circular defaults
        await nlHandler.handleEmailSearch(userId, chatId, { query });
    },

    async handleBack(chatId, userId) {
        await supabase.from('user_status').upsert({ user_id: userId, status: 'active', away_until: null });
        await telegramService.sendMessage(chatId, '👋 *Welcome back!* Away mode is now disabled. I will begin queuing drafts normally.');
    },

    async handlePause(chatId, userId) {
        await supabase.from('user_status').upsert({ user_id: userId, status: 'paused' });
        await telegramService.sendMessage(chatId, '⏸ *Auto-sends paused.* I will only analyze and prepare drafts, but won\'t send them autonomously.');
    },

    async handleResume(chatId, userId) {
        await supabase.from('user_status').upsert({ user_id: userId, status: 'active' });
        await telegramService.sendMessage(chatId, '▶️ *Auto-sends resumed.* Level 2 autonomy enabled.');
    },

    async handleTone(chatId, tone, userId) {
        if (!['formal', 'casual', 'friendly', 'direct'].includes(tone)) {
            return telegramService.sendMessage(chatId, 'Type `/tone [formal|casual|friendly|direct]`');
        }
        await supabase.from('user_memory').upsert({ user_id: userId, tone_style: tone });
        await telegramService.sendMessage(chatId, `🎭 Tone updated to *${tone}*.\n_Note: It may take 2-3 emails for me to fully adjust._`);
    },

    async handleWhitelist(chatId, args, userId) {
        const [action, domain] = args.split(' ');
        if (!['add', 'remove', 'list'].includes(action)) {
            return telegramService.sendMessage(chatId, 'Type `/whitelist [add|remove|list] [domain]` (e.g., `/whitelist add @company.com`)');
        }

        const mem = await memoryAgent.getMemoryContext(userId);
        let whitelist = mem.whitelist || [];

        if (action === 'list') {
            const listText = whitelist.length > 0 ? whitelist.join('\n• ') : 'No whitelisted domains.';
            return telegramService.sendMessage(chatId, `✅ *Whitelisted Domains*\n━━━━━━━━━━━━━━━━━\n• ${listText}`);
        }

        if (!domain || !domain.startsWith('@')) return telegramService.sendMessage(chatId, 'Please specify a domain starting with @ (e.g., `@example.com`)');

        if (action === 'add') {
            if (!whitelist.includes(domain)) whitelist.push(domain);
        } else if (action === 'remove') {
            whitelist = whitelist.filter(d => d !== domain);
        }

        await supabase.from('user_memory').upsert({ user_id: userId, whitelist });
        await telegramService.sendMessage(chatId, `✅ Domain *${domain}* ${action}ed manually.`);
    },

    async handleUndo(chatId, userId) {
        const { sendAgent } = await import('../agents/send.js'); // lazy import
        await telegramService.sendMessage(chatId, '↩️ Attempting to recall the last sent email...');

        // Find most recent email within undo window
        const { data: lastEmail } = await supabase.from('email_history')
            .select('message_id, user_email')
            .eq('user_id', userId)
            .order('sent_at', { ascending: false })
            .limit(1)
            .single();

        if (!lastEmail) return telegramService.sendMessage(chatId, '❌ No recent emails found to undo.');

        const res = await sendAgent.undoSend(userId, lastEmail.message_id, lastEmail.user_email);
        if (res.success) {
            await telegramService.sendMessage(chatId, '✅ Email successfully recalled. It has been restored as a draft.');
        } else {
            await telegramService.sendMessage(chatId, `❌ Failed to undo: ${res.message}. It may have already left the queue.`);
        }
    },
};
