import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { nlHandler } from '../src/agents/nlHandler.js';
import { healthMonitor } from '../src/utils/healthMonitor.js';
import { telegramCommands } from '../src/server/telegramCommands.js';
import { scheduler } from '../src/utils/scheduler.js';

describe('Phase 9: System Health & Natural Language', () => {

    test('1. nlHandler exists and has handle method', () => {
        assert.ok(nlHandler, 'nlHandler should exist');
        assert.equal(typeof nlHandler.handle, 'function', 'handle should be a function');
        assert.equal(typeof nlHandler.handleVaultSearch, 'function', 'handleVaultSearch should be a function');
    });

    test('2. healthMonitor exists and has expected methods', () => {
        assert.ok(healthMonitor, 'healthMonitor should exist');
        assert.equal(typeof healthMonitor.checkRAM, 'function');
        assert.equal(typeof healthMonitor.nightlyCleanup, 'function');
        assert.equal(typeof healthMonitor.keepSupabaseAlive, 'function');
    });

    test('3. telegramCommands has all Phase 9 commands', () => {
        const requiredCommands = [
            'handleSent', 'handleSearch', 'handleBack',
            'handlePause', 'handleResume', 'handleTone',
            'handleWhitelist', 'handleUndo'
        ];

        for (const cmd of requiredCommands) {
            assert.equal(typeof telegramCommands[cmd], 'function', `${cmd} should be implemented`);
        }
    });

    test('4. Scheduler has Phase 9 jobs registered', () => {
        // Scheduler's start() creates timers.
        // We just verify it doesn't crash on start/stop.
        scheduler.start();
        assert.ok(scheduler.timers.length > 0, 'Scheduler should register timers');
        scheduler.stop();
        assert.equal(scheduler.timers.length, 0, 'Scheduler timers should be cleared');
    });

});
