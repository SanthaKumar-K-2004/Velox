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

            // Parse JSON from AI response
            const cleaned = helpers.extractJSON(rawResponse);
            const parsed = JSON.parse(cleaned);

            // Ensure required fields exist with defaults
            const result = {
                skip: parsed.skip || false,
                classification: parsed.classification || 'unknown',
                priority_score: parsed.priority_score || 50,
                urgency: parsed.urgency || 'medium',
                summary: parsed.summary || 'Email received',
                intent: parsed.intent || 'other',
                hard_stop: parsed.hard_stop || false,
                hard_stop_reason: parsed.hard_stop_reason || null,
                draft_reply: parsed.draft_reply || null,
                holding_reply: parsed.holding_reply || null,
                confidence: parsed.confidence || 50,
                autonomy_level: parsed.autonomy_level || 1,
                requires_human: parsed.requires_human !== false,
                requires_human_reason: parsed.requires_human_reason || null,
                follow_up_needed: parsed.follow_up_needed || false,
                follow_up_in_days: parsed.follow_up_in_days || null,
                language_detected: parsed.language_detected || 'en',
                entities: parsed.entities || {},
            };

            logger.info('AIBrain', 'Decision', `Confidence: ${result.confidence}% | Intent: ${result.intent} | Priority: ${result.priority_score}`);
            return result;

        } catch (err) {
            logger.error('AIBrain', 'ProcessError', `Failed for email ${context.email.messageId}`, err);
            return JSON.parse(aiService.getSafeFallback());
        }
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

        let historyStr = '';
        if (thread_history && thread_history.length > 0) {
            historyStr = '\nTHREAD HISTORY (last 5 messages):\n' +
                thread_history.map(m => `  ${m.from} (${m.date}): ${m.snippet}`).join('\n');
        }

        return `
PROCESS THIS EMAIL:
From: ${email.fromName || ''} <${email.from}>
Subject: ${email.subject}
Body/Snippet: ${email.snippet || email.body || ''}
Timestamp: ${email.timestamp}
Has attachment: ${email.hasAttachment || false}
${historyStr}

Respond with the structured JSON only. No explanation, no markdown, just JSON.`;
    }
};
