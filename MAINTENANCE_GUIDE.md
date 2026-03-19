# 🛠️ Velox — Post-Deployment & Maintenance Guide

Congratulations! Your Velox AI Agent is live. This guide explains how to monitor, maintain, and troubleshoot your production instance.

---

## 📊 1. Daily Monitoring

### Telegram /status Command
The easiest way to check if everything is running correctly is via the bot:
- Run `/status` in your Telegram chat.
- **What to look for:**
    - `API Usage`: Ensure Gemini and Google API counts are increasing (meaning emails are being processed).
    - `Last Check`: Should be within the last few minutes (if you set up cron-job.org).

### Render.com Logs
- Go to your **Render Dashboard → Dashboard → [Your App] → Logs**.
- Look for:
    - `Webhook Received`: Confirms Gmail is communicating with your server.
    - `AI Response Generated`: Confirms Gemini is successfully drafting emails.
    - `Email Sent`: Confirms the final delivery through Gmail API.

---

## 🗄️ 2. Database Maintenance (Supabase)

### Key Tables to Watch
- `api_usage`: Monitor your costs and token consumption.
- `email_history`: Audit how the AI is responding to your emails and what was sent.
- `health_check`: Ensure common pings are being recorded.

### Data Retention
As your `email_history` grows, you might want to occasionally clear old logs:
```sql
-- Optional: Delete logs older than 90 days
DELETE FROM email_history WHERE created_at < NOW() - INTERVAL '90 days';
```

---

## 🔑 3. Google API Quotas

Google Cloud APIs have daily free quotas:
- **Gmail API:** Very generous (tens of thousands of requests).
- **Gemini 2.0:** Free tier has a limit of **10 RPM** (Requests Per Minute) and **1M TPM** (Tokens Per Minute).
- **Action:** If you see `429 Too Many Requests` in your logs, you might be hitting Gemini limits during a sudden influx of emails.

---

## 🔄 4. Token Refresh Logic
Velox handles OAuth2 token refreshing automatically. However, if your agent ever stops processing:
1.  Run `/start` in Telegram.
2.  Click the **Connection Link** again.
3.  Re-authorize the account. This will force-refresh the stored credentials in Supabase.

---

## 🚧 5. Common Troubleshooting

| Issue | Likely Cause | Solution |
| :--- | :--- | :--- |
| **No Telegram Alerts** | Webhook secret mismatch | Compare `WEBHOOK_SECRET` in `.env` and AppScript. |
| **"Error: Token Expired"** | Refresh token revoked | Re-authenticate via the `/start` link. |
| **"Database Error"** | Supabase paused | Visit Supabase dashboard to resume or check cron-job.org. |
| **Aesthetics are "basic"** | Missing frontend | Velox is a **headless agent**; all interactions happen via Telegram. |

---

## 💡 Support
This project was developed by **AlphaXSolutions**. If you encounter critical bugs, review your `logs/` directory for detailed stack traces.

---

Presented with ❤️ by **AlphaXSolutions**.
