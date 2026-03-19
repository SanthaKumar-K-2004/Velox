import { env } from '../config/env.js';

/**
 * Velox — Structured Logger
 * Provides consistent, JSON-formatted output for external logging ingestors.
 */
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = env.nodeEnv === 'production' ? LOG_LEVELS.info : LOG_LEVELS.debug;

function formatMessage(level, agent, action, message, error = null) {
    const log = {
        timestamp: new Date().toISOString(),
        level,
        agent,
        action,
        message
    };

    if (error) {
        log.error = error.message || error;
        if (env.nodeEnv === 'development' && error.stack) {
            log.stack = error.stack;
        }
    }

    return JSON.stringify(log);
}

/* eslint-disable no-console */
export const logger = {
    debug(agent, action, message) {
        if (currentLevel <= LOG_LEVELS.debug) {
            console.debug(formatMessage('DEBUG', agent, action, message));
        }
    },

    info(agent, action, message) {
        if (currentLevel <= LOG_LEVELS.info) {
            console.log(formatMessage('INFO', agent, action, message));
        }
    },

    warn(agent, action, message) {
        if (currentLevel <= LOG_LEVELS.warn) {
            console.warn(formatMessage('WARN', agent, action, message));
        }
    },

    error(agent, action, message, error) {
        if (currentLevel <= LOG_LEVELS.error) {
            console.error(formatMessage('ERROR', agent, action, message, error));
        }
    },
};
/* eslint-enable no-console */
