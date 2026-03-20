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
 * Velox — Telegram Command Handlers (Enterprise Edition)
 */
export const telegramCommands = {

    async handleStart(chatId) {
        try {
            let { data: user } = await supabase
                .from('users')
                .select('id, onboarding_status')
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

            const connectUrl = getConnectUrl(user.id);

            const text =
                '👋 *Welcome to Velox*\n\n' +
                'Your AI Email Copilot is ready. Connect your Gmail to get started.\n\n' +
                'Once connected, I\'ll analyze your writing style and we can finish the setup.';

            // Use inline URL button — always clickable, enterprise-grade UX
            await telegramService.sendWithButtons(chatId, text, [
                [{ text: '🔗 Connect Gmail', url: connectUrl }],
                [{ text: '📖 View Commands', callback_data: 'show_help' }],
            ]);
        } catch (err) {
            logger.error('Telegram', 'StartFail', 'Failed to handle /start', err);
            await telegramService.sendMessage(chatId, '⚠️ Registration failed. Please try again later.');
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
            '⚡ *Velox Command Center*\n\n' +
            '━━━━━━━━━━━━━━━━━━━━\n' +
            '📬  /inbox — Emails needing attention\n' +
            '📝  /pending — Drafts queued for review\n' +
            '🗄  /vault — Recent stored documents\n' +
            '🔍  /find \\[text] — Search stored docs\n' +
            '🔎  /search \\[text] — Search sent emails\n' +
            '📊  /status — System health dashboard\n' +
            '━━━━━━━━━━━━━━━━━━━━\n' +
            '✈️  /away \\[hours] — Enable away mode\n' +
            '▶️  /resume — Resume auto-sends\n' +
            '⏸  /pause — Pause auto-sends\n' +
            '↩️  /undo — Recall last sent email\n' +
            '━━━━━━━━━━━━━━━━━━━━\n' +
            '⭐  /vip add \\[email] — Mark VIP contact\n' +
            '🚫  /ignore add \\[email] — Silence sender\n' +
            '🎨  /tone \\[style] — Update writing style\n' +
            '━━━━━━━━━━━━━━━━━━━━\n\n' +
            '_Tip: You can also type naturally — I\'ll understand._';

        await telegramService.sendMessage(chatId, text);
    },

    async handleStatus(chatId, dataOnly = false) {
        try {
            const userId = await this.resolveUser(chatId);
            if (!userId) {
                if (dataOnly) return { error: 'user_not_registered' };
                return telegramService.sendMessage(chatId, '⚠️ Please type /start to register first.');
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
            const apiUsed = apiCalls || 0;
            const apiLimit = 1500;
            const apiPct = Math.round((apiUsed / apiLimit) * 100);
            const statusEmoji = apiUsed > 1400 ? '🟡' : '🟢';

            const statusData = {
                status: apiUsed > 1400 ? 'Near Limit' : 'Optimal',
                uptime: `${uptimeHrs}h ${uptimeMins % 60}m`,
                emails_today: emailCount || 0,
                api_usage: `${apiUsed}/${apiLimit}`,
                vault_size_mb: (totalSizeKB / 1024).toFixed(2),
                version: VELOX.VERSION
            };

            if (dataOnly) return statusData;

            const progressBar = buildProgressBar(apiPct);

            const text =
                '📊 *System Health Dashboard*\n\n' +
                `${statusEmoji} Status: *${escape(statusData.status)}*\n` +
                `⏱ Uptime: ${escape(statusData.uptime)}\n` +
                `📧 Emails today: *${statusData.emails_today}*\n` +
                `🤖 API usage: ${escape(statusData.api_usage)} (${apiPct}%)\n` +
                `${progressBar}\n` +
                `🗄 Vault: ${escape(statusData.vault_size_mb)} MB\n\n` +
                `_Velox v${escape(statusData.version)}_`;

            await telegramService.sendWithButtons(chatId, text, [
                [{ text: '🔄 Refresh', callback_data: 'refresh_status' }],
            ]);
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
            const text =
                '✅ *Inbox Clear*\n\n' +
                '_No emails need your attention right now. I\'ll notify you when something arrives._';
            await telegramService.sendWithButtons(chatId, text, [
                [{ text: '🔄 Refresh Inbox', callback_data: 'view_inbox' }],
            ]);
            return;
        }

        let text = `📬 *${pending.length} Email${pending.length > 1 ? 's' : ''} Need Attention*\n\n`;
        pending.forEach((email, index) => {
            const account = email.user_email ? email.user_email.split('@')[0] : 'General';
            text += `${numberEmoji(index + 1)} \\[${escape(account)}] \`${escape(email.message_id?.substring(0, 12))}…\` — _${escape(email.status)}_\n`;
        });
        text += '\n_Tap an email notification to take action._';

        await telegramService.sendWithButtons(chatId, text, [
            [{ text: '🔄 Refresh', callback_data: 'view_inbox' }],
        ]);
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
            const text =
                '✅ *No Pending Drafts*\n\n' +
                '_Your outbox is empty. All drafts have been sent or dismissed._';
            await telegramService.sendMessage(chatId, text);
            return;
        }

        let text = `📝 *${drafts.length} Draft${drafts.length > 1 ? 's' : ''} Pending Review*\n\n`;
        drafts.forEach((draft, index) => {
            const account = draft.user_email ? draft.user_email.split('@')[0] : 'General';
            text += `${numberEmoji(index + 1)} \\[${escape(account)}]\n`;
            text += `    → *To:* ${escape(draft.email_to)}\n`;
            text += `    _${escape(draft.subject || 'No subject')}_\n\n`;
        });

        await telegramService.sendWithButtons(chatId, text, [
            [
                { text: '✅ Send All', callback_data: 'send_all_pending' },
                { text: '🔄 Refresh', callback_data: 'handle_routine' },
            ],
        ]);
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
            const text =
                '🗄 *Vault is Empty*\n\n' +
                '_Send me a document or image and I\'ll analyze and store it for you._';
            await telegramService.sendMessage(chatId, text);
            return;
        }

        let text = '🗄 *Recent Documents*\n\n';
        docs.forEach((doc) => {
            text += `📄 *${escape(doc.vendor || 'Unknown')}* — ${escape(doc.doc_type || 'document')}\n`;
            text += `    _${escape(doc.summary || 'No summary available')}_\n\n`;
        });

        await telegramService.sendMessage(chatId, text);
    },

    async handleFind(chatId, query, userId) {
        if (!query) {
            return telegramService.sendMessage(chatId, '🔍 Type `/find [what you are looking for]`');
        }

        await telegramService.sendMessage(chatId, `🔍 Searching vault for _${escape(query)}_...`);
        const docs = await vaultAgent.findDocument(userId, query);

        if (!docs || docs.length === 0) {
            return telegramService.sendMessage(chatId, `❌ No documents matched _${escape(query)}_.`);
        }

        let text = `🔍 *Search Results for "${escape(query)}"*\n\n`;
        docs.forEach((doc) => {
            text += `📄 *${escape(doc.vendor || 'Unknown')}* — ${escape(doc.doc_type || 'document')}\n`;
            text += `    _${escape(doc.summary || 'No summary available')}_\n\n`;
        });
        await telegramService.sendMessage(chatId, text);
    },

    async handleVip(chatId, params, userId) {
        const [, email] = params.split(' ');
        if (!email) return telegramService.sendMessage(chatId, '⭐ Type `/vip add person@email.com`');
        await memoryAgent.updateContactMemory(userId, email, { is_vip: true });
        await telegramService.sendMessage(chatId, `⭐ *${escape(email)}* added to VIP list.\n_Emails from this contact will be prioritized._`);
    },

    async handleIgnore(chatId, params, userId) {
        const [, email] = params.split(' ');
        if (!email) return telegramService.sendMessage(chatId, '🚫 Type `/ignore add person@email.com`');
        await memoryAgent.updateContactMemory(userId, email, { is_ignored: true });
        await telegramService.sendMessage(chatId, `🚫 *${escape(email)}* added to Ignore list.\n_Emails from this sender will be auto-dismissed._`);
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
        await telegramService.sendMessage(
            chatId,
            '✈️ *Away Mode Enabled*\n\n' +
            `Duration: *${durationHours}* hour(s)\n` +
            `Returns: _${escape(until.toLocaleString())}_\n\n` +
            '_I\'ll hold your drafts and send holding replies to urgent emails._'
        );
    },

    async handleUnknown(chatId) {
        await telegramService.sendWithButtons(chatId,
            '🤔 I didn\'t understand that command.\n\n_Try typing naturally or tap below for help._',
            [[{ text: '📖 View Commands', callback_data: 'show_help' }]]
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

        if (!emails || emails.length === 0) {
            return telegramService.sendMessage(chatId, '📤 *No Emails Sent Today*\n\n_Nothing has been sent via the assistant yet today._');
        }

        let text = `📤 *Sent Today — ${emails.length} email${emails.length > 1 ? 's' : ''}*\n\n`;
        emails.forEach((email, index) => {
            const account = email.user_email ? email.user_email.split('@')[0] : 'General';
            text += `${numberEmoji(index + 1)} \\[${escape(account)}]\n`;
            text += `    → *To:* ${escape(email.recipient || 'Unknown')}\n`;
            text += `    _${escape(email.subject || 'No subject')}_\n\n`;
        });

        await telegramService.sendMessage(chatId, text);
    },

    async handleSearch(chatId, query, userId) {
        if (!query) return telegramService.sendMessage(chatId, '🔎 Type `/search [person or topic]`');
        const { nlHandler } = await import('../agents/nlHandler.js');
        await nlHandler.handleEmailSearch(userId, chatId, { query });
    },

    async handleBack(chatId, userId) {
        await supabase.from('user_status').upsert({ user_id: userId, status: 'active', away_until: null });
        await telegramService.sendMessage(chatId, '▶️ *Away Mode Disabled*\n\n_Welcome back! I\'m resuming normal operations._');
    },

    async handlePause(chatId, userId) {
        await supabase.from('user_status').upsert({ user_id: userId, status: 'paused' });
        await telegramService.sendMessage(
            chatId,
            '⏸ *Auto-Sends Paused*\n\n' +
            '_I\'ll keep drafting replies, but nothing will be sent automatically until you resume._'
        );
    },

    async handleResume(chatId, userId) {
        await supabase.from('user_status').upsert({ user_id: userId, status: 'active' });
        await telegramService.sendMessage(chatId, '▶️ *Auto-Sends Resumed*\n\n_I\'m back to full autonomous mode._');
    },

    async handleTone(chatId, tone, userId) {
        if (!['formal', 'casual', 'friendly', 'direct'].includes(tone)) {
            return telegramService.sendWithButtons(chatId,
                '🎨 *Select Your Writing Style*\n\n_Choose the tone I should use when drafting emails:_',
                [
                    [
                        { text: '🎩 Formal', callback_data: 'set_tone_formal' },
                        { text: '😊 Casual', callback_data: 'set_tone_casual' },
                    ],
                    [
                        { text: '🤝 Friendly', callback_data: 'set_tone_friendly' },
                        { text: '🎯 Direct', callback_data: 'set_tone_direct' },
                    ],
                ]
            );
        }

        const toneEmoji = { formal: '🎩', casual: '😊', friendly: '🤝', direct: '🎯' };
        await supabase.from('memory').upsert({ user_id: userId, tone_style: tone });
        await telegramService.sendMessage(
            chatId,
            `${toneEmoji[tone] || '🎨'} *Tone Updated to ${escape(tone.charAt(0).toUpperCase() + tone.slice(1))}*\n\n` +
            '_All future drafts will reflect this style._'
        );
    },

    async handleWhitelist(chatId, args, userId) {
        const [action, domain] = args.split(' ');
        if (!['add', 'remove', 'list'].includes(action)) {
            return telegramService.sendMessage(chatId, '🛡 Type `/whitelist [add|remove|list] [domain]`');
        }

        const mem = await memoryAgent.getMemoryContext(userId);
        let whitelist = mem.whitelist || [];

        if (action === 'list') {
            const listText = whitelist.length > 0
                ? whitelist.map((item) => `  ✅ ${escape(item)}`).join('\n')
                : '_No whitelisted domains yet._';
            return telegramService.sendMessage(chatId, `🛡 *Whitelisted Domains*\n\n${listText}`);
        }

        if (!domain || !domain.startsWith('@')) {
            return telegramService.sendMessage(chatId, '⚠️ Specify a domain starting with @, for example `@example.com`.');
        }

        if (action === 'add') {
            if (!whitelist.includes(domain)) whitelist.push(domain);
        } else {
            whitelist = whitelist.filter((item) => item !== domain);
        }

        await supabase.from('memory').upsert({ user_id: userId, whitelist });
        const verb = action === 'add' ? 'added to' : 'removed from';
        await telegramService.sendMessage(chatId, `🛡 *${escape(domain)}* ${verb} whitelist.`);
    },

    async handleUndo(chatId, userId) {
        const { sendAgent } = await import('../agents/send.js');
        await telegramService.sendMessage(chatId, '↩️ Attempting to recall the last sent email...');

        const { data: lastEmail } = await supabase.from('email_history')
            .select('message_id, user_email')
            .eq('user_id', userId)
            .order('sent_at', { ascending: false })
            .limit(1)
            .single();

        if (!lastEmail) {
            return telegramService.sendMessage(chatId, '❌ No recent emails found to undo.');
        }

        const result = await sendAgent.undoSend(userId, lastEmail.message_id, lastEmail.user_email);
        if (result.success) {
            await telegramService.sendMessage(chatId, '✅ *Email Recalled*\n\n_The email was moved to trash within Gmail\'s undo window._');
        } else {
            await telegramService.sendMessage(chatId, `❌ *Undo Failed*\n\n_${escape(result.message)}_`);
        }
    },
};

// ─── Helpers ────────────────────────────────────────

function numberEmoji(n) {
    const emojis = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    return emojis[n] || `${n}.`;
}

function buildProgressBar(pct) {
    const filled = Math.round(pct / 10);
    const empty = 10 - filled;
    return '`[' + '█'.repeat(filled) + '░'.repeat(empty) + ']`';
}
