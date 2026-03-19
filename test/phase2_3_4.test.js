import { test, describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { vaultAgent } from '../src/agents/vault.js';
import { memoryAgent } from '../src/agents/memory.js';
import { sendAgent } from '../src/agents/send.js';
import { mentorAgent } from '../src/agents/mentor.js';
import { scheduler } from '../src/utils/scheduler.js';
import { aiService } from '../src/services/ai.js';
import { gmailService } from '../src/services/gmail.js';
import { telegramService } from '../src/services/telegram.js';
import { supabase } from '../src/config/supabase.js';

import { helpers } from '../src/utils/helpers.js';

describe('Phase 2, 3, 4 Integration Tests', () => {

    describe('Agent 6: Vault Agent', () => {
        it('should correctly calculate expiry dates based on importance', () => {
            const permanent = vaultAgent.calculateExpiry('permanent');
            const skip = vaultAgent.calculateExpiry('skip');
            const t30 = vaultAgent.calculateExpiry('30days');
            const t90 = vaultAgent.calculateExpiry('90days');

            assert.strictEqual(permanent, null);
            assert.strictEqual(skip, null);
            assert.ok(t30 instanceof Date);
            assert.ok(t90 instanceof Date);

            const diffSeconds = (t90.getTime() - t30.getTime()) / 1000;
            // ~60 days difference
            assert.ok(diffSeconds > 50 * 24 * 60 * 60 && diffSeconds < 70 * 24 * 60 * 60);
        });
    });

    describe('Agent 8: Send Agent', () => {
        it('should enforce hard stop and reject sending', async () => {
            try {
                await sendAgent.sendEmail('testUser', { hard_stop: true, email_to: 'test@test.com' });
                assert.fail('Should have thrown error');
            } catch (err) {
                assert.match(err.message, /Hard stop/);
            }
        });
    });

    describe('Agent 9: Memory Agent', () => {
        it('should extract JSON correctly from markdown wrappers', () => {
            const raw = '```json\n{"val": 1}\n```';
            const res = helpers.extractJSON(raw);
            assert.strictEqual(res, '{"val": 1}');
        });
    });

    describe('Phase 4: Scheduler', () => {
        it('should start and stop timer intervals correctly', () => {
            // Mock environment so it starts
            const originalEnv = process.env.TELEGRAM_CHAT_ID;
            process.env.TELEGRAM_CHAT_ID = '123';

            scheduler.start();
            assert.ok(scheduler.timers.length > 0);

            scheduler.stop();
            assert.strictEqual(scheduler.timers.length, 0);

            process.env.TELEGRAM_CHAT_ID = originalEnv;
        });
    });
});
