# 🧪 Velox — Testing & Verification Guide

This guide ensures your Velox instance is correctly configured and handling emails autonomously.

---

## 🏗️ 1. Environment Verification

Before testing, ensure your backend is running:
- **Local:** `npm run dev` (Ensure your tunnel like Ngrok or Cloudflare is pointing to port 3000).
- **Production:** Check your Render.com dashboard logs.

**Health Check:**
Visit `https://your-domain.com/health`. You should see:
```json
{ "status": "UP", "version": "1.0.0", "uptime": "..." }
```

---

## 🔑 2. Authentication & Account Linking

1.  Open the Telegram bot you created via `@BotFather`.
2.  Type `/start`.
3.  Click the **Gmail Connection Link** provided.
4.  Authorize your Gmail account via Google.
5.  **Verification:** You should receive a Telegram message: *"✅ Gmail connected successfully! I am now monitoring [your-email@gmail.com]."*

---

## 📥 3. Basic Intake Test

1.  Send a **test email** from a *different* account to your connected Gmail address.
2.  Wait 10-20 seconds.
3.  **Verification:** 
    - The bot should notify you on Telegram with the sender, subject, and an **AI-generated summary/draft**.
    - Check the terminal/logs for: `Webhook Received: Email [ID] from [Sender]`.

---

## 👥 4. Multi-Account Verification

1.  Open the same `/start` link again but choose a **different Google Account** this time.
2.  **Verification:** The bot should confirm connection for the **second email**.
3.  Send an email to the *second* account.
4.  **Verification:** The Telegram notification should clearly show which account received the email: `[Email #2] — Subject: ...`

---

## ⚙️ 5. Command & Interaction Test

Try these commands to verify the logic agents:
- `/pending`: Should show any drafts waiting for your approval.
- `/status`: Verify the bot reports correct API usage and email counts.
- **Reply to a Draft:** Reply to an AI draft notification with "Send this".
    - **Verification:** The bot should confirm: `✅ Email queued to send via Gmail.`

---

## ⏰ 6. Scheduled Jobs (Mentor Agent)

To force-test scheduled jobs without waiting for 7 AM:
1.  In your Supabase dashboard, insert a dummy record into `user_accounts` if needed.
2.  The scheduler runs `consolidated_minute` every 60 seconds.
3.  **Verification:** Monitor logs for `Scheduler: AccountTask: Success`.

---

## 🛠️ Troubleshooting

- **No Notification?** Check the `WEBHOOK_SECRET` in both your AppScript and your `.env`.
- **Auth Error?** Ensure your `GOOGLE_REDIRECT_URI` exactly matches what's in the Google Cloud Console.
- **AI not responding?** Double-check your `GEMINI_API_KEY` status.

---

Presented by **AlphaXSolutions**.
