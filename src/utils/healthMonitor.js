import { supabase } from '../config/supabase.js';
import { telegramService } from '../services/telegram.js';
import { logger } from '../utils/logger.js';

/**
 * Velox — System Health Monitor
 * RAM monitoring, nightly cleanup, and Supabase keep-alive.
 */
export const healthMonitor = {

    /**
     * Check RAM usage — warn at 70%, restart at 85%
     * Called every 5 minutes by scheduler
     */
    async checkRAM() {
        try {
            const used = process.memoryUsage();
            const ramMB = Math.round(used.heapUsed / 1024 / 1024);
            const maxMB = 512;
            const percent = Math.round((ramMB / maxMB) * 100);

            if (percent > 85) {
                logger.error('HealthMonitor', 'RAM', `CRITICAL: RAM at ${percent}% (${ramMB}MB/${maxMB}MB) — restarting`);
                await this.alertAllAdmins(`🚨 *RAM Critical — ${percent}%*\n\nRestarting gracefully...`);
                // Allow message to send before exiting
                setTimeout(() => process.exit(1), 2000);
            } else if (percent > 70) {
                logger.warn('HealthMonitor', 'RAM', `WARNING: RAM at ${percent}% (${ramMB}MB/${maxMB}MB) — clearing cache`);
                await this.alertAllAdmins(`⚠️ *RAM Warning — ${percent}%*\n\n${ramMB}MB used. Clearing cache.`);

                // Force garbage collection if available
                if (global.gc) {
                    global.gc();
                    logger.info('HealthMonitor', 'GC', 'Forced garbage collection');
                }
            }
        } catch (err) {
            logger.error('HealthMonitor', 'RAMCheck', 'Failed to check RAM', err);
        }
    },

    /**
     * Check Database Storage usage — warn at 70%, auto-cleanup at 80%
     * Requires Supabase RPC `get_db_size`
     */
    async checkStorage() {
        try {
            const { data: dbBytes, error } = await supabase.rpc('get_db_size');
            if (error || !dbBytes) return; // Skip if RPC is missing

            const dbMB = Math.round(dbBytes / 1024 / 1024);
            const maxMB = 500; // Supabase free tier limit
            const percent = Math.round((dbMB / maxMB) * 100);

            if (percent > 80) {
                logger.warn('HealthMonitor', 'Storage', `CRITICAL: DB Size ${percent}% (${dbMB}MB) — force cleaning`);
                await this.alertAllAdmins(`⚠️ *Storage Critical — ${percent}%*\n\nDB is at ${dbMB}MB. Running emergency cleanup...`);
                await this.nightlyCleanup();
            } else if (percent > 70) {
                logger.warn('HealthMonitor', 'Storage', `WARNING: DB Size ${percent}% (${dbMB}MB)`);
                await this.alertAllAdmins(`⚠️ *Storage Warning — ${percent}%*\n\n${dbMB}MB / ${maxMB}MB used.`);
            }
        } catch (err) {
            logger.error('HealthMonitor', 'StorageCheck', 'Failed to check DB size', err);
        }
    },

    /**
     * Nightly cleanup — runs at 2 AM
     * Purge old processed email locks, expired vault files
     */
    async nightlyCleanup() {
        try {
            logger.info('HealthMonitor', 'Cleanup', 'Starting nightly cleanup...');
            let cleaned = 0;

            // 1. Delete processed email locks older than 30 days
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

            const { count: lockCount } = await supabase
                .from('processed_emails')
                .delete({ count: 'exact' })
                .eq('status', 'done')
                .lt('locked_at', thirtyDaysAgo.toISOString());

            cleaned += lockCount || 0;

            // 2. Delete expired vault files (keep metadata)
            const { data: expiredFiles } = await supabase
                .from('vault_metadata')
                .select('id, file_path')
                .not('expires_at', 'is', null)
                .lt('expires_at', new Date().toISOString())
                .not('file_path', 'is', null);

            if (expiredFiles && expiredFiles.length > 0) {
                for (const f of expiredFiles) {
                    try {
                        await supabase.storage.from('vault').remove([f.file_path]);
                        await supabase.from('vault_metadata')
                            .update({ file_path: null })
                            .eq('id', f.id);
                        cleaned++;
                    } catch (e) {
                        logger.error('HealthMonitor', 'CleanupFile', `Failed to clean ${f.file_path}`, e);
                    }
                }
            }

            // 3. Clean old API usage records (> 7 days)
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            const { count: apiCount } = await supabase
                .from('api_usage')
                .delete({ count: 'exact' })
                .lt('timestamp', sevenDaysAgo.toISOString());

            cleaned += apiCount || 0;

            logger.info('HealthMonitor', 'Cleanup', `Nightly cleanup done. ${cleaned} items cleaned.`);
        } catch (err) {
            logger.error('HealthMonitor', 'Cleanup', 'Nightly cleanup failed', err);
        }
    },

    /**
     * Supabase keep-alive ping — prevents free-tier pausing
     * Call every 3 days
     */
    async keepSupabaseAlive() {
        try {
            await supabase.from('users').select('id').limit(1);
            logger.debug('HealthMonitor', 'KeepAlive', 'Supabase ping successful');
        } catch (err) {
            logger.error('HealthMonitor', 'KeepAlive', 'Supabase ping failed', err);
        }
    },

    /**
     * Alert all users with admin-level notifications
     */
    async alertAllAdmins(message) {
        try {
            const { data: users } = await supabase.from('users').select('telegram_chat_id');
            if (!users) return;

            for (const u of users) {
                if (u.telegram_chat_id) {
                    try {
                        await telegramService.sendMessage(u.telegram_chat_id, message);
                    } catch {
                        // Skip individual failures
                    }
                }
            }
        } catch (err) {
            logger.error('HealthMonitor', 'Alert', 'Failed to send admin alerts', err);
        }
    },
};
