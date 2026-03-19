/**
 * Velox — Global Constants
 */
export const VELOX = {
    NAME: 'Velox',
    VERSION: '1.0.0',
    DESCRIPTION: 'AI Email Agent',
    MAX_CONCURRENT_EMAILS: 5,
};

export const CONSTANTS = {
    BUCKETS: {
        ALWAYS_NOTIFY: 'ALWAYS_NOTIFY',
        STORE_AND_DIGEST: 'STORE_AND_DIGEST',
        TRUE_TRASH: 'TRUE_TRASH',
        NEEDS_AI: 'NEEDS_AI'
    },

    AUTONOMY_LEVELS: {
        DRAFT_READY: 1,      // Show draft, user taps send
        WHITELISTED: 2,      // Auto-send with delay
        ALWAYS_HUMAN: 3      // Hard stop, must review
    },

    EMAIL_STATUS: {
        PROCESSING: 'processing',
        DONE: 'done',
        FAILED: 'failed',
    },

    // Max memory tokens to inject to AI
    MAX_MEMORY_TOKENS: 450,

    // Limits
    DAILY_GEMINI_LIMIT: 1500,
    WARNING_THRESHOLD_PERCENT: 0.8,
    CRITICAL_THRESHOLD_PERCENT: 0.97,

    // Timeouts (in minutes)
    TIMEOUTS: {
        ROUTINE: 30,
        IMPORTANT: 120,
        URGENT: 15,
        VIP: 10
    },

    // Holding reply delay range (ms)
    HUMAN_DELAY_MIN_MS: 90 * 1000,
    HUMAN_DELAY_MAX_MS: 180 * 1000,
};

export const HARD_STOP_KEYWORDS = [
    // Meeting / scheduling
    'schedule', 'meeting', 'call', 'free', 'available',
    'thursday', 'friday', 'monday', 'tuesday', 'wednesday',
    'tomorrow', 'next week', 'this week', 'next month',
    'zoom', 'google meet', 'teams', 'meet', 'catch up',
    'let\'s connect', 'book a time', 'calendar invite',
    'reschedule', 'postpone', 'cancel the meeting',
    'what time works', 'are you free', 'when are you available',

    // Financial commitment
    'please transfer', 'send payment', 'wire transfer',
    'purchase order', 'sign the contract', 'agree to terms',
    'payment terms', 'negotiate', 'counter offer',

    // Legal
    'legal notice', 'lawsuit', 'claim', 'dispute resolution',
    'terms and conditions', 'liability', 'breach',

    // Sensitive
    'confidential', 'attorney', 'solicitor', 'court'
];
