import { supabase } from '../config/supabase.js';
import { telegramService } from '../services/telegram.js';
import { gmailService } from '../services/gmail.js';
import { memoryAgent } from './memory.js';
import { logger } from '../utils/logger.js';
import { VELOX } from '../config/constants.js';

/**
 * Agent 10 — Mentor Agent
 * Proactive communication analyst. Generates morning digests,
 * system health reports, and weekly summaries. Tracks stalled threads.
 */
export const mentorAgent = {

    /**
     * Dispatcher for all scheduled tasks
     */
    async runScheduledJob(jobName, userId, userEmail = null) {
        logger.info('MentorAgent', 'JobRun', `Running ${jobName} for user ${userId} ${userEmail ? `(${userEmail})` : ''}`);
        switch (jobName) {
        case 'morning_digest': return this.sendMorningDigest(userId);
        case 'system_health': return this.checkSystemHealth(userId);
        case 'doc_expiries': return this.checkDocumentExpiries(userId);
        case 'promo_digest': return this.sendEveningPromoDigest(userId, userEmail);
        case 'weekly_report': return this.sendWeeklyReport(userId);
        case 'spam_rescue': return this.scanSpamFolder(userId, userEmail);
        case 'follow_ups': return this.checkFollowUps(userId);
        case 'tone_drift': return memoryAgent.detectToneDrift(userId, userEmail);
        case 'sender_patterns': return this.detectSenderPatterns(userId, userEmail);
        default: logger.warn('MentorAgent', 'UnknownJob', `Job ${jobName} not recognized`);
        }
    },

    /**
     * Generates the 7 AM morning digest
     */
    async sendMorningDigest(userId) {
        try {
            logger.info('MentorAgent', 'MorningDigest', 'Generating morning digest');

            // 1. Get stats for last 24h
            const twentyFourHoursAgo = new Date();
            twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

            const { count: handledCount } = await supabase.from('email_history')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId)
                .gte('sent_at', twentyFourHoursAgo.toISOString());

            const { data: pending } = await supabase.from('pending_sends')
                .select('*')
                .eq('user_id', userId)
                .eq('status', 'pending');

            const { count: docsCount } = await supabase.from('vault_metadata')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId)
                .gte('created_at', twentyFourHoursAgo.toISOString());

            const { data: user } = await supabase.from('memory')
                .select('user_name')
                .eq('user_id', userId)
                .single();

            const name = user?.user_name || 'there';

            // Build the message
            let text = `☀️ *Good morning, ${name}!*\n\n`;
            text += '*Overnight activity:*\n';
            text += `✅ ${handledCount || 0} emails sent/handled\n`;
            text += `⏳ ${pending?.length || 0} need your attention\n`;
            text += `📎 ${docsCount || 0} documents stored\n\n`;
            text += '━━━━━━━━━━━━━━━━━\n';

            if (pending && pending.length > 0) {
                text += '*Pending Action Required:*\n';
                pending.slice(0, 3).forEach(p => {
                    text += `🟡 *${p.email_to}* — ${p.subject}\n`;
                });
                if (pending.length > 3) text += `_...and ${pending.length - 3} more_\n`;
            } else {
                text += '_Your inbox is entirely clear._\n';
            }

            const { data: userRec } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
            if (userRec?.telegram_chat_id) {
                await telegramService.sendWithButtons(userRec.telegram_chat_id, text, [
                    [{ text: '📋 See Inbox', callback_data: 'view_inbox' }, { text: '✅ Handle Routine', callback_data: 'handle_routine' }]
                ]);
            }
        } catch (err) {
            logger.error('MentorAgent', 'DigestFail', 'Failed to generate morning digest', err);
        }
    },

    /**
     * Generates daily 8 AM system health
     */
    async checkSystemHealth(userId) {
        try {
            logger.info('MentorAgent', 'SystemHealth', `Generating health report for user ${userId}`);

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            // 1. Get API Usage (Gemini)
            const { count: apiCalls } = await supabase
                .from('api_usage')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId)
                .eq('provider', 'gemini')
                .gte('timestamp', today.toISOString());

            // 2. Get Vault Storage Usage
            const { data: vaultDocs } = await supabase
                .from('vault_metadata')
                .select('size_kb')
                .eq('user_id', userId);

            const totalSizeKB = vaultDocs?.reduce((sum, d) => sum + (d.size_kb || 0), 0) || 0;
            const sizeMB = (totalSizeKB / 1024).toFixed(2);

            // 3. Get Processed Emails today
            const { count: emailCount } = await supabase
                .from('processed_emails')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId)
                .gte('locked_at', today.toISOString());

            const uptimeDays = Math.floor(process.uptime() / 86400);

            let text = '🩺 *Velox System Health*\n\n';
            text += `Version: v${VELOX.VERSION}\n`;
            text += `Uptime: ${uptimeDays} days\n`;
            text += `Status: ${apiCalls > 1400 ? '🟡 Near Limit' : '🟢 Optimal'}\n\n`;
            text += `🔹 *API Usage (Gemini):* ${apiCalls || 0}/1500\n`;
            text += `🔹 *Vault Storage:* ${sizeMB} MB\n`;
            text += `🔹 *Emails Today:* ${emailCount || 0}\n\n`;
            text += '_All agents are online._';

            const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
            if (user?.telegram_chat_id) {
                await telegramService.sendMessage(user.telegram_chat_id, text);
            }
        } catch (err) {
            logger.error('MentorAgent', 'HealthFail', 'Failed to generate health report', err);
        }
    },

    /**
     * Weekly Monday 9 AM report
     */
    async sendWeeklyReport(userId) {
        try {
            logger.info('MentorAgent', 'WeeklyReport', 'Generating weekly report');

            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            const { data: history } = await supabase.from('email_history')
                .select('*')
                .eq('user_id', userId)
                .gte('sent_at', sevenDaysAgo.toISOString());

            const handledCount = history?.length || 0;
            const automatedCount = history?.filter(h => h.autonomy_level === 2).length || 0;
            const autoPercent = handledCount ? Math.round((automatedCount / handledCount) * 100) : 0;

            let text = '📊 *Your week in email*\n\n';
            text += `Handled: ${handledCount} emails\n`;
            text += `Fully automated: ${automatedCount} (${autoPercent}%)\n\n`;
            text += '━━━━━━━━━━━━━━━━━\n';
            text += '💡 *Suggestions:*\n';
            if (autoPercent < 30) {
                text += '_Try whitelisting more categories to improve automation._\n';
            } else {
                text += '_Great automation rate! Keep adding to your whitelist._\n';
            }

            const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
            if (user?.telegram_chat_id) {
                await telegramService.sendMessage(user.telegram_chat_id, text);
            }
        } catch (err) {
            logger.error('MentorAgent', 'WeeklyReportFail', 'Failed to generate weekly report', err);
        }
    },

    /**
     * Daily 8 AM check for expiring documents
     */
    async checkDocumentExpiries(userId) {
        try {
            const target = new Date();
            target.setDate(target.getDate() + 3);
            const { data } = await supabase
                .from('vault_metadata')
                .select('*')
                .eq('user_id', userId)
                .lte('expires_at', target.toISOString());

            if (data?.length) {
                const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
                if (user?.telegram_chat_id) {
                    const list = data.map(d => `- ${d.original_filename} (${d.doc_type})`).join('\n');
                    await telegramService.sendMessage(user.telegram_chat_id,
                        `⚠️ *Document Expiry Warning*\n\nThe following documents expire in 3 days:\n\n${list}\n\n_Review them in your /vault._`
                    );
                }
            }
        } catch (err) {
            logger.error('MentorAgent', 'ExpiryCheckFail', 'Failed to check expiries', err);
        }
    },

    /**
     * 6 PM — Evening Promo Digest
     */
    async sendEveningPromoDigest(userId, userEmail) {
        try {
            const promos = await gmailService.listMessages(userId, 'category:promotions', 15, userEmail);
            if (!promos || promos.length === 0) return;

            const scoredPromos = [];
            const mem = await memoryAgent.getCoreMemory(userId);

            for (const msg of promos) {
                const detail = await gmailService.getMessage(userId, msg.id, userEmail);
                const score = this.scorePromoValue(detail, mem);
                if (score > 30) {
                    scoredPromos.push({
                        subject: detail.subject,
                        from: detail.fromName || detail.from,
                        score
                    });
                }
            }

            if (scoredPromos.length === 0) return;

            scoredPromos.sort((a, b) => b.score - a.score);
            const top = scoredPromos.slice(0, 3);

            let text = '🛍️ *Evening Promo Digest*\n_High-value offers only_\n\n';
            top.forEach(p => {
                text += `🔥 *${p.from}* — ${p.subject}\n`;
            });

            const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
            if (user?.telegram_chat_id) {
                await telegramService.sendMessage(user.telegram_chat_id, text);
            }
        } catch (err) {
            logger.error('MentorAgent', 'PromoDigestFail', 'Failed to generate promo digest', err);
        }
    },

    /**
     * Every 30 min — Scan spam for rescue
     */
    async scanSpamFolder(userId, userEmail) {
        try {
            const spam = await gmailService.listMessages(userId, 'label:spam', 10, userEmail);
            if (!spam || spam.length === 0) return;

            const mem = await memoryAgent.getCoreMemory(userId);

            for (const msg of spam) {
                const detail = await gmailService.getMessage(userId, msg.id, userEmail);
                const score = await this.calculateRescueScore(detail, userId, mem);

                if (score >= 70) {
                    logger.info('MentorAgent', 'SpamRescue', `Rescuing email ${msg.id} with score ${score}`);
                    await gmailService.modifyLabels(userId, msg.id, ['INBOX'], ['SPAM'], userEmail);

                    const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
                    if (user?.telegram_chat_id) {
                        await telegramService.sendMessage(user.telegram_chat_id,
                            `🚨 *Spam Rescue!*\n\nI found a valuable email from *${detail.from}* in your spam folder and moved it to your inbox.\n\n*Subject:* ${detail.subject}`);
                    }
                }
            }
        } catch (err) {
            logger.error('MentorAgent', 'SpamRescueFail', 'Failed to scan spam folder', err);
        }
    },

    /**
     * Every 60 min — Check for stalled follow ups
     */
    async checkFollowUps(userId) {
        try {
            const { data: dueFollowUps } = await supabase.from('follow_ups')
                .select('*')
                .eq('user_id', userId)
                .eq('status', 'pending')
                .lte('follow_up_at', new Date().toISOString());

            if (!dueFollowUps || dueFollowUps.length === 0) return;

            for (const item of dueFollowUps) {
                const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
                if (user?.telegram_chat_id) {
                    await telegramService.sendMessage(user.telegram_chat_id,
                        `⏳ *No reply received:*\n\nTo: ${item.recipient}\nSubject: ${item.subject}\n\nIt has been several days. Should I send a follow-up?`,
                        { reply_markup: { inline_keyboard: [[{ text: '✏️ Yes, draft follow-up', callback_data: `followup_${item.id}` }, { text: '❌ No', callback_data: `dismiss_fw_${item.id}` }]] } }
                    );

                    await supabase.from('follow_ups').update({ reminder_sent: true, status: 'reminded' }).eq('id', item.id);
                }
            }
        } catch (err) {
            logger.error('MentorAgent', 'FollowUpCheckFail', 'Failed to check follow ups', err);
        }
    },

    /**
     * Scoring logic for spam rescue
     */
    async calculateRescueScore(email, userId, _memory) {
        let score = 0;
        const from = email.from?.toLowerCase() || '';
        const body = (email.body || email.snippet || '').toLowerCase();

        // 1. Known Domain check
        const domain = from.split('@')[1];
        if (domain && !['gmail.com', 'outlook.com', 'yahoo.com'].includes(domain)) {
            score += 60;
        }

        // 2. Replied-to check (Check history)
        const { count } = await supabase.from('email_history')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('recipient', from);
        if (count > 0) score += 70;

        // 3. VIP Check
        const contact = await memoryAgent.getContactMemory(userId, from);
        if (contact?.is_vip) score += 80;

        // 4. Content signals
        const highValueKeywords = ['invoice', 'receipt', 'contract', 'approved', 'meeting', 'zoom', 'google.com/calendar'];
        if (highValueKeywords.some(k => body.includes(k))) score += 35;

        return score;
    },

    /**
     * Scoring logic for promos
     */
    scorePromoValue(email, memory) {
        let score = 0;
        const body = (email.body || email.snippet || '').toLowerCase();
        const from = email.from?.toLowerCase() || '';

        // 1. Purchased from (if in phrase bank or common patterns)
        if (memory.phrase_bank?.some(p => from.includes(p.toLowerCase()))) score += 40;

        // 2. Discount signals
        if (body.includes('30%') || body.includes('40%') || body.includes('50%') || body.includes('off')) score += 30;

        // 3. Expiry signals
        if (body.includes('expires') || body.includes('today only') || body.includes('hours left')) score += 25;

        return score;
    },

    /**
     * Weekly — Find consistent senders
     */
    async detectSenderPatterns(userId, userEmail) {
        try {
            const monthAgo = new Date();
            monthAgo.setDate(monthAgo.getDate() - 30);

            const { data: history } = await supabase.from('email_history')
                .select('recipient, sent_at')
                .eq('user_id', userId)
                .eq('user_email', userEmail)
                .gte('sent_at', monthAgo.toISOString());

            if (!history || history.length < 10) return;

            // Simple frequency map
            const map = {};
            history.forEach(h => {
                map[h.recipient] = (map[h.recipient] || 0) + 1;
            });

            const topSenders = Object.entries(map)
                .filter(([, count]) => count >= 4)
                .map(([email]) => email);

            if (topSenders.length > 0) {
                const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
                if (user?.telegram_chat_id) {
                    const list = topSenders.map(s => `- ${s}`).join('\n');
                    await telegramService.sendMessage(user.telegram_chat_id,
                        `💡 *Pattern Detected*\n\nYou communicate frequently with these senders:\n\n${list}\n\nWould you like me to draft template suggestions for them?`
                    );
                }
            }
        } catch (err) {
            logger.error('MentorAgent', 'PatternDetectFail', 'Failed to detect patterns', err);
        }
    }
};
