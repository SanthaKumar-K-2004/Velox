import { HARD_STOP_KEYWORDS } from '../config/constants.js';

/**
 * Agent 2 — Filter Agent
 * Cost guardian. Kills unnecessary AI calls. 
 * Classifies by CONTENT TYPE.
 */
export const filterAgent = {

    // Bucket A — ALWAYS_NOTIFY (keep + alert instantly)
    BUCKET_A_KEYWORDS: [
        'payment receipt', 'invoice', 'paid', 'payment confirmed',
        'order confirmed', 'order shipped', 'out for delivery', 'delivered',
        'booking confirmed', 'reservation confirmed',
        'flight ticket', 'train ticket', 'bus ticket', 'boarding pass',
        'hotel confirmation', 'check-in details',
        'prize', 'winner', 'reward', 'you have won', 'congratulations',
        'otp', 'verification code', 'one-time password',
        'security alert', 'login attempt', 'unusual activity',
        'bank alert', 'transaction', 'debit', 'credit', 'statement',
        'job offer', 'offer letter', 'interview', 'application update',
        'contract', 'agreement', 'sign this document',
        'refund', 'cashback', 'money returned'
    ],

    // Bucket B — STORE_AND_DIGEST (keep + batch into daily digest)
    BUCKET_B_KEYWORDS: [
        'newsletter', 'weekly digest', 'monthly update',
        'product update', 'new feature', 'changelog',
        'github notification', 'gitlab', 'pull request', 'merged',
        'calendar invite accepted', 'calendar invite declined',
        'social media digest', 'follower notification',
        'software update', 'app update',
        'account activity', 'promotion'
    ],

    // Bucket C — TRUE_TRASH (silent delete, never notify)
    BUCKET_C_KEYWORDS: [
        'unsubscribe from this list',
        'you are receiving this because you signed up',
        'bulk mail indicator',
        'marketing'
    ],

    /**
     * Classifies an email into one of four buckets
     * @param {Object} email - Email subject and snippet
     * @returns {Object} - { bucket: string, signals: string[], isHardStop: boolean }
     */
    classify(email) {
        const subject = (email.subject || '').toLowerCase();
        const snippet = (email.snippet || '').toLowerCase();
        const content = `${subject} ${snippet}`;

        const signals = [];
        let bucket = 'NEEDS_AI'; // Default

        // 1. Check Hard Stop
        const isHardStop = HARD_STOP_KEYWORDS.some(k => content.includes(k.toLowerCase()));

        // 2. Check Bucket A (Urgent/Notify)
        const matchedA = this.BUCKET_A_KEYWORDS.filter(k => content.includes(k.toLowerCase()));
        if (matchedA.length > 0) {
            bucket = 'ALWAYS_NOTIFY';
            signals.push(...matchedA);
            return { bucket, signals, isHardStop };
        }

        // 3. Check Bucket B (Digest)
        const matchedB = this.BUCKET_B_KEYWORDS.filter(k => content.includes(k.toLowerCase()));
        if (matchedB.length > 0) {
            bucket = 'STORE_AND_DIGEST';
            signals.push(...matchedB);
            // We don't return early because it might still be trash if C signals are stronger
        }

        // 4. Check Bucket C (Trash)
        const matchedC = this.BUCKET_C_KEYWORDS.filter(k => content.includes(k.toLowerCase()));
        if (matchedC.length > 0 && bucket === 'NEEDS_AI') {
            // Only trash if zero A/B signals found
            bucket = 'TRUE_TRASH';
            signals.push(...matchedC);
        }

        return { bucket, signals, isHardStop };
    }
};
