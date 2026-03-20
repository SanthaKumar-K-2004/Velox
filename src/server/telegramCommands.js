import { telegramService } from '../services/telegram.js';
import { supabase } from '../config/supabase.js';
import { env } from '../config/env.js';
import { VELOX } from '../config/constants.js';
import { vaultAgent } from '../agents/vault.js';
import { memoryAgent } from '../agents/memory.js';
import { logger } from '../utils/logger.js';

function escape(value) {
    return telegramService.escapeMarkdown(value ?? '');
}

function getConnectUrl(userId) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL
        ? `${process.env.RENDER_EXTERNAL_URL}/auth/google`
        : env.googleRedirectUri.replace('/auth/google/callback', '/auth/google');

    return `${baseUrl}?userId=${userId}`;
}

/**
 * Velox â€” Telegram Command Handlers
 */
export const telegramCommands = {

    async handleStart(chatId) {
        try {
            let { data: user } = await supabase
                .from('users')
                .select('id')
                .eq('telegram_chat_id', chatId.toString())
                .single();

            if (!user) {
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
                `*Welcome to Velox v${VELOX.VERSION}*\n\n` +
                'Connect Gmail to start monitoring email and drafting replies.\n\n' +
                `Setup link:\n${getConnectUrl(user.id)}\n\n` +
                'Reuse the same link any time to connect another Gmail account.\n' +
                'Type /help to see all commands.';

            await telegramService.sendMessage(chatId, text);
        } catch (err) {
            logger.error('Telegram', 'StartFail', 'Failed to handle /start', err);
            await telegramService.sendMessage(chatId, 'Registration failed. Please try again later.');
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
            '*Velox Commands*\n\n' +
            '/inbox - Emails that still need attention\n' +
            '/pending - Drafts queued for review or delayed send\n' +
            '/vault - Recent stored documents\n' +
            '/find [text] - Search stored documents\n' +
            '/search [text] - Search sent email history\n' +
            '/status - System health\n' +
            '/away [hours] - Enable away mode\n' +
            '/vip add [email] - Mark a contact as VIP\n' +
            '/ignore add [email] - Silence a sender\n' +
            '/tone [formal|casual|friendly|direct] - Update style guidance';

        await telegramService.sendMessage(chatId, text);
    },

    async handleStatus(chatId, dataOnly = false) {
        try {
            const userId = await this.resolveUser(chatId);
            if (!userId) {
                if (dataOnly) return { error: 'user_not_registered' };
                return telegramService.sendMessage(chatId, 'Please type /start to register first.');
            }

            const uptimeMs = process.uptime() * 1000;
            const uptimeMins = Math.floor(uptimeMs / 60000);
            const uptimeHrs = Math.floor(uptimeMins / 60);

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const { count: emailCount } = await supabase
                .from('processed_emails')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId)
                .gte('locked_at', today.toISOString());

            const { count: apiCalls } = await supabase
                .from('api_usage')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId)
                .eq('provider', 'gemini')
                .gte('timestamp', today.toISOString());

            const { data: vaultDocs } = await supabase
                .from('vault_metadata')
                .select('size_kb')
                .eq('user_id', userId);

            const totalSizeKB = vaultDocs?.reduce((sum, doc) => sum + (doc.size_kb || 0), 0) || 0;
            const statusData = {
                status: apiCalls > 1400 ? 'Near Limit' : 'Optimal',
                uptime: `${uptimeHrs}h ${uptimeMins % 60}m`,
                emails_today: emailCount || 0,
                api_usage: `${apiCalls || 0}/1500`,
                vault_size_mb: (totalSizeKB / 1024).toFixed(2),
                version: VELOX.VERSION
            };

            if (dataOnly) return statusData;

            const text =
                '*Your Velox Status*\n\n' +
                `Status: *${escape(statusData.status)}*\n` +
                `Uptime: ${escape(statusData.uptime)}\n` +
                `Emails today: ${escape(statusData.emails_today)}\n` +
                `API usage: ${escape(statusData.api_usage)}\n` +
                `Vault: ${escape(statusData.vault_size_mb)} MB\n\n` +
                `_v${escape(statusData.version)}_`;

            await telegramService.sendMessage(chatId, text);
        } catch (err) {
            logger.error('Telegram', 'StatusFail', 'Failed to handle /status', err);
            if (dataOnly) throw err;
        }
    },

    async handleInbox(chatId, userId, dataOnly = false) {
        const { data: pending } = await supabase
            .from('processed_emails')
            .select('*')
            .eq('user_id', userId)
            .eq('status', 'processing')
            .order('locked_at', { ascending: false })
            .limit(10);

        if (dataOnly) return { emails: pending || [] };

        if (!pending || pending.length === 0) {
            await telegramService.sendMessage(chatId, '*Inbox clear.* No emails need your attention right now.');
            return;
        }

        let text = `*${pending.length} email(s) need attention*\n\n`;
        pending.forEach((email, index) => {
            text += `${index + 1}. [${escape(email.user_email || 'General')}] \`${escape(email.message_id)}\` - _${escape(email.status)}_\n`;
        });

        await telegramService.sendMessage(chatId, text);
    },

    async handlePending(chatId, userId, dataOnly = false) {
        const { data: drafts } = await supabase
            .from('pending_sends')
            .select('*')
            .eq('user_id', userId)
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(10);

        if (dataOnly) return { drafts: drafts || [] };

        if (!drafts || drafts.length === 0) {
            await telegramService.sendMessage(chatId, '*No pending drafts.*');
            return;
        }

        let text = `*${drafts.length} draft(s) pending*\n\n`;
        drafts.forEach((draft, index) => {
            text += `${index + 1}. [${escape(draft.user_email || 'General')}] *To:* ${escape(draft.email_to)}\n`;
            text += `_${escape(draft.subject || 'No subject')}_\n\n`;
        });

        await telegramService.sendMessage(chatId, text);
    },

    async handleVault(chatId, userId, dataOnly = false) {
        const { data: docs } = await supabase
            .from('vault_metadata')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(5);

        if (dataOnly) return { documents: docs || [] };

        if (!docs || docs.length === 0) {
            await telegramService.sendMessage(chatId, '*Vault is empty.*');
            return;
        }

        let text = '*Recent Documents*\n\n';
        docs.forEach((doc) => {
            text += `• ${escape(doc.vendor || 'Unknown')} - ${escape(doc.doc_type || 'document')}\n`;
            text += `_${escape(doc.summary || 'No summary available')}_\n\n`;
        });

        await telegramService.sendMessage(chatId, text);
    },

    async handleFind(chatId, query, userId) {
        if (!query) {
            return telegramService.sendMessage(chatId, 'Type `/find [what you are looking for]`');
        }

        await telegramService.sendMessage(chatId, `Searching vault for _${escape(query)}_...`);
        const docs = await vaultAgent.findDocument(userId, query);

        if (!docs || docs.length === 0) {
            return telegramService.sendMessage(chatId, `No documents matched _${escape(query)}_.`);
        }

        let text = '*Search Results*\n\n';
        docs.forEach((doc) => {
            text += `• ${escape(doc.vendor || 'Unknown')} - ${escape(doc.doc_type || 'document')}\n`;
            text += `_${escape(doc.summary || 'No summary available')}_\n\n`;
        });
        await telegramService.sendMessage(chatId, text);
    },

    async handleVip(chatId, params, userId) {
        const [, email] = params.split(' ');
        if (!email) return telegramService.sendMessage(chatId, 'Type `/vip add person@email.com`');
        await memoryAgent.updateContactMemory(userId, email, { is_vip: true });
        await telegramService.sendMessage(chatId, `*${escape(email)}* added to VIP list.`);
    },

    async handleIgnore(chatId, params, userId) {
        const [, email] = params.split(' ');
        if (!email) return telegramService.sendMessage(chatId, 'Type `/ignore add person@email.com`');
        await memoryAgent.updateContactMemory(userId, email, { is_ignored: true });
        await telegramService.sendMessage(chatId, `*${escape(email)}* added to Ignore list.`);
    },

    async handleAway(chatId, hours, userId) {
        const parsed = Number.parseInt(hours, 10);
        const durationHours = Number.isFinite(parsed) ? parsed : 24;
        const until = new Date();
        until.setHours(until.getHours() + durationHours);

        await supabase.from('user_status').upsert({
            user_id: userId,
            status: 'away',
            away_until: until.toISOString()
        });
        await telegramService.sendMessage(chatId, `Away mode enabled for *${escape(durationHours)}* hour(s).`);
    },

    async handleUnknown(chatId) {
        await telegramService.sendMessage(chatId, 'I did not understand that. Type /help to see available commands.');
    },

    async handleSent(chatId, userId) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const { data: emails } = await supabase.from('email_history')
            .select('recipient, subject, sent_at, user_email')
            .eq('user_id', userId)
            .gte('sent_at', today.toISOString())
            .order('sent_at', { ascending: true });

        if (!emails || emails.length === 0) {
            return telegramService.sendMessage(chatId, 'No emails sent today via the assistant.');
        }

        let text = '*Sent Today*\n\n';
        emails.forEach((email) => {
            text += `• [${escape(email.user_email || 'General')}] *To:* ${escape(email.recipient || 'Unknown')}\n`;
            text += `_${escape(email.subject || 'No subject')}_\n\n`;
        });

        await telegramService.sendMessage(chatId, text);
    },

    async handleSearch(chatId, query, userId) {
        if (!query) return telegramService.sendMessage(chatId, 'Type `/search [person or topic]`');
        const { nlHandler } = await import('../agents/nlHandler.js');
        await nlHandler.handleEmailSearch(userId, chatId, { query });
    },

    async handleBack(chatId, userId) {
        await supabase.from('user_status').upsert({ user_id: userId, status: 'active', away_until: null });
        await telegramService.sendMessage(chatId, '*Away mode disabled.*');
    },

    async handlePause(chatId, userId) {
        await supabase.from('user_status').upsert({ user_id: userId, status: 'paused' });
        await telegramService.sendMessage(chatId, '*Auto-sends paused.* I will keep drafting but will not send automatically.');
    },

    async handleResume(chatId, userId) {
        await supabase.from('user_status').upsert({ user_id: userId, status: 'active' });
        await telegramService.sendMessage(chatId, '*Auto-sends resumed.*');
    },

    async handleTone(chatId, tone, userId) {
        if (!['formal', 'casual', 'friendly', 'direct'].includes(tone)) {
            return telegramService.sendMessage(chatId, 'Type `/tone [formal|casual|friendly|direct]`');
        }

        await supabase.from('memory').upsert({ user_id: userId, tone_style: tone });
        await telegramService.sendMessage(chatId, `Tone updated to *${escape(tone)}*.`);
    },

    async handleWhitelist(chatId, args, userId) {
        const [action, domain] = args.split(' ');
        if (!['add', 'remove', 'list'].includes(action)) {
            return telegramService.sendMessage(chatId, 'Type `/whitelist [add|remove|list] [domain]`');
        }

        const mem = await memoryAgent.getMemoryContext(userId);
        let whitelist = mem.whitelist || [];

        if (action === 'list') {
            const listText = whitelist.length > 0 ? whitelist.map((item) => `• ${escape(item)}`).join('\n') : 'No whitelisted domains.';
            return telegramService.sendMessage(chatId, `*Whitelisted Domains*\n\n${listText}`);
        }

        if (!domain || !domain.startsWith('@')) {
            return telegramService.sendMessage(chatId, 'Specify a domain starting with @, for example `@example.com`.');
        }

        if (action === 'add') {
            if (!whitelist.includes(domain)) whitelist.push(domain);
        } else {
            whitelist = whitelist.filter((item) => item !== domain);
        }

        await supabase.from('memory').upsert({ user_id: userId, whitelist });
        await telegramService.sendMessage(chatId, `Domain *${escape(domain)}* ${escape(action)}ed.`);
    },

    async handleUndo(chatId, userId) {
        const { sendAgent } = await import('../agents/send.js');
        await telegramService.sendMessage(chatId, 'Trying to recall the last sent email...');

        const { data: lastEmail } = await supabase.from('email_history')
            .select('message_id, user_email')
            .eq('user_id', userId)
            .order('sent_at', { ascending: false })
            .limit(1)
            .single();

        if (!lastEmail) {
            return telegramService.sendMessage(chatId, 'No recent emails found to undo.');
        }

        const result = await sendAgent.undoSend(userId, lastEmail.message_id, lastEmail.user_email);
        if (result.success) {
            await telegramService.sendMessage(chatId, 'Email moved to trash within Gmail\'s undo window.');
        } else {
            await telegramService.sendMessage(chatId, `Undo failed: ${escape(result.message)}.`);
        }
    },
};
