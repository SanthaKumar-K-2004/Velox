import { mentorAgent } from '../agents/mentor.js';
import { autonomyAgent } from '../agents/autonomy.js';
import { supabase } from '../config/supabase.js';
import { logger } from './logger.js';
import { healthMonitor } from './healthMonitor.js';
import { gmailService } from '../services/gmail.js';

/**
 * Velox — Background Scheduler
 * Runs periodic background tasks without needing external cron daemons.
 */
export const scheduler = {
    timers: [],

    start() {
        logger.info('Scheduler', 'Init', 'Starting background jobs (Multi-User Mode)...');

        // 1-Minute Cron: Process pending autonomously scheduled sends
        this.timers.push(setInterval(async () => {
            try {
                await autonomyAgent.checkPendingSends();
            } catch (err) {
                logger.error('Scheduler', 'PendingSends', 'Failed to check pending sends', err);
            }
        }, 60 * 1000));

        // 30-Minute Cron: Spam Rescue (Per Account)
        this.timers.push(setInterval(async () => {
            await this.runForAllAccounts(async (userId, userEmail) => {
                await mentorAgent.runScheduledJob('spam_rescue', userId, userEmail);
            });
        }, 30 * 60 * 1000));

        // 60-Minute Cron: Follow Up Check
        this.timers.push(setInterval(async () => {
            await this.runForAllUsers(async (userId) => {
                await mentorAgent.runScheduledJob('follow_ups', userId);
            });
        }, 60 * 60 * 1000));

        // Time-based crons (Checks every minute)
        this.timers.push(setInterval(async () => {
            const now = new Date();
            const hours = now.getHours();
            const minutes = now.getMinutes();

            await this.runForAllUsers(async (userId) => {
                // 7:00 AM — Morning Digest
                if (hours === 7 && minutes === 0) {
                    await mentorAgent.runScheduledJob('morning_digest', userId);
                }

                // 8:00 AM — System Health & Expiries
                if (hours === 8 && minutes === 0) {
                    await mentorAgent.runScheduledJob('system_health', userId);
                    await mentorAgent.runScheduledJob('doc_expiries', userId);
                }

                // 6:00 PM (18:00) — Evening Promo Digest (Per Account)
                if (hours === 18 && minutes === 0) {
                    await this.runForAllAccounts(async (uId, uEmail) => {
                        if (uId === userId) { // Run only for accounts of this specific user in this iteration
                            await mentorAgent.runScheduledJob('promo_digest', uId, uEmail);
                        }
                    });
                }

                // Monday 9:00 AM — Weekly Report & Tone Drift Check & Pattern Detection
                if (now.getDay() === 1 && hours === 9 && minutes === 0) {
                    await mentorAgent.runScheduledJob('weekly_report', userId);

                    await this.runForAllAccounts(async (uId, uEmail) => {
                        if (uId === userId) {
                            await mentorAgent.runScheduledJob('tone_drift', uId, uEmail);
                            await mentorAgent.runScheduledJob('sender_patterns', uId, uEmail);
                        }
                    });
                }
            });

            // 2:00 AM — Nightly System Cleanup & API Renewals
            if (hours === 2 && minutes === 0) {
                await healthMonitor.nightlyCleanup();
                await healthMonitor.checkStorage();

                // Renew Google Cloud Pub/Sub tokens (they expire every 7 days)
                if (process.env.GMAIL_PUBSUB_TOPIC) {
                    await this.runForAllAccounts(async (uId, uEmail) => {
                        try {
                            await gmailService.watchAccount(uId, uEmail);
                        } catch (e) {
                            logger.error('Scheduler', 'WatchRenew', `Failed to renew push token for ${uEmail}`, e);
                        }
                    });
                }
            }
        }, 60 * 1000));

        // 5-Minute Cron: RAM Usage Monitor
        this.timers.push(setInterval(async () => {
            await healthMonitor.checkRAM();
        }, 5 * 60 * 1000));
    },

    /**
     * Helper to run a task for all registered users
     */
    async runForAllUsers(taskFn) {
        try {
            const { data: users, error } = await supabase.from('users').select('id');
            if (error) throw error;
            if (!users) return;

            for (const user of users) {
                try {
                    await taskFn(user.id);
                } catch (e) {
                    logger.error('Scheduler', 'UserTask', `Failed for user ${user.id}`, e);
                }
            }
        } catch (err) {
            logger.error('Scheduler', 'FetchUsers', 'Failed to fetch users for cron', err);
        }
    },

    /**
     * Helper to run a task for all connected accounts
     */
    async runForAllAccounts(taskFn) {
        try {
            const { data: accounts, error } = await supabase.from('user_accounts').select('user_id, email');
            if (error) throw error;
            if (!accounts) return;

            for (const acc of accounts) {
                try {
                    await taskFn(acc.user_id, acc.email);
                } catch (e) {
                    logger.error('Scheduler', 'AccountTask', `Failed for account ${acc.email}`, e);
                }
            }
        } catch (err) {
            logger.error('Scheduler', 'FetchAccounts', 'Failed to fetch accounts for cron', err);
        }
    },

    stop() {
        this.timers.forEach(clearInterval);
        this.timers = [];
        logger.info('Scheduler', 'Shutdown', 'Background jobs stopped.');
    }
};
