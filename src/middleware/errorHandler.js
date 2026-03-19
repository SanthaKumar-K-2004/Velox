import { logger } from '../utils/logger.js';
import { healthMonitor } from '../utils/healthMonitor.js';

/**
 * Velox — Global Error Handler Middleware
 */
export const errorHandler = (err, req, res, next) => {
    logger.error('Server', 'UnhandledError', `${err.name}: ${err.message}`, err);

    const statusCode = err.statusCode || 500;
    const status = err.status || 'error';

    if (err.isOperational) {
        // Known operational error
        res.status(statusCode).json({
            status,
            message: err.message
        });
    } else {
        // Unknown programming/third-party error
        healthMonitor.alertAllAdmins(`🚨 *System Crash*\n\nError: ${err.message}\nPath: ${req.path}`)
            .catch(e => logger.error('Server', 'AlertFailed', 'Could not send crash alert', e));

        res.status(statusCode).json({
            status: 'error',
            message: 'Internal Server Error'
        });
    }
};
