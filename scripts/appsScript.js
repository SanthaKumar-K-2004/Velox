/* eslint-disable */
/**
 * Velox — Google Apps Script Webhook Trigger
 * 
 * Instructions:
 * 1. Go to script.google.com and create a new project.
 * 2. Paste this entire code into Code.gs.
 * 3. Go to Project Settings (gear icon) -> Script Properties.
 * 4. Add two properties:
 *    - RENDER_URL : https://your-app.onrender.com/webhook/email
 *    - WEBHOOK_SECRET : (same as your .env WEBHOOK_SECRET)
 * 5. Run the `setupTrigger` function ONCE to authorize and create the 1-minute cron.
 */

function setupTrigger() {
    // Delete any existing triggers to prevent duplicates
    const triggers = ScriptApp.getProjectTriggers();
    for (let i = 0; i < triggers.length; i++) {
        ScriptApp.deleteTrigger(triggers[i]);
    }

    // Create a new time-driven trigger every 1 minute
    ScriptApp.newTrigger('processUnreadEmails')
        .timeBased()
        .everyMinutes(1)
        .create();

    Logger.log('✅ Trigger successfully installed.');
}

function processUnreadEmails() {
    const props = PropertiesService.getScriptProperties();
    const webhookUrl = props.getProperty('RENDER_URL');
    const secret = props.getProperty('WEBHOOK_SECRET');

    if (!webhookUrl || !secret) {
        Logger.log('❌ RENDER_URL or WEBHOOK_SECRET not set in Script Properties.');
        return;
    }

    // Find unread emails in the Inbox
    const threads = GmailApp.search('is:unread in:inbox', 0, 5);
    const userEmail = Session.getActiveUser().getEmail();

    for (let i = 0; i < threads.length; i++) {
        const messages = threads[i].getMessages();

        for (let j = 0; j < messages.length; j++) {
            const msg = messages[j];

            // Only process unread messages
            if (msg.isUnread()) {
                try {
                    const payload = {
                        messageId: msg.getId(),
                        threadId: msg.getThread().getId(),
                        subject: msg.getSubject(),
                        from: msg.getFrom(),
                        userEmail: userEmail,             // Required by Webhook
                        snippet: msg.getPlainBody().substring(0, 300),
                        timestamp: msg.getDate().toISOString(),
                        hasAttachment: msg.getAttachments().length > 0,
                        source: 'gmail_apps_script'
                    };

                    const options = {
                        method: 'post',
                        contentType: 'application/json',
                        headers: {
                            'X-Webhook-Secret': secret
                        },
                        payload: JSON.stringify(payload),
                        muteHttpExceptions: true // Don't crash GAS if backend is sleeping
                    };

                    const response = UrlFetchApp.fetch(webhookUrl, options);

                    if (response.getResponseCode() === 200 || response.getResponseCode() === 201) {
                        msg.markRead(); // Mark as read ONLY if webhook accepted it
                        Logger.log(`✅ Sent messageId: ${msg.getId()}`);
                    } else {
                        Logger.log(`⚠️ Retry later. Server responded: ${response.getResponseCode()}`);
                    }

                } catch (e) {
                    Logger.log(`❌ Failed to process message ${msg.getId()}: ${e.message}`);
                }
            }
        }
    }
}
