# 🧪 Testing & Deployment Guide

## 1. How to Test (Local)
Once your server is running (`pnpm start`), follow these steps to see it in action:

1.  **Open an Unread Email:** Log into your Gmail account. Mark an email as **Unread** in your Inbox.
2.  **Run the Trigger:** In your [Google Apps Script](https://script.google.com) project, manually run the `processUnreadEmails` function.
3.  **Check Logs:** Look at your local terminal. You should see:
    ```json
    {"agent":"Intake","action":"Inbound","message":"Email ingestion started: ..."}
    {"agent":"Pipeline","action":"Filter","message":"... → NEEDS_AI"}
    ```
4.  **Telegram Notification:** Your Telegram bot will send you a message with the AI-drafted reply and action buttons.

---

## 2. Setting Up Your "Email Handle" (Gmail Connector)
To make Velox handle all your incoming emails continuously:

1.  **Google Apps Script:** 
    - Copy `scripts/appsScript.js` to a new project at [script.google.com](https://script.google.com).
    - Under **Project Settings** -> **Script Properties**, add:
      - `RENDER_URL`: Your server URL (e.g., `http://YOUR_NGROK_URL.ngrok-free.app/webhook/email` for local testing or `https://app.onrender.com/webhook/email` for production).
      - `WEBHOOK_SECRET`: A secret string (must match your `.env`).
2.  **Enable Auto-Polling:** 
    - Run the `setupTrigger` function in the Apps Script editor. This creates a "Cron Job" that runs every 1 minute automatically.

---

## 4. Linking Multiple Gmail Accounts
Velox supports managing multiple Gmail accounts from a single Telegram chat.

1.  **Grant Access:** For each new Gmail account, visit the OAuth link provided by `/start` while logged into that specific Gmail account.
2.  **Install Apps Script:** Repeat Section 2 for **each** Gmail account you want Velox to monitor. 
    - You can use the same `RENDER_URL` and `WEBHOOK_SECRET` for all scripts.
    - Each script will automatically identify its account via `userEmail`.
3.  **Telegram Commands:** Use `/inbox`, `/sent`, and `/pending` to see combined activity across all linked accounts. Items will be prefixed with the account email for clarity.

---

## 3. Deployment (Production)
For a 24/7 autonomous agent, deploy to **Render.com**:

1.  **Push to GitHub:** Create a private repository and push this code.
2.  **Create Web Service on Render:**
    - Connect your GitHub repo.
    - Render will automatically detect the `render.yaml` file.
3.  **Configure Environment Variables:**
    - Fill in all the keys from your local `.env` into the Render dashboard.
    - **Crucial:** Your `GOOGLE_REDIRECT_URI` must be updated to `https://your-app.onrender.com/auth/google/callback`.
4.  **Update Google Cloud Console:**
    - Add your new Render URL to the "Authorized Redirect URIs" in the Google Cloud Credentials page.
5.  **Update Apps Script:**
    - Change the `RENDER_URL` property in Google Apps Script to your new production URL.

---

## 4. Telegram Bot Setup
1.  **BotFather:** If you haven't already, get your token from [@BotFather](https://t.me/botfather).
2.  **Privacy:** (Optional) If you want to use the bot in a group, disable "Privacy Mode" in BotFather.
3.  **Security:** Velox only responds to the user whose `TELEGRAM_CHAT_ID` matches the one in the `users` table after `/start`.
