import { aiService } from '../services/ai.js';
import { logger } from '../utils/logger.js';
import { helpers } from '../utils/helpers.js';

/**
 * Agent 4 — AI Brain Agent
 * The ONLY agent that calls Gemini.
 * One structured call per email. Returns complete JSON.
 */
export const aiBrainAgent = {

    /**
     * Main brain loop — analyze email and produce structured decision
     */
    async process(userId, context) {
        const systemPrompt = this.buildSystemPrompt(context);
        const userPrompt = this.buildUserPrompt(context);

        try {
            const rawResponse = await aiService.callAI(userPrompt, systemPrompt, userId);
            const parsed = helpers.parseJSON(rawResponse, {});
            const result = this.normalizeResult(parsed);

            logger.info('AIBrain', 'Decision', `Confidence: ${result.confidence}% | Intent: ${result.intent} | Priority: ${result.priority_score}`);
            return result;

        } catch (err) {
            logger.error('AIBrain', 'ProcessError', `Failed for email ${context.email.messageId}`, err);
            return this.normalizeResult(helpers.parseJSON(aiService.getSafeFallback(), {}));
        }
    },

    normalizeResult(parsed = {}) {
        const result = {
            skip: helpers.asBoolean(parsed.skip, false),
            classification: helpers.cleanText(parsed.classification, 'unknown'),
            priority_score: helpers.clampNumber(parsed.priority_score, 0, 100, 50),
            urgency: helpers.cleanText(parsed.urgency, 'medium'),
            summary: helpers.cleanText(parsed.summary, 'Email received'),
            intent: helpers.cleanText(parsed.intent, 'other'),
            hard_stop: helpers.asBoolean(parsed.hard_stop, false),
            hard_stop_reason: helpers.cleanText(parsed.hard_stop_reason),
            draft_reply: helpers.cleanText(parsed.draft_reply),
            holding_reply: helpers.cleanText(parsed.holding_reply),
            confidence: helpers.clampNumber(parsed.confidence, 0, 100, 0),
            autonomy_level: helpers.clampNumber(parsed.autonomy_level, 1, 3, 3),
            requires_human: helpers.asBoolean(parsed.requires_human, true),
            requires_human_reason: helpers.cleanText(parsed.requires_human_reason),
            follow_up_needed: helpers.asBoolean(parsed.follow_up_needed, false),
            follow_up_in_days: parsed.follow_up_in_days == null
                ? null
                : helpers.clampNumber(parsed.follow_up_in_days, 1, 365, null),
            language_detected: helpers.cleanText(parsed.language_detected, 'en'),
            entities: typeof parsed.entities === 'object' && parsed.entities !== null
                ? parsed.entities
                : { dates: [], amounts: [], names: [], deadlines: [] },
        };

        if (result.hard_stop) {
            result.requires_human = true;
            result.autonomy_level = 3;
        }

        if (!result.draft_reply && !result.holding_reply) {
            result.requires_human = true;
            result.autonomy_level = 3;
            result.requires_human_reason = result.requires_human_reason || 'No safe draft was produced';
        }

        return result;
    },

    /**
     * Build the system instructions with full rules, memory, and context
     */
    buildSystemPrompt(context) {
        const mem = context.core_memory || {};
        const contact = context.contact_memory;
        const calendar = context.calendar_data;

        let prompt = `
SYSTEM ROLE:
You are the AI brain of ${mem.user_name || 'User'}'s personal email assistant called Velox.
You analyse emails and write replies AS ${mem.user_name || 'User'}.
You are NOT a suggestion engine. You write exactly how they write.

IDENTITY:
- Name: ${mem.user_name || 'User'}
- Role: ${mem.user_role || 'Professional'}
- Tone: ${mem.tone_style || 'friendly'}
- Sign-off: ${mem.sign_off || 'Best,'}
- Language: ${mem.language || 'en'}
- Average reply length: ${mem.avg_reply_length || 'medium'}
- Phrase Bank: ${mem.phrase_bank?.join(', ') || 'none'}
- Writing Quirks: ${mem.writing_quirks?.join(', ') || 'none'}
- Editing Patterns: ${mem.edit_patterns?.join(', ') || 'none'}`;

        // Inject contact memory (Tier 2) if known sender
        if (contact) {
            prompt += `

RELATIONSHIP WITH SENDER:
- Name: ${contact.contact_name || 'Unknown'}
- Relationship: ${contact.relationship || 'unknown'}
- History: ${contact.history_note || 'No history'}
- Preferred tone: ${contact.preferred_tone || mem.tone_style || 'friendly'}
- VIP: ${contact.is_vip ? 'YES — treat with priority' : 'No'}`;
        }

        // Inject Topic Memory (Tier 3)
        if (context.topic_memory) {
            prompt += `
            
PAST PATTERN FOR THIS TOPIC (${context.topic_memory.intent}):
- Pattern: ${context.topic_memory.pattern || 'none'}
- Preferred response: ${context.topic_memory.preferred_response || 'none'}`;
        }

        // Inject calendar data if available
        if (calendar) {
            prompt += `

CALENDAR STATUS:
- Free: ${calendar.free ? 'Yes' : 'No'}
- Conflicts: ${calendar.conflicts?.map(c => c.summary).join(', ') || 'None'}`;
        }

        // Night time context
        if (context.is_night_time) {
            prompt += `

NIGHT TIME: User is likely asleep. Holding reply preferred.`;
        }

        // User away context
        if (context.user_away) {
            prompt += `

USER AWAY: User is away. Generate holding reply with time estimate.`;
        }

        prompt += `

CORE RULES — READ THESE FIRST:
1. NEVER send without user permission unless whitelisted
2. Meeting/schedule/time/availability = always requires_human: true
3. Financial commitment = always requires_human: true
4. First contact from unknown = always requires_human: true
5. Unseen attachment = always requires_human: true
6. Legal language = always requires_human: true
7. NEVER sound like AI. No "As an AI", no "I hope this finds you well"
8. NEVER guess or assume facts you don't have
9. NEVER make promises on behalf of the user
10. NEVER confirm meetings — draft the reply, user confirms
11. Reply in same language as the incoming email
12. Keep replies under 80 words unless complexity demands more
13. If the email body is incomplete or ambiguous, set "draft_reply" to null rather than guessing
14. Never mention attachments, timelines, prior conversations, deliveries, payments, or decisions unless explicitly present in the context
15. When facts are missing, prefer "requires_human": true with a truthful reason

HARD STOP DETECTED: ${context.isHardStop ? 'TRUE — this email requires human review' : 'FALSE'}

OUTPUT FORMAT — STRICT JSON, NO EXCEPTIONS:
{
  "skip": false,
  "classification": "client | colleague | vendor | personal | unknown",
  "priority_score": 0-100,
  "urgency": "high | medium | low",
  "summary": "one sentence maximum",
  "intent": "meeting_request | question | status_update | complaint | document_request | payment | follow_up | fyi | other",
  "hard_stop": true/false,
  "hard_stop_reason": "null or reason string",
  "entities": { "dates": [], "amounts": [], "names": [], "deadlines": [] },
  "draft_reply": "full draft reply as ${mem.user_name || 'User'}",
  "holding_reply": "null or holding reply if confidence low",
  "confidence": 0-100,
  "autonomy_level": 1|2|3,
  "requires_human": true/false,
  "requires_human_reason": "null or reason string",
  "follow_up_needed": true/false,
  "follow_up_in_days": null or number,
  "language_detected": "en | ta | hi | other"
}`;

        return prompt;
    },

    /**
     * Build the user prompt with email content and thread history
     */
    buildUserPrompt(context) {
        const { email, thread_history } = context;
        const body = helpers.cleanText(email.body, '');
        const snippet = helpers.cleanText(email.snippet, '');
        const timestamp = helpers.cleanText(email.timestamp || email.date, 'Unknown');
        const fromName = helpers.cleanText(email.fromName, '');
        const from = helpers.cleanText(email.from, 'Unknown sender');
        const subject = helpers.cleanText(email.subject, 'No subject');

        let historyStr = '';
        if (thread_history && thread_history.length > 0) {
            historyStr = '\nTHREAD HISTORY (last 5 messages):\n' +
                thread_history.map(m => `  ${m.from} (${m.date}): ${m.snippet}`).join('\n');
        }

        return `
PROCESS THIS EMAIL:
From: ${fromName ? `${fromName} <${from}>` : from}
Subject: ${subject}
Body:
${body || '[body unavailable]'}

Snippet:
${snippet || '[snippet unavailable]'}

Timestamp: ${timestamp}
Has attachment: ${email.hasAttachment || false}
${historyStr}

Respond with the structured JSON only. No explanation, no markdown, just JSON.`;
    }
};
