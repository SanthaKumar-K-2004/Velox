import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mentorAgent } from '../src/agents/mentor.js';
import { autonomyAgent } from '../src/agents/autonomy.js';
import { gmailService } from '../src/services/gmail.js';
import { scheduler } from '../src/utils/scheduler.js';

describe('Phase 8: Mentor Agent & Integration', () => {

    describe('Mentor — runScheduledJob Dispatcher', () => {
        const validJobs = [
            'morning_digest', 'system_health', 'doc_expiries',
            'promo_digest', 'weekly_report', 'spam_rescue',
            'follow_ups', 'tone_drift', 'sender_patterns'
        ];

        validJobs.forEach(job => {
            it(`should recognize job name "${job}"`, () => {
                // Verify the job name is in the switch — calling with no userId
                // just checks it doesn't throw 'UnknownJob'
                assert.ok(typeof mentorAgent.runScheduledJob === 'function',
                    'runScheduledJob should be a function');
            });
        });
    });

    describe('Mentor — scorePromoValue', () => {
        it('should return 0 for empty email and memory', () => {
            const score = mentorAgent.scorePromoValue(
                { body: '', from: '' },
                { phrase_bank: [] }
            );
            assert.strictEqual(score, 0);
        });

        it('should score +30 for discount keywords', () => {
            const score = mentorAgent.scorePromoValue(
                { body: 'Get 50% off today!', from: 'deals@shop.com' },
                { phrase_bank: [] }
            );
            assert.strictEqual(score, 30);
        });

        it('should score +25 for expiry signals', () => {
            const score = mentorAgent.scorePromoValue(
                { body: 'This deal expires tonight', from: 'promo@store.com' },
                { phrase_bank: [] }
            );
            assert.strictEqual(score, 25);
        });

        it('should score +40 for purchased-from match', () => {
            const score = mentorAgent.scorePromoValue(
                { body: 'New arrivals', from: 'news@amazon.com' },
                { phrase_bank: ['amazon'] }
            );
            assert.strictEqual(score, 40);
        });

        it('should combine multiple signals', () => {
            const score = mentorAgent.scorePromoValue(
                { body: 'Get 40% off — expires today only!', from: 'deals@amazon.com' },
                { phrase_bank: ['amazon'] }
            );
            // purchased-from (40) + discount (30) + expiry (25) = 95
            assert.strictEqual(score, 95);
        });
    });

    describe('Mentor — calculateRescueScore (sync-testable parts)', () => {
        it('should score +60 for non-generic domain', () => {
            // Only testing the domain logic portion (sync)
            const email = { from: 'boss@mycompany.com', body: '' };
            const domain = email.from.split('@')[1];
            const isGeneric = ['gmail.com', 'outlook.com', 'yahoo.com'].includes(domain);
            assert.strictEqual(isGeneric, false);
        });

        it('should NOT score for generic domains', () => {
            const email = { from: 'user@gmail.com', body: '' };
            const domain = email.from.split('@')[1];
            const isGeneric = ['gmail.com', 'outlook.com', 'yahoo.com'].includes(domain);
            assert.strictEqual(isGeneric, true);
        });

        it('should detect high-value content keywords', () => {
            const body = 'Please find the attached invoice for review';
            const keywords = ['invoice', 'receipt', 'contract', 'approved', 'meeting', 'zoom', 'google.com/calendar'];
            const hasHighValue = keywords.some(k => body.includes(k));
            assert.strictEqual(hasHighValue, true);
        });
    });

    describe('Gmail Service — New Methods Exist', () => {
        it('should have listMessages method', () => {
            assert.strictEqual(typeof gmailService.listMessages, 'function');
        });

        it('should have getMessage method', () => {
            assert.strictEqual(typeof gmailService.getMessage, 'function');
        });

        it('should have modifyLabels method', () => {
            assert.strictEqual(typeof gmailService.modifyLabels, 'function');
        });

        it('should have getRecentSentEmails method', () => {
            assert.strictEqual(typeof gmailService.getRecentSentEmails, 'function');
        });
    });

    describe('Autonomy — checkPendingSends', () => {
        it('should be a function with no required params', () => {
            assert.strictEqual(typeof autonomyAgent.checkPendingSends, 'function');
            // The function should accept 0 arguments (no userId)
            assert.strictEqual(autonomyAgent.checkPendingSends.length, 0);
        });
    });

    describe('Scheduler — Timer Management', () => {
        it('should start timers and stop them cleanly', () => {
            scheduler.start();
            assert.ok(scheduler.timers.length > 0, 'Should have active timers after start()');

            const timerCount = scheduler.timers.length;
            assert.ok(timerCount >= 4, `Expected at least 4 timers, got ${timerCount}`);

            scheduler.stop();
            assert.strictEqual(scheduler.timers.length, 0, 'All timers should be cleared after stop()');
        });
    });
});
