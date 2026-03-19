import { supabase } from '../config/supabase.js';
import { gmailService } from '../services/gmail.js';
import { calendarService } from '../services/calendar.js';
import { memoryAgent } from './memory.js';
import { logger } from '../utils/logger.js';

/**
 * Agent 3 — Context Builder Agent
 * Prepares everything Agent 4 needs before the AI call.
 * Fetches thread history, injects tiered memory,
 * checks calendar, pulls relevant vault docs.
 * Maximum 450 tokens of context injected — never more.
 */
export const contextBuilderAgent = {

    /**
     * Builds the complete context package for Agent 4
     */
    async buildContext(userId, emailData, userEmail) {
        const { messageId, threadId, from, subject } = emailData;

        try {
            // 1. Fetch User Memory — Tier 1 (always inject)
            const coreMemory = await memoryAgent.getCoreMemory(userId);

            // 2. Fetch Contact Memory — Tier 2 (only if sender is known)
            const contactMemory = await memoryAgent.getContactMemory(userId, from);

            // 3. Fetch Topic Memory — Tier 3 (experimental)
            // We'll determine intent roughly from subject for now, 
            // the AI Brain will use it if it matches.
            const topicMemory = await memoryAgent.getTopicMemory(userId, subject?.toLowerCase());

            // 4. Fetch Thread History
            let threadHistory = [];
            try {
                threadHistory = await gmailService.getThreadHistory(userId, threadId, userEmail);
            } catch (err) {
                logger.debug('ContextBuilder', 'ThreadHistory', `Could not fetch thread for ${threadId}: ${err.message}`);
            }

            // 4. Fetch Calendar Data (if email seems scheduling related)
            const calendarData = await this.getCalendarData(userId, emailData, userEmail);

            // 5. Fetch Vault Relevant Docs (by subject search)
            const vaultDocs = await this.getVaultDocs(userId, subject);

            // 6. Check Time of Day (Night time check)
            const isNightTime = this.checkNightTime(coreMemory);

            // 7. Check User Away Status
            const userAway = await this.checkUserAway(userId);

            return {
                email: emailData,
                thread_history: threadHistory,
                core_memory: coreMemory || this.getDefaultMemory(),
                contact_memory: contactMemory,
                topic_memory: topicMemory,
                calendar_data: calendarData,
                vault_relevant_docs: vaultDocs,
                is_night_time: isNightTime,
                user_away: userAway,
                isHardStop: false,
                timestamp: new Date().toISOString(),
            };

        } catch (err) {
            logger.error('ContextBuilder', 'BuildError', `Failed for email ${messageId}`, err);
            // Return minimal context rather than failing entirely
            return {
                email: emailData,
                thread_history: [],
                core_memory: this.getDefaultMemory(),
                contact_memory: null,
                calendar_data: null,
                vault_relevant_docs: [],
                is_night_time: false,
                user_away: false,
                isHardStop: false,
                timestamp: new Date().toISOString(),
            };
        }
    },



    /**
     * Calendar data (if email mentions scheduling keywords)
     */
    async getCalendarData(userId, email, userEmail) {
        const content = `${email.subject || ''} ${email.snippet || ''}`.toLowerCase();
        const schedulingKeywords = ['meet', 'call', 'schedule', 'available', 'free', 'calendar'];

        if (!schedulingKeywords.some(k => content.includes(k))) {
            return null;
        }

        try {
            const now = new Date();
            const threeDaysLater = new Date();
            threeDaysLater.setDate(now.getDate() + 3);
            return await calendarService.checkAvailability(userId, now, threeDaysLater, userEmail);
        } catch (err) {
            logger.debug('ContextBuilder', 'Calendar', `Could not check calendar: ${err.message}`);
            return null;
        }
    },

    /**
     * Vault document search by subject
     */
    async getVaultDocs(userId, subject) {
        if (!subject) return [];

        try {
            const { data } = await supabase
                .from('vault_metadata')
                .select('id, doc_type, vendor, summary, doc_date')
                .eq('user_id', userId)
                .ilike('summary', `%${subject.substring(0, 30)}%`)
                .limit(3);

            return data || [];
        } catch {
            return [];
        }
    },

    /**
     * Check if current time falls within user's sleep hours
     */
    checkNightTime(memory) {
        const now = new Date();
        const hour = now.getHours();
        const start = memory.sleep_start || 22;
        const end = memory.sleep_end || 7;

        if (start > end) {
            return hour >= start || hour < end; // e.g., 22-7 wraps midnight
        } else {
            return hour >= start && hour < end;
        }
    },

    /**
     * Check if user is in "away" mode
     */
    async checkUserAway(userId) {
        try {
            const { data } = await supabase
                .from('user_status')
                .select('status, away_until')
                .eq('user_id', userId)
                .single();

            if (!data || data.status !== 'away') return false;

            // Check if away period has expired
            if (data.away_until && new Date(data.away_until) < new Date()) {
                // Auto-return from away
                await supabase
                    .from('user_status')
                    .update({ status: 'active', updated_at: new Date().toISOString() })
                    .eq('user_id', userId);
                return false;
            }

            return true;
        } catch {
            return false;
        }
    },

    /**
     * Default memory fallback when user memory is not found
     */
    getDefaultMemory() {
        return {
            user_name: 'User',
            tone_style: 'friendly',
            sign_off: 'Regards,',
            avg_reply_length: 'medium',
            formality_score: 50,
            phrase_bank: [],
            writing_quirks: [],
            sleep_start: 22,
            sleep_end: 7,
        };
    },
};
