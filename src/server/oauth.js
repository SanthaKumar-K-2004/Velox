import express from 'express';
import { google } from 'googleapis';
import { env } from '../config/env.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/**
 * Google OAuth Scopes required by Velox
 */
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
];

function getOAuth2Client() {
    return new google.auth.OAuth2(
        env.googleClientId,
        env.googleClientSecret,
        env.googleRedirectUri
    );
}

function normalizeEmail(email) {
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * GET /auth/google
 * Redirects the user to Google's OAuth consent screen.
 * Accepts userId to pass through the state parameter.
 */
router.get('/', (req, res) => {
    const { userId } = req.query;
    const oauth2Client = getOAuth2Client();

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
        state: userId,
    });

    logger.info('OAuth', 'ConsentRedirect', `Redirecting user ${userId || 'unknown'} to Google`);
    res.redirect(authUrl);
});

/**
 * GET /auth/google/callback
 * Handles the OAuth callback, exchanges code for tokens, and stores them in user_accounts.
 */
router.get('/callback', async (req, res) => {
    const { code, state: userId, error: oauthError } = req.query;

    if (oauthError) {
        logger.error('OAuth', 'Callback', `OAuth error: ${oauthError}`);
        return res.status(400).send(`OAuth Error: ${oauthError}`);
    }

    if (!code) {
        return res.status(400).send('Missing authorization code');
    }

    if (!userId) {
        return res.status(400).send('Missing OAuth state');
    }

    try {
        const oauth2Client = getOAuth2Client();
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const { data: profile } = await oauth2.userinfo.get();
        const userEmail = normalizeEmail(profile.email);

        if (!userEmail) {
            logger.error('OAuth', 'Profile', 'Google profile did not return an email address');
            return res.status(400).send('Unable to determine Gmail account email');
        }

        logger.info('OAuth', 'TokenExchange', `Tokens received for ${userEmail} (state: ${userId})`);

        const { error: dbError } = await supabase
            .from('user_accounts')
            .upsert({
                user_id: userId,
                email: userEmail,
                gmail_token: tokens,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'email' });

        if (dbError) {
            logger.error('OAuth', 'SaveTokens', 'Failed to save tokens to user_accounts', dbError);
            return res.status(500).send('Failed to save authorization. Please try again.');
        }

        logger.info('OAuth', 'Complete', `OAuth completed for ${userEmail} (user: ${userId})`);

        return res.send(`
            <!DOCTYPE html>
            <html>
            <head><title>Velox Connected</title></head>
            <body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #fff;">
                <div style="text-align: center; padding: 2rem;">
                    <h1 style="font-size: 2.5rem;">Velox</h1>
                    <p style="color: #4ade80; font-size: 1.2rem;">Gmail account connected successfully</p>
                    <p style="color: #888; margin-top: 1rem;">${userEmail}</p>
                    <p style="color: #666; margin-top: 2rem;">You can close this window and return to Telegram.</p>
                </div>
            </body>
            </html>
        `);
    } catch (err) {
        logger.error('OAuth', 'Callback', 'Token exchange failed', err);
        return res.status(500).send('Authorization failed. Please try again.');
    }
});

export default router;
