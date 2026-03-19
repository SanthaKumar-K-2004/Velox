import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { supabase } from '../config/supabase.js';
import { telegramService } from './telegram.js';

export const aiService = {

    genAI: new GoogleGenerativeAI(env.geminiApiKey),

    /**
     * Primary AI call with tracking and fallbacks
     */
    async callAI(prompt, systemInstruction = '', userId = null) {
        let retries = 2;
        while (retries > 0) {
            try {
                const result = await this.callGemini(prompt, systemInstruction);
                if (userId) {
                    await this.recordUsage(userId, 'gemini', 'gemini-1.5-flash');
                }
                return result;
            } catch (err) {
                retries--;
                logger.warn('AIService', 'GeminiFail', `Primary AI failed. Retries left: ${retries}. Error: ${err.message}`);
                if (retries === 0 || err.status === 429) {
                    try {
                        const result = await this.callDeepSeek(prompt, systemInstruction);
                        if (userId) await this.recordUsage(userId, 'deepseek', 'deepseek-chat');
                        return result;
                    } catch {
                        try {
                            const result = await this.callNvidia(prompt, systemInstruction);
                            if (userId) await this.recordUsage(userId, 'nvidia', env.nvidiaModel);
                            return result;
                        } catch (err3) {
                            logger.error('AIService', 'TotalFail', 'All AI providers failed. Using safe fallback.', err3);
                            return this.getSafeFallback();
                        }
                    }
                }
                await new Promise(r => setTimeout(r, 2000));
            }
        }
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
            draft_reply: "Thank you for your email. I'll review this and get back to you shortly.",
            confidence: 100,
            requires_human: true,
            autonomy_level: 3,
            priority_score: 60,
            summary: 'Manual fallback response due to AI failure',
            intent: 'other'
        });
    }
};
