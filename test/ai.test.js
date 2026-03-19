import { aiService } from '../src/services/ai.js';
import { aiBrainAgent } from '../src/agents/aiBrain.js';

async function testAI() {
    console.log('--- Testing AI Service & Brain Agent ---');

    const mockContext = {
        email: {
            from: 'john@example.com',
            subject: 'Project Update',
            snippet: 'Hi, just checking in on the status of the project. When can we expect the first draft?',
            timestamp: new Date().toISOString()
        },
        core_memory: {
            user_name: 'Santhakumar K',
            user_role: 'Lead Developer',
            tone_style: 'professional',
            sign_off: 'Thanks, Santhakumar',
            language: 'en'
        },
        thread_history: [],
        calendar_data: null,
        vault_relevant_docs: [],
        is_night_time: false
    };

    try {
        console.log('Calling AI Brain...');
        const result = await aiBrainAgent.process('7664428507', mockContext);

        console.log('\n--- AI Response ---');
        console.log(JSON.stringify(result, null, 2));

        if (result.draft_reply && result.intent) {
            console.log('\n✓ AI Brain test: PASSED');
        } else {
            console.error('\n⨯ AI Brain test: FAILED (Missing required fields)');
        }
    } catch (err) {
        console.error('⨯ AI Test Error:', err);
    }
}

testAI();
