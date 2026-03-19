# 🎯 Velox — 24/7 Keep-Alive Setup (cron-job.org)

To prevent your Render.com free instance from sleeping and your Supabase project from pausing, follow this guide to set up a free monitoring service.

---

## ⚡ What This Solves
- **Render Free Tier:** Typically sleeps after 15 minutes of inactivity.
- **Supabase Free Tier:** Pauses after 1 week of inactivity.
- **Result:** Your Velox AI Agent stays awake 24/7 to process emails instantly.

---

## 🛠️ Step 1 — Create Account
1.  Go to [cron-job.org](https://cron-job.org).
2.  Sign up for a free account and verify your email.
3.  Log in to your dashboard.

---

## 🩺 Step 2 — Create the Server Keep-Alive
1.  Click **"CREATE CRONJOB"** (top right).
2.  **Title:** `Velox Server Keep Alive`
3.  **URL:** `https://your-app-name.onrender.com/health` (Update with your actual URL after deployment).
4.  **Schedule:** Set to **"Every 10 minutes"**.
5.  **Request Method:** `GET`
6.  Click **CREATE**.

---

## 🗄️ Step 3 — Create the Supabase Keep-Alive
1.  Click **"CREATE CRONJOB"** again.
2.  **Title:** `Velox Database Keep Alive`
3.  **URL:** `https://your-app-name.onrender.com/health/db`
4.  **Schedule:** Set to **"Every day"** (at 8:00 AM).
5.  **Request Method:** `GET`
6.  Click **CREATE**.

---

## 📊 Dashboard Overview
Once set up, your dashboard should show both jobs as `✅ OK`.

| Job Name | Frequency | Target | Purpose |
| :--- | :--- | :--- | :--- |
| Velox Server | 10 mins | `/health` | Prevents Render from sleeping |
| Velox DB | Daily | `/health/db` | Prevents Supabase from pausing |

---

## 💡 Pro Tip: Failure Alerts
In the job settings, enable **"Notify me when job fails"**. This ensures you get an email immediately if your server or database encounters any issues.

---

Presented by **AlphaXSolutions**.
