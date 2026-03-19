import { filterAgent } from '../src/agents/filter.js';
import { autonomyAgent } from '../src/agents/autonomy.js';

/**
 * Velox — Phase 1 Integration Tests
 * Tests the core email processing pipeline components.
 */

let passed = 0;
let failed = 0;

function assert(name, condition) {
    if (condition) {
        console.log(`  ✓ ${name}`);
        passed++;
    } else {
        console.error(`  ✗ ${name}`);
        failed++;
    }
}

// ═══════════════════════════════════════════
// TEST 1: Filter Agent — All 4 Buckets
// ═══════════════════════════════════════════
console.log('\n━━━ Filter Agent Tests ━━━');

const filterTests = [
    { subject: 'Payment Confirmed', snippet: 'Your payment of $50 is confirmed', expected: 'ALWAYS_NOTIFY' },
    { subject: 'OTP: 493821', snippet: 'Your one-time password is 493821', expected: 'ALWAYS_NOTIFY' },
    { subject: 'Weekly Newsletter', snippet: 'Here is your weekly digest of news', expected: 'STORE_AND_DIGEST' },
    { subject: 'GitHub: PR merged', snippet: 'Your pull request was merged into main', expected: 'STORE_AND_DIGEST' },
    { subject: 'Unsubscribe from this list', snippet: 'You are receiving this because you signed up', expected: 'TRUE_TRASH' },
    { subject: 'Quick question about project', snippet: 'Just checking in on the timeline', expected: 'NEEDS_AI' },
];

filterTests.forEach(test => {
    const result = filterAgent.classify(test);
    assert(`"${test.subject}" → ${test.expected}`, result.bucket === test.expected);
});

// Hard stop detection
const hardStopEmail = { subject: 'Meeting tomorrow?', snippet: 'Are you free for a call next week?' };
const hardStopResult = filterAgent.classify(hardStopEmail);
assert('Hard stop detected for meeting request', hardStopResult.isHardStop === true);

const normalEmail = { subject: 'Project update', snippet: 'Everything is on track' };
const normalResult = filterAgent.classify(normalEmail);
assert('No hard stop for normal email', normalResult.isHardStop === false);

// ═══════════════════════════════════════════
// TEST 2: Autonomy Agent — Decision Matrix
// ═══════════════════════════════════════════
console.log('\n━━━ Autonomy Agent Tests ━━━');

// Level 3 — Hard stop
const hardStopDecision = autonomyAgent.decideAutonomy({ hard_stop: true, hard_stop_reason: 'Legal terms' }, {}, true);
assert('Hard stop → Level 3', hardStopDecision.level === 3);

// Level 3 — Meeting request
const meetingDecision = autonomyAgent.decideAutonomy({ intent: 'meeting_request', confidence: 95 }, {}, false);
assert('Meeting request → Level 3', meetingDecision.level === 3);

// Level 3 — Low confidence
const lowConfDecision = autonomyAgent.decideAutonomy({ intent: 'question', confidence: 50 }, {}, false);
assert('Low confidence (50%) → Level 3', lowConfDecision.level === 3);

// Level 3 — Unknown sender
const unknownDecision = autonomyAgent.decideAutonomy({ intent: 'question', confidence: 80, classification: 'unknown' }, {}, false);
assert('Unknown sender → Level 3', unknownDecision.level === 3);

// Level 2 — Whitelisted category with high confidence
const whitelistDecision = autonomyAgent.decideAutonomy(
    { intent: 'fyi', confidence: 95 },
    { auto_send_categories: ['fyi'], delay_mins: 3, undo_mins: 15 },
    false
);
assert('Whitelisted fyi + 95% → Level 2', whitelistDecision.level === 2);
assert('Level 2 has delay_mins', whitelistDecision.delay_mins === 3);

// Level 1 — Default (draft ready)
const defaultDecision = autonomyAgent.decideAutonomy({ intent: 'question', confidence: 85 }, {}, false);
assert('Normal email → Level 1 (default)', defaultDecision.level === 1);

// ═══════════════════════════════════════════
// TEST 3: Autonomy Agent — Holding Reply
// ═══════════════════════════════════════════
console.log('\n━━━ Holding Reply Tests ━━━');

const holdingReply = autonomyAgent.generateHoldingReply({ from: 'john@example.com', fromName: 'John' }, { sign_off: 'Thanks, SK' });
assert('Holding reply contains sender name', holdingReply.includes('John'));
assert('Holding reply contains sign-off', holdingReply.includes('Thanks, SK'));
assert('Holding reply has time estimate', holdingReply.includes('tomorrow') || holdingReply.includes('today') || holdingReply.includes('hours'));

// ═══════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════
console.log('\n━━━ Results ━━━');
console.log(`  Passed: ${passed}/${passed + failed}`);
console.log(`  Failed: ${failed}/${passed + failed}`);
console.log(failed === 0 ? '\n  ✓ All Phase 1 tests passed!\n' : '\n  ✗ Some tests failed.\n');

process.exit(failed > 0 ? 1 : 0);
