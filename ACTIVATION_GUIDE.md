# 🎯 Velox — Final Activation Guide

Your app is live at: `https://velox-f2uy.onrender.com` 🚀

Follow these 3 exact steps to activate the system.

---

## 1️⃣ Update Google Cloud (OAuth)
1.  Go to the [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2.  Edit your **OAuth 2.0 Client ID**.
3.  In **Authorized redirect URIs**, add this exact line:
    - `https://velox-f2uy.onrender.com/auth/google/callback`
4.  Click **SAVE**.

---

## 2️⃣ Update Google Apps Script (Webhook)
1.  Open your [Google Apps Script project](https://script.google.com).
2.  Update the `WEBHOOK_URL` at the top:
    ```javascript
    const WEBHOOK_URL = "https://velox-f2uy.onrender.com/webhook/email";
    ```
3.  Click **Deploy** → **Manage Deploys** → **Edit** (pencil icon) → **Version: New Version**.
4.  Click **Deploy**.

---

## 3️⃣ Update Render Variables
1.  Go to your [Render Dashboard](https://dashboard.render.com).
2.  Select your service `velox-f2uy`.
3.  Go to **Environment**.
4.  Ensure `GOOGLE_REDIRECT_URI` is set to:
    - `https://velox-f2uy.onrender.com/auth/google/callback`
5.  Click **Save Changes**.

---

## ✅ Final Test
1.  Go to [https://velox-f2uy.onrender.com/health](https://velox-f2uy.onrender.com/health).
    - If you see `{"status":"up"}`, your server is perfect.
2.  Open your Telegram bot and type `/start`.
3.  Connect your Gmail.

---

Presented by **AlphaXSolutions**.
