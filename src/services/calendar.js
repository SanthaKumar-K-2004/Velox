import { google } from 'googleapis';
import { gmailService } from './gmail.js';
import { logger } from '../utils/logger.js';

/**
 * Google Calendar Service
 */
export const calendarService = {

    async getClient(userId, userEmail) {
        const auth = await gmailService.getAuthClient(userId, userEmail);
        return google.calendar({ version: 'v3', auth });
    },

    /**
     * Checks availability for a specific time range.
     */
    async checkAvailability(userId, timeMin, timeMax, userEmail) {
        try {
            const calendar = await this.getClient(userId, userEmail);
            const res = await calendar.events.list({
                calendarId: 'primary',
                timeMin: new Date(timeMin).toISOString(),
                timeMax: new Date(timeMax).toISOString(),
                singleEvents: true,
                orderBy: 'startTime',
            });

            const events = res.data.items || [];
            return {
                free: events.length === 0,
                conflicts: events.map((event) => ({
                    summary: event.summary,
                    start: event.start.dateTime || event.start.date,
                    end: event.end.dateTime || event.end.date,
                })),
            };
        } catch (err) {
            logger.error('CalendarService', 'CheckAvailability', `Error for user ${userId}`, err);
            return { free: true, conflicts: [] };
        }
    },
};
