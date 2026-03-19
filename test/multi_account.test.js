import { describe, it } from 'node:test';
import assert from 'node:assert';
import { gmailService } from '../src/services/gmail.js';
import { scheduler } from '../src/utils/scheduler.js';

describe('Multi-Account Support Verification', () => {

    describe('Gmail Service: Account Resolution', () => {
        it('should have a getClient method that accepts userEmail', () => {
            assert.strictEqual(typeof gmailService.getClient, 'function');
            // Check that it expects 2 arguments
            assert.strictEqual(gmailService.getClient.length, 2);
        });
    });

    describe('Scheduler: Account-Specific Jobs', () => {
        it('should include runForAllAccounts helper', () => {
            assert.strictEqual(typeof scheduler.runForAllAccounts, 'function');
        });

        it('should include account-level jobs in timers', () => {
            scheduler.start();
            // 5 Intervals: pending_sends, spam_rescue, follow_ups, consolidated_minute, ram_monitor
            assert.strictEqual(scheduler.timers.length, 5, 'Should have exactly 5 active timer intervals');
            scheduler.stop();
        });
    });

    describe('Service Logic: user_email Propagation', () => {
        it('should pass userEmail to gmailService methods', () => {
            // sendEmail(userId, draft, userEmail) -> length is 3
            assert.strictEqual(gmailService.sendEmail.length, 3, 'sendEmail should have 3 mandatory arguments');
            assert.strictEqual(gmailService.getThreadHistory.length, 3, 'getThreadHistory should have 3 mandatory arguments');
        });
    });
});
