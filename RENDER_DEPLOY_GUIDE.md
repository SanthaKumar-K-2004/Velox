# 🚀 Velox — Master Deployment Guide (Render & Google)

Follow these 5 steps to get your Velox AI Agent running in production.

---

## 🏗️ Step 1 — Render.com Setup
1.  Go to [Render.com](https://render.com) and create a **New Web Service**.
2.  Connect your GitHub repository: `SanthaKumar-K-2004/Velox`.
3.  **Settings:**
    - **Runtime:** `Node`
    - **Build Command:** `pnpm install`
    - **Start Command:** `npm start`
    - **Instance Type:** `Free` (or higher)

---

## 🔑 Step 2 — Environment Variables
In your Render dashboard, go to **Environment** and add the following keys from your local `.env`:

| Key | Value Source |
| :--- | :--- |
| `SUPABASE_URL` | Supabase Settings → API |
| `SUPABASE_SERVICE_KEY` | Supabase Settings → API (service_role) |
| `GEMINI_API_KEY` | Google AI Studio |
| `TELEGRAM_BOT_TOKEN` | @BotFather |
| `GOOGLE_CLIENT_ID` | Google Cloud Console → Credentials |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console → Credentials |
| `GOOGLE_REDIRECT_URI` | `https://your-app-name.onrender.com/auth/google/callback` |
| `WEBHOOK_SECRET` | Any long random string (must match Apps Script) |

---

## 🔗 Step 3 — Google Apps Script (Webhook)
To let Gmail "talk" to your Render server, you need the Apps Script bridge:
1.  Go to [script.google.com](https://script.google.com).
2.  Create a new project.
3.  Copy the code from your local `scripts/appsScript.js` into the editor.
4.  **Update the variables** at the top of the script:
    - `WEBHOOK_URL`: `https://your-app-name.onrender.com/webhook/email`
    - `WEBHOOK_SECRET`: (The same secret you put in Render)
5.  **Deploy** as a "Web App":
    - Execute as: `Me`
    - Who has access: `Anyone`
6.  **Authorize** the script when prompted.

---

## 🧪 Step 4 — Verification
Once Render shows "Live":
1.  Visit `https://your-app-name.onrender.com/health` in your browser.
2.  It should return `{"status":"up", ...}`.
3.  Open your Telegram bot and type `/start`.

---

## ♾️ Step 5 — 24/7 Uptime
Follow the [DEPLOYMENT_KEEP_ALIVE.md](DEPLOYMENT_KEEP_ALIVE.md) guide to ensure your free-tier server never sleeps.

---

Presented by **AlphaXSolutions**.
