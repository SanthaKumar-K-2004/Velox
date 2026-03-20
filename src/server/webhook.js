import express from 'express';
import { intakeWorker } from '../agents/intakeWorker.js';
import { supabase } from '../config/supabase.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/AppError.js';

const router = express.Router();

/**
 * Required fields in a webhook payload from Apps Script
 */
const REQUIRED_FIELDS = ['messageId', 'subject', 'from', 'userEmail'];

function normalizeEmail(email) {
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

router.post('/', async (req, res, next) => {
    try {
        const incomingSecret = req.headers['x-webhook-secret'];
        if (incomingSecret !== env.webhookSecret) {
            logger.warn('Webhook', 'Auth', 'Unauthorized webhook attempt');
            throw new AppError('Unauthorized', 401);
        }

        const payload = req.body;

        if (!payload || typeof payload !== 'object') {
            throw new AppError('Invalid JSON payload', 400);
        }

        const missing = REQUIRED_FIELDS.filter((field) => !payload[field]);
        if (missing.length > 0) {
            logger.warn('Webhook', 'Validation', `Missing fields: ${missing.join(', ')}`);
            throw new AppError(`Missing required fields: ${missing.join(', ')}`, 400);
        }

        const normalizedEmail = normalizeEmail(payload.userEmail);
        const { data: account, error: accountError } = await supabase
            .from('user_accounts')
            .select('user_id, email')
            .eq('email', normalizedEmail)
            .maybeSingle();

        if (accountError || !account) {
            logger.warn('Webhook', 'UserResolve', `Account not found for email: ${normalizedEmail}`);
            throw new AppError('User not registered or Gmail not connected', 404);
        }

        payload.userId = account.user_id;
        payload.userEmail = account.email;

        res.status(200).json({ status: 'queued', messageId: payload.messageId });

        logger.info('Webhook', 'Received', `Email ${payload.messageId} from ${payload.from} for ${payload.userEmail}`);
        intakeWorker.process(payload).catch((err) => {
            logger.error('Webhook', 'AsyncProcess', `Failed for ${payload.messageId}`, err);
        });
    } catch (err) {
        next(err);
    }
});

/**
 * Handle incoming push notifications from Google Cloud Pub/Sub
 */
router.post('/gmail-push', async (req, res, next) => {
    try {
        const payload = req.body;

        // Always ACK Pub/Sub immediately
        res.status(200).send('OK');

        if (!payload || !payload.message || !payload.message.data) {
            logger.warn('Webhook', 'PubSub', 'Missing or invalid Pub/Sub payload');
            return;
        }

        // Decode the base64 payload
        const dataStr = Buffer.from(payload.message.data, 'base64').toString('utf-8');
        const data = JSON.parse(dataStr);

        const userEmail = normalizeEmail(data.emailAddress);
        const historyId = data.historyId;

        if (!userEmail) return;

        const { data: account, error: accountError } = await supabase
            .from('user_accounts')
            .select('user_id')
            .eq('email', userEmail)
            .maybeSingle();

        if (accountError || !account) {
            logger.warn('Webhook', 'PubSubResolve', `Account not found for push: ${userEmail}`);
            return;
        }

        logger.info('Webhook', 'PubSubPush', `Push received for ${userEmail}. HistoryId: ${historyId}`);

        // Trigger the async worker to fetch and process new messages
        intakeWorker.processFromPush(account.user_id, userEmail, historyId).catch(err => {
            logger.error('Webhook', 'PushProcess', 'Failed to process push', err);
        });

    } catch (err) {
        logger.error('Webhook', 'PubSub', 'Error handling push', err);
    }
});

export default router;
