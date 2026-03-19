import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

const app = express();
app.use(helmet());

// Increase payload limit for file attachments
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Basic rate limiting for webhooks to prevent abuse
const webhookLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again after a minute',
});

// Import placeholder routes
import webhookRoutes from './webhook.js';
import telegramRoutes from './telegram.js';
import oauthRoutes from './oauth.js';
import healthRoutes from './health.js';

app.use('/webhook/email', webhookLimiter, webhookRoutes);
app.use('/webhook/telegram', webhookLimiter, telegramRoutes);
app.use('/auth/google', oauthRoutes);
app.use('/health', healthRoutes);

// Global Error Handler
import { errorHandler } from '../middleware/errorHandler.js';
app.use(errorHandler);

export default app;
