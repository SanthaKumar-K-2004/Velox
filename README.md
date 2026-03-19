# ⚡ V E L O X — AI Email Agent

Velox is a production-grade, autonomous AI email copilot built with a modular **10-agent architecture**. It doesn't just filter your emails—it builds deep context, learns your writing style, manages your document vault, and notifies you interactively via Telegram.

---

## 🚀 How it Works (10-Agent System)

Velox uses a specialized "Assembly Line" of agents to process every incoming email:

1.  **Intake Agent:** Receives emails via webhook, ensures idempotency (no duplicates), and locks records for processing.
2.  **Filter Agent:** Performs lightning-fast classification into buckets: *Always Notify* (OTPs/Payments), *Store & Digest* (Newsletters), *Trash*, or *Needs AI*.
3.  **Context Builder:** The "Researcher." It pulls thread history, your core identity, calendar availability, and relevant documents from your vault.
4.  **AI Brain:** The "Author." Uses Gemini/DeepSeek to analyze intent and draft a personalized reply in your specific tone.
5.  **Autonomy Agent:** The "Manager." Decides between Level 1 (Draft Ready), Level 2 (Auto-send with undo window), or Level 3 (Hard Stop for meetings/sensitive topics).
6.  **Document Vault:** Analyzes attachments (Invoices/Docs) via Vision AI, indexes them at 4 different granularities, and stores them securely.
7.  **Notification Agent:** Formats and sends interactive Telegram messages with action buttons (Send, Edit, Reject, Vault).
8.  **Send Agent:** The sole interface for the Gmail API. Handles secure sending and provides a 15-minute "Undo" window.
9.  **Memory Agent:** Learns from every sent email and user interaction to refine its understanding of your tone and preferences.
10. **Mentor Agent:** Proactively sends morning digests, identifies follow-up tasks, and monitors system health.

---

## 🛠️ Setup Guide

### 1. Database (Supabase)
1. Create a project at [supabase.com](https://supabase.com).
2. Run the SQL located in `scripts/setup.js` in your Supabase SQL Editor to create the 10 required tables.
3. Grab your `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.

### 2. Messaging (Telegram)
1. Message [@BotFather](https://t.me/botfather) to create a new bot.
2. Copy the `TELEGRAM_BOT_TOKEN`.
3. Message your new bot and get your own `CHAT_ID` (you can use [@userinfobot](https://t.me/userinfobot)).

### 3. Google Cloud (Email/Calendar)
1. Go to [Google Cloud Console](https://console.cloud.google.com).
2. Create a project and enable: **Gmail API**, **Google Calendar API**.
3. Create **OAuth 2.0 Client IDs** (Web Application).
4. Add `http://localhost:3000/auth/google/callback` to Authorized Redirect URIs.

### 4. Setup Your "Email Handle" (Google Apps Script)
This is the part that connects your actual Gmail to Velox:
1. Go to [script.google.com](https://script.google.com).
2. Create a "New Project".
3. Copy the code from `scripts/appsScript.js` into the editor.
4. In Project Settings, add these **Script Properties**:
   - `RENDER_URL`: Your Velox server URL (e.g., `https://your-app.render.com`)
   - `WEBHOOK_SECRET`: A secret string you choose (must match your `.env`).
5. Set a **Time-based Trigger** to run `main` every 1 minute.

### 5. Environment Config
Rename `.env.example` to `.env` and fill in all keys.

---

## 📱 How to Use

1. **Start the Server:** `pnpm start`
2. **Onboarding:** Type `/start` in your Telegram bot. Click the link to connect your Gmail.
3. **Daily Use:**
   - **Notifications:** You'll get a message for every important email.
   - **Buttons:** Use [✅ Send], [📝 Edit], or [🗑️ Reject] directly in Telegram.
   - **Vault:** Type `/vault` to see recent docs or `/find [keyword]` to search.
   - **Natural Language:** Just chat! *"Search for that Zomato invoice"* or *"Pause auto-sends for 2 hours"*.

---

## 📈 Autonomy Levels
- **Level 1:** Draft is ready for your review. One click to send.
- **Level 2:** Auto-sent after 3-5 minutes (unless you hit [Undo]).
---

## 🧭 Next Steps
1.  **Read the [Deployment & Testing Guide](file:///c:/Users/santh/Desktop/E-Mail AI Agent/deployment_guide.md)** for a detailed walkthrough on how to see Velox in action.
2.  **Run `pnpm start`** to keep the server alive while you set up your Google Apps Script trigger.

