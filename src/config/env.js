import dotenv from 'dotenv';
import path from 'path';

// Load .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const requiredEnvVars = [
    'PORT',
    'NODE_ENV',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
    'TELEGRAM_BOT_TOKEN',
    'ENCRYPTION_KEY',
];

// Validate required variables
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        throw new Error(`Missing required environment variable: ${envVar}`);
    }
}

export const env = {
    port: process.env.PORT || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
  
    // Supabase
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY, // Optional, can use service key for backend
    supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
  
    // AI APIs
    geminiApiKey: process.env.GEMINI_API_KEY,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY || null,
    nvidiaApiKey: process.env.NVIDIA_API_KEY || null,
    nvidiaBaseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    nvidiaModel: process.env.NVIDIA_MODEL || 'moonshotai/kimi-k2-instruct',
  
    // Google OAuth
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: process.env.GOOGLE_REDIRECT_URI,
  
    // Telegram
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || null,
  
    // Security
    encryptionKey: process.env.ENCRYPTION_KEY,
    webhookSecret: process.env.WEBHOOK_SECRET || 'aaec_webhook_secret_change_this',
  
    // User Defaults
    userTimezone: process.env.USER_TIMEZONE || 'Asia/Kolkata',
    userName: process.env.USER_NAME || 'User',
};
