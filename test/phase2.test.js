import { filterAgent } from '../src/agents/filter.js';
import { logger } from '../src/utils/logger.js';

const testEmails = [
    {
        subject: 'Payment Confirmed: Your Order #123',
        snippet: 'Thanks for your payment of $50. Your order is confirmed.',
        expectedBucket: 'ALWAYS_NOTIFY'
    },
    {
        subject: 'Weekly Newsletter - AI Trends',
        snippet: 'Here is your weekly digest of AI news and updates.',
        expectedBucket: 'STORE_AND_DIGEST'
    },
    {
        subject: 'Unsubscribe from marketing',
        snippet: 'Click here to unsubscribe from this mailing list.',
        expectedBucket: 'TRUE_TRASH'
    },
    {
        subject: 'Meeting tomorrow?',
        snippet: 'Are you free for a quick call next week to discuss the project?',
        expectedBucket: 'NEEDS_AI',
        expectedHardStop: true
    },
    {
        subject: 'Quick question',
        snippet: 'Just wondering if you saw my last email about the designs.',
        expectedBucket: 'NEEDS_AI',
        expectedHardStop: false
    }
];

function runTests() {
    console.log('--- Phase 2: Filter Agent Test ---');
    let passed = 0;

    testEmails.forEach((test, index) => {
        const result = filterAgent.classify(test);
        const bucketMatch = result.bucket === test.expectedBucket;
        const hardStopMatch = result.isHardStop === (test.expectedHardStop || false);

        if (bucketMatch && hardStopMatch) {
            console.log(`✓ Test ${index + 1}: PASSED (${test.subject})`);
            passed++;
        } else {
            console.error(`⨯ Test ${index + 1}: FAILED`);
            console.error(`  Subject: ${test.subject}`);
            console.error(`  Expected: ${test.expectedBucket}, Got: ${result.bucket}`);
            console.error(`  Expected HardStop: ${test.expectedHardStop || false}, Got: ${result.isHardStop}`);
        }
    });

    console.log(`\nResults: ${passed}/${testEmails.length} tests passed.`);
}

runTests();
