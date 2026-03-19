import { supabase } from '../config/supabase.js';
import { aiService } from '../services/ai.js';
import { gmailService } from '../services/gmail.js';
import { telegramService } from '../services/telegram.js';
import { logger } from '../utils/logger.js';
import { helpers } from '../utils/helpers.js';

/**
 * Agent 9 — Memory Agent
 * Learns user tone over time. 
 * Bootstraps from Sent history, learns from every human edit.
 */
export const memoryAgent = {

    /**
     * Tier 1: Core Memory
     * Returns constant style, tone, and sign-off
     */
    async getCoreMemory(userId) {
        const { data } = await supabase
            .from('memory')
            .select('tone_style, formality_score, sign_off, phrase_bank, writing_quirks')
            .eq('user_id', userId)
            .single();
        return data || this.getDefaultMemory();
    },

    getDefaultMemory() {
        return {
            user_name: 'User',
            tone_style: 'friendly',
            sign_off: 'Regards,',
            avg_reply_length: 'medium',
            formality_score: 50,
            phrase_bank: [],
            writing_quirks: []
        };
    },

    /**
     * Tier 2: Contact Memory
     * Returns relationship info and preferred tone for a specific sender
     */
    async getContactMemory(userId, email) {
        if (!email) return {};
        const { data } = await supabase
            .from('contact_memory')
            .select('*')
            .eq('user_id', userId)
            .eq('contact_email', email)
            .single();
        return data || {};
    },

    /**
     * Tier 3: Topic Memory
     * Returns pattern/preferred response for a matched intent
     */
    async getTopicMemory(userId, intent) {
        if (!intent) return null;
        const { data } = await supabase
            .from('topic_memory')
            .select('*')
            .eq('user_id', userId)
            .eq('intent', intent)
            .single();
        return data;
    },

    /**
     * Bootstraps Memory on Day 1 by analyzing last 50 sent emails
     * @param {string} userId 
     */
    /**
     * Bootstraps Memory on Day 1 by analyzing last 50 sent emails
     * @param {string} userId 
     */
    async bootstrapMemory(userId, userEmail) {
        try {
            logger.info('MemoryAgent', 'Bootstrap', `Starting bootstrap for user ${userId} (${userEmail})`);

            // 1. Fetch last 50 sent standard emails
            const sentEmails = await gmailService.getRecentSentEmails(userId, 50, userEmail);

            if (!sentEmails || sentEmails.length === 0) {
                logger.warn('MemoryAgent', 'BootstrapNoSent', 'No sent emails found. Proceeding with questions only.');
            }

            let analysis = {};
            if (sentEmails?.length > 0) {
                // 2. Extract texts for Gemini
                const emailTexts = sentEmails.map(m => `To: ${m.to}\nSubject: ${m.subject}\nBody: ${m.snippet}\n`).join('---\n');

                // 3. Gemini analyzes writing style
                const prompt = `
Analyze these ${sentEmails.length} sent emails to understand this user's communication style.
Extract the following metadata as valid JSON ONLY:
{
  "tone_style": "formal | casual | friendly | professional",
  "formality_score": 0-100,
  "avg_reply_length": "short | medium | detailed",
  "common_openings": ["Hi X,", "Hello X,"],
  "common_closings": ["Thanks, Arjun", "Best, Arjun"],
  "phrase_bank": ["phrases they use repeatedly"],
  "writing_quirks": ["patterns unique to this person"],
  "topics_handled": ["types of emails they respond to"],
  "sign_off": "Their most common sign off phrase"
}

EMAILS:
"""
${emailTexts.substring(0, 20000)}
"""
`;
                const result = await aiService.callAI(prompt, 'You are a writing style analyst.', userId);
                analysis = JSON.parse(helpers.extractJSON(result));
            }

            // 4. Update memory table (upsert)
            await supabase.from('memory').upsert({
                user_id: userId,
                tone_style: analysis.tone_style || 'friendly',
                formality_score: analysis.formality_score || 50,
                avg_reply_length: analysis.avg_reply_length || 'medium',
                common_phrases: analysis.common_openings?.concat(analysis.common_closings || []) || [],
                phrase_bank: analysis.phrase_bank || [],
                writing_quirks: analysis.writing_quirks || [],
                sign_off: analysis.sign_off || 'Best,',
                updated_at: new Date().toISOString(),
                bootstrapped_at: new Date().toISOString(),
                emails_analysed: sentEmails?.length || 0
            });

            // 5. Start interactive onboarding
            const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
            if (user?.telegram_chat_id) {
                await supabase.from('users').update({ onboarding_status: 'q1' }).eq('id', userId);
                await telegramService.sendMessage(user.telegram_chat_id,
                    '✅ Writing style analyzed!\n\nTo refine my accuracy, I have 5 quick questions. ⚡\n\n*Question 1:* What is your preferred sign-off for professional emails? (e.g. Regards, Best, Thanks)');
            }

        } catch (err) {
            logger.error('MemoryAgent', 'Bootstrap', 'Failed to bootstrap memory', err);
        }
    },

    onboardingQuestions: [
        { key: 'tone_style', q: 'Got it! *Question 2:* How would you describe your general tone? (Formal, Casual, Very Concise, or Friendly?)' },
        { key: 'avg_reply_length', q: "*Question 3:* Do you prefer short 'Slack-style' replies or more detailed context?" },
        { key: 'user_role', q: '*Question 4:* What is your current job title/role? (This helps me understand your context)' },
        { key: 'vip_domains', q: '*Final Question:* Are there any specific domains or emails I should treat as VIP? (e.g. google.com, boss@work.com)' }
    ],

    async handleOnboardingMessage(userId, text) {
        const { data: user } = await supabase.from('users').select('onboarding_status, onboarding_data, telegram_chat_id').eq('id', userId).single();
        if (!user || user.onboarding_status === 'done' || user.onboarding_status === 'not_started') return;

        const currentStep = parseInt(user.onboarding_status.replace('q', ''));
        const nextStep = currentStep + 1;

        // Save data
        const data = user.onboarding_data || {};
        const stepKey = currentStep === 1 ? 'sign_off' : this.onboardingQuestions[currentStep - 2].key;
        data[stepKey] = text;

        if (currentStep <= this.onboardingQuestions.length) {
            const nextQ = this.onboardingQuestions[currentStep - 1];
            await supabase.from('users').update({
                onboarding_status: `q${nextStep}`,
                onboarding_data: data
            }).eq('id', userId);

            await telegramService.sendMessage(user.telegram_chat_id, nextQ.q);
        } else {
            // Onboarding Complete
            await supabase.from('users').update({ onboarding_status: 'done', onboarding_data: data }).eq('id', userId);

            // Final sync to memory table
            await supabase.from('memory').update({
                sign_off: data.sign_off,
                tone_style: data.tone_style,
                avg_reply_length: data.avg_reply_length,
                updated_at: new Date().toISOString()
            }).eq('user_id', userId);

            await telegramService.sendMessage(user.telegram_chat_id,
                "🎉 *Setup Complete!*\n\nI now have a strong grasp of your style. I'll start processing your emails now. Type /help anytime!");
        }
    },

    /**
     * Learn from a specific interaction (Edit, Approval, VIP addition)
     * @param {string} userId 
     * @param {Object} interaction - { type, aiDraft, finalSent, reason, email }
     */
    async learnFromInteraction(userId, interaction) {
        try {
            switch (interaction.type) {
            case 'USER_EDITED_DRAFT': {
                // Compute diff via Gemini and update phrase bank
                const diffPrompt = `
Compare the original AI Draft to the Final Sent versions. Identify what the user changed.
Return JSON: { "pattern": "What rule or pattern the AI should learn", "formality_shift": -10 to 10 }

Original AI Draft: "${interaction.aiDraft}"
Final User Sent: "${interaction.finalSent}"
`;
                const result = await aiService.callAI(diffPrompt, 'Reply ONLY with valid JSON.', userId);
                const diff = JSON.parse(helpers.extractJSON(result));

                // Fetch existing patterns
                const { data: mem } = await supabase.from('memory').select('edit_patterns, formality_score').eq('user_id', userId).single();
                let patterns = mem?.edit_patterns || [];
                patterns.push(diff.pattern);
                // Keep last 10 patterns to avoid context bloat
                if (patterns.length > 10) patterns.shift();

                await supabase.from('memory').update({
                    edit_patterns: patterns,
                    formality_score: Math.max(0, Math.min(100, (mem?.formality_score || 50) + (diff.formality_shift || 0))),
                    updated_at: new Date().toISOString()
                }).eq('user_id', userId);

                logger.info('MemoryAgent', 'Learn', `Learned edit pattern: ${diff.pattern}`);
                break;
            }

            case 'USER_APPROVED_DRAFT':
                await this.handleDraftApproved(userId, interaction.draft);
                break;

            case 'USER_REJECTED_DRAFT':
                await this.handleDraftRejected(userId, interaction.draft, interaction.reason);
                break;

            case 'USER_ADD_VIP':
                await this.updateContactMemory(userId, interaction.email, { is_vip: true });
                break;

            case 'USER_IGNORE':
                await this.updateContactMemory(userId, interaction.email, { is_ignored: true });
                break;
            }
        } catch (err) {
            logger.error('MemoryAgent', 'Learn', 'Failed to learn from interaction', err);
        }
    },

    /**
     * Run weekly to check if tone has significantly drifted
     */
    async detectToneDrift(userId, userEmail) {
        try {
            const sentEmails = await gmailService.getRecentSentEmails(userId, 20, userEmail);
            if (!sentEmails || sentEmails.length < 5) return;

            const emailText = sentEmails.map(e => e.snippet || '').join('\n');

            const prompt = `
Rate the formality of these recent emails on a scale of 0 to 100.
Return JSON: { "formality_score": 0-100 }

"""${emailText.substring(0, 10000)}"""`;

            const result = await aiService.callAI(prompt, 'Reply ONLY in valid JSON.', userId);
            const score = JSON.parse(helpers.extractJSON(result)).formality_score;

            const { data: mem } = await supabase.from('memory').select('formality_score').eq('user_id', userId).single();
            if (mem && Math.abs(mem.formality_score - score) > 15) {
                // Significant drift
                const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
                if (user?.telegram_chat_id) {
                    await telegramService.sendWithButtons(user.telegram_chat_id,
                        `💡 *Tone shift noticed*\n\nYour writing style has shifted recently (scored ${score} vs old ${mem.formality_score}).\nUpdate my understanding of your style?`,
                        [[{ text: '✅ Yes, update', callback_data: 'update_tone' }, { text: '❌ Keep old', callback_data: 'keep_tone' }]]
                    );
                }
            }
        } catch (err) {
            logger.error('MemoryAgent', 'ToneDrift', 'Failed to detect tone drift', err);
        }
    },

    async handleDraftApproved(userId, _draft) {
        // Reinforce accuracy score
        const { data: mem } = await supabase.from('memory').select('accuracy_score').eq('user_id', userId).single();
        await supabase.from('memory').update({
            accuracy_score: Math.min(100, (mem?.accuracy_score || 0) + 1),
            updated_at: new Date().toISOString()
        }).eq('user_id', userId);
        logger.info('MemoryAgent', 'Approved', `Style reinforced for user ${userId}`);
    },

    async handleDraftRejected(userId, draft, reason) {
        // Log failure pattern for future prevention
        logger.warn('MemoryAgent', 'Rejected', `User ${userId} rejected draft. Reason: ${reason}`);
        // Optionally store in a negative_patterns list or similar
    },

    async addVIP(userId, email) {
        await this.updateContactMemory(userId, email, { is_vip: true });
    },

    async addIgnored(userId, email) {
        await this.updateContactMemory(userId, email, { is_ignored: true });
    },

    async updateContactMemory(userId, contactEmail, updates) {
        if (!contactEmail) return;
        await supabase.from('contact_memory').upsert({
            user_id: userId,
            contact_email: contactEmail,
            ...updates,
            updated_at: new Date().toISOString()
        });
    }
};
