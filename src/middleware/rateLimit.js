import { rateLimit } from 'express-rate-limit';
import { logger } from '../utils/logger.js';

/**
 * Velox — API Rate Limiter
 * Protects against brute-force and DDoS attempts on the webhook and auth endpoints.
 * Standard: 100 requests per 15 minutes per IP.
 */
export const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per window
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: {
        status: 429,
        error: 'Too many requests, please try again later.'
    },
    handler: (req, res, next, options) => {
        logger.warn('Security', 'RateLimit', `IP ${req.ip} exceeded rate limit on ${req.originalUrl}`);
        res.status(options.statusCode).send(options.message);
    }
});
