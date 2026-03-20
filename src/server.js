import app from './server/app.js';
import { env } from './config/env.js';
import { supabase } from './config/supabase.js';
import { logger } from './utils/logger.js';
import { VELOX } from './config/constants.js';
import { scheduler } from './utils/scheduler.js';
import { telegramService } from './services/telegram.js';
import { handleUpdate } from './server/telegram.js';

async function startServer() {
    /* eslint-disable no-console */
    console.log('');
    console.log('  ⚡ V E L O X — AI Email Agent');
    console.log(`  ─── v${VELOX.VERSION} ───────────────────`);
    console.log('');

    try {
        // 1. Verify DB Connection
        const { data: _data, error } = await supabase.from('users').select('id').limit(1);
        if (error) {
            logger.error('Velox', 'Startup', `Failed to connect to Supabase: ${error.message}`);
            process.exit(1);
        }
        logger.info('Velox', 'Startup', 'Connected to Supabase');

        // 2. Start Express Server
        app.listen(env.port, () => {
            logger.info('Velox', 'Startup', `Server running on port ${env.port} [${env.nodeEnv}]`);
            logger.info('Velox', 'Startup', `Webhook: http://localhost:${env.port}/webhook/email`);
            logger.info('Velox', 'Startup', `Health:  http://localhost:${env.port}/health`);
            console.log('');
            console.log('  ✓ Velox is ready.');
            console.log('');
            /* eslint-enable no-console */
        });

        // 3. Initialize background jobs
        scheduler.start();

        // 4. Telegram — polling (dev) vs webhook (production)
        if (telegramService.isPolling()) {
            // Development: the bot is already polling via node-telegram-bot-api.
            // Register event listeners that feed updates into the same handleUpdate() logic.
            const bot = telegramService.getBot();

            bot.on('message', (msg) => {
                handleUpdate({ message: msg }).catch((err) => {
                    logger.error('Telegram', 'PollingMessage', 'Failed to process message', err);
                });
            });

            bot.on('callback_query', (query) => {
                handleUpdate({ callback_query: query }).catch((err) => {
                    logger.error('Telegram', 'PollingCallback', 'Failed to process callback', err);
                });
            });

            bot.on('polling_error', (err) => {
                logger.error('Telegram', 'Polling', 'Polling error', err);
            });

            logger.info('Velox', 'Startup', 'Telegram bot running in POLLING mode (development)');
        } else {
            // Production: Webhook mode
            const externalUrl = process.env.PUBLIC_URL || process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://velox-f2uy.onrender.com';
            const webhookUrl = `${externalUrl.replace(/\/$/, '')}/webhook/telegram/${env.telegramBotToken}`;
            await telegramService.getBot().setWebHook(webhookUrl);
            logger.info('Telegram', 'Webhook', `Production Webhook active and pointing to ${webhookUrl}`);
        }

    } catch (err) {
        logger.error('Velox', 'Startup', 'Fatal startup error', err);
        process.exit(1);
    }
}

startServer();
