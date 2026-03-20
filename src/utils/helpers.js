/**
 * Utility helper functions shared across agents and services
 */
export const helpers = {
    /**
     * Safely extract JSON from an AI response string that might be wrapped in Markdown
     * @param {string} str - Raw string response from AI
     * @returns {string} - Cleaned string intended for JSON.parse()
     */
    extractJSON(str) {
        if (!str || typeof str !== 'string') return '{}';

        // Try to find JSON in markdown code blocks first
        const codeBlockMatch = str.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlockMatch) return codeBlockMatch[1].trim();

        const startIndex = str.search(/[[{]/);
        if (startIndex === -1) {
            return str.trim();
        }

        const openingChar = str[startIndex];
        const closingChar = openingChar === '{' ? '}' : ']';
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let i = startIndex; i < str.length; i++) {
            const char = str[i];

            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === '\\') {
                escaped = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (inString) {
                continue;
            }

            if (char === openingChar) {
                depth++;
            } else if (char === closingChar) {
                depth--;
                if (depth === 0) {
                    return str.slice(startIndex, i + 1).trim();
                }
            }
        }

        return str.trim();
    },

    parseJSON(str, fallback = {}) {
        try {
            return JSON.parse(this.extractJSON(str));
        } catch {
            return fallback;
        }
    },

    clampNumber(value, min, max, fallback) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(max, Math.max(min, parsed));
    },

    asBoolean(value, fallback = false) {
        if (typeof value === 'boolean') {
            return value;
        }

        if (typeof value === 'string') {
            if (value.toLowerCase() === 'true') return true;
            if (value.toLowerCase() === 'false') return false;
        }

        return fallback;
    },

    cleanText(value, fallback = null) {
        if (typeof value !== 'string') {
            return fallback;
        }

        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : fallback;
    },

    buildReplySubject(subject) {
        const cleanSubject = this.cleanText(subject, 'No subject');
        return /^re:/i.test(cleanSubject) ? cleanSubject : `Re: ${cleanSubject}`;
    }
};
