import { supabase } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

/**
 * Agent 1 - Intake Agent
 * First receiver of all inputs. deduplicates and queues.
 */
export const intakeAgent = {
    /**
     * Main entry point for email intake
     * @param {Object} emailData - Data received from Apps Script
     * @returns {Promise<Object|null>} - Processed record or null if duplicate
     */
    async processEmail(emailData) {
        const { messageId, userEmail } = emailData;

        const isDuplicate = await this.checkDuplicate(messageId, userEmail);
        if (isDuplicate) {
            logger.info('Intake', 'Duplicate', `Duplicate email detected: ${messageId} (${userEmail}). Skipping.`);
            return null;
        }

        const record = await this.lockEmail(emailData);
        if (!record) {
            return null;
        }

        logger.info('Intake', 'Inbound', `Email ingestion started: ${messageId}`);
        return record;
    },

    /**
     * Checks if an email has already been processed for a specific Gmail account.
     */
    async checkDuplicate(messageId, userEmail) {
        const { data } = await supabase
            .from('processed_emails')
            .select('message_id')
            .eq('message_id', messageId)
            .eq('user_email', userEmail)
            .maybeSingle();

        return !!data;
    },

    /**
     * Inserts a record into processed_emails to prevent race conditions.
     */
    async lockEmail(emailData) {
        const { messageId, userId } = emailData;

        const { data, error } = await supabase
            .from('processed_emails')
            .insert({
                message_id: messageId,
                user_id: userId,
                user_email: emailData.userEmail,
                status: 'processing',
                locked_at: new Date().toISOString(),
            })
            .select()
            .single();

        if (error) {
            logger.error('Intake', 'LockError', `Error locking email ${messageId}: ${error.message}`);
            return null;
        }

        return data;
    },

    /**
     * Updates the status of a processed email.
     */
    async updateStatus(messageId, userEmail, status) {
        await supabase
            .from('processed_emails')
            .update({
                status,
                completed_at: status === 'done' ? new Date().toISOString() : null,
            })
            .eq('message_id', messageId)
            .eq('user_email', userEmail);
    },
};
