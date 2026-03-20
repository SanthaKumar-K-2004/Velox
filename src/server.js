import app from './server/app.js';
import { env } from './config/env.js';
import { supabase } from './config/supabase.js';
import { logger } from './utils/logger.js';
import { VELOX } from './config/constants.js';
import { scheduler } from './utils/scheduler.js';

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

        // 4. Set Telegram Webhook if on a public URL
        const isRender = env.googleRedirectUri.includes('onrender.com');
        if (isRender || env.nodeEnv === 'production') {
            const baseUrl = env.googleRedirectUri.replace('/auth/google/callback', '');
            import('./services/telegram.js').then(({ telegramService }) => {
                telegramService.setWebhook(baseUrl);
            }).catch(err => {
                logger.error('Velox', 'Startup', 'Failed to load telegramService for webhook', err);
            });
        }

    } catch (err) {
        logger.error('Velox', 'Startup', 'Fatal startup error', err);
        process.exit(1);
    }
}

startServer();
