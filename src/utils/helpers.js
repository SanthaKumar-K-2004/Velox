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

        // Try to find raw JSON object or array
        const jsonMatch = str.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        return jsonMatch ? jsonMatch[0] : str;
    }
};
