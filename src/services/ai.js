import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { supabase } from '../config/supabase.js';
import { telegramService } from './telegram.js';

export const aiService = {

    genAI: new GoogleGenerativeAI(env.geminiApiKey),

    /**
     * Primary AI call with tracking, randomized load balancing, and fallbacks
     */
    async callAI(prompt, systemInstruction = '', userId = null, file = null) {
        const providers = [
            {
                name: 'gemini',
                method: () => (file
                    ? this.callGeminiVision(prompt, file, systemInstruction)
                    : this.callGemini(prompt, systemInstruction)),
                key: env.geminiApiKey,
                model: file ? 'vision' : 'default',
                supportsFiles: true
            },
            {
                name: 'deepseek',
                method: () => this.callDeepSeek(prompt, systemInstruction),
                key: env.deepseekApiKey,
                model: 'default',
                supportsFiles: false
            },
            {
                name: 'nvidia',
                method: () => this.callNvidia(prompt, systemInstruction),
                key: env.nvidiaApiKey,
                model: 'default',
                supportsFiles: false
            }
        ].filter((provider) => !!provider.key && (!file || provider.supportsFiles));

        for (const provider of providers) {
            try {
                const result = await provider.method();
                const normalized = typeof result === 'string' ? result.trim() : '';

                if (!normalized) {
                    throw new Error(`${provider.name} returned an empty response`);
                }

                if (userId) await this.recordUsage(userId, provider.name, provider.model);
                return normalized;
            } catch (err) {
                logger.warn('AIService', 'Failover', `${provider.name} failed. Trying next. Error: ${err.message}`);
                // If it's a rate limit or server error, continue to next provider
                if (err.status === 429 || err.status >= 500 || err.message.includes('API error')) continue;
                // For other errors, we might want to retry once
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        logger.error('AIService', 'TotalFail', 'All AI providers failed. Using safe fallback.');
        return this.getSafeFallback();
    },

    async recordUsage(userId, provider, model) {
        try {
            await supabase.from('api_usage').insert({
                user_id: userId,
                provider,
                model,
                timestamp: new Date().toISOString()
            });
            await this.trackAndWarnAPIUsage(userId);
        } catch (err) {
            logger.error('AIService', 'RecordUsage', 'Failed to record API usage', err);
        }
    },

    /**
     * Internal: Track API usage to avoid hitting the 1500 free daily limit
     */
    async trackAndWarnAPIUsage(userId) {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const { count } = await supabase
                .from('api_usage')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId)
                .eq('provider', 'gemini')
                .gte('timestamp', today.toISOString());

            const callsToday = count || 0;

            if (callsToday === 1200) {
                // Warn at 80%
                const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
                if (user?.telegram_chat_id) {
                    await telegramService.sendMessage(user.telegram_chat_id, '⚠️ *API Usage Alert*\nGemini: 1200/1500 calls today (80%).\nSwitching to conservative mode soon.');
                }
            } else if (callsToday === 1450) {
                // Critical
                const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
                if (user?.telegram_chat_id) {
                    await telegramService.sendMessage(user.telegram_chat_id, '🚨 *API limit nearly reached.*\nSwitching to DeepSeek/OpenAI fallback for today.');
                }
            }
        } catch (e) {
            logger.error('AIService', 'TrackUsage', 'Failed to track API usage', e);
        }
    },

    /**
     * Google Gemini 1.5 Flash
     */
    async callGemini(prompt, systemInstruction) {
        const model = this.genAI.getGenerativeModel({
            model: 'gemini-1.5-flash',
            systemInstruction: systemInstruction
        });

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    },

    /**
     * Gemini 1.5 Flash Vision (Supports Images/PDFs)
     * @param {string} prompt 
     * @param {Object} file { buffer, mimeType }
     */
    async callGeminiVision(prompt, file, systemInstruction = '') {
        try {
            const model = this.genAI.getGenerativeModel({
                model: 'gemini-1.5-flash',
                systemInstruction: systemInstruction
            });

            const result = await model.generateContent([
                prompt,
                {
                    inlineData: {
                        data: file.buffer.toString('base64'),
                        mimeType: file.mimeType
                    }
                }
            ]);

            const response = await result.response;
            return response.text();
        } catch (err) {
            logger.error('AIService', 'VisionFail', 'Gemini Vision call failed', err);
            throw err;
        }
    },

    /**
     * DeepSeek Fallback
     */
    async callDeepSeek(prompt, systemInstruction) {
        if (!env.deepseekApiKey) throw new Error('DeepSeek API Key missing');

        const res = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${env.deepseekApiKey}`
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: systemInstruction },
                    { role: 'user', content: prompt }
                ],
                stream: false
            })
        });

        if (!res.ok) throw new Error(`DeepSeek API error: ${res.statusText}`);
        const data = await res.json();
        return data.choices[0].message.content;
    },

    /**
     * NVIDIA Kimi K2 Fallback
     */
    async callNvidia(prompt, systemInstruction) {
        if (!env.nvidiaApiKey) throw new Error('NVIDIA API Key missing');

        const res = await fetch(env.nvidiaBaseUrl + '/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${env.nvidiaApiKey}`
            },
            body: JSON.stringify({
                model: env.nvidiaModel,
                messages: [
                    { role: 'system', content: systemInstruction },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.6,
                top_p: 0.9,
                max_tokens: 4096,
                stream: false
            })
        });

        if (!res.ok) throw new Error(`NVIDIA API error: ${res.statusText}`);
        const data = await res.json();
        return data.choices[0].message.content;
    },

    getSafeFallback() {
        return JSON.stringify({
            skip: false,
            classification: 'unknown',
            priority_score: 50,
            urgency: 'medium',
            summary: 'AI response unavailable; manual review required.',
            intent: 'other',
            hard_stop: false,
            hard_stop_reason: null,
            entities: { dates: [], amounts: [], names: [], deadlines: [] },
            draft_reply: null,
            holding_reply: null,
            confidence: 0,
            autonomy_level: 3,
            requires_human: true,
            requires_human_reason: 'AI response unavailable',
            follow_up_needed: false,
            follow_up_in_days: null,
            language_detected: 'en'
        });
    }
};
