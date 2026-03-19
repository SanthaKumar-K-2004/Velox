import { writeFile } from 'node:fs/promises';
import path from 'node:path';

async function setupDatabase() {
    console.log('Preparing Supabase database schema...');

    const sql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    telegram_chat_id TEXT UNIQUE,
    calendar_enabled BOOLEAN DEFAULT true,
    gemini_key_encrypted TEXT,
    plan TEXT DEFAULT 'free',
    onboarding_status TEXT DEFAULT 'not_started',
    onboarding_data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_accounts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    gmail_token JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_accounts_user_id_idx ON user_accounts(user_id);

CREATE TABLE IF NOT EXISTS memory (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    user_name TEXT,
    tone_style TEXT,
    formality_score INTEGER,
    avg_reply_length TEXT,
    common_phrases JSONB,
    phrase_bank JSONB,
    writing_quirks JSONB,
    sign_off TEXT,
    language TEXT,
    timezone TEXT,
    sleep_start INTEGER DEFAULT 22,
    sleep_end INTEGER DEFAULT 7,
    response_speed TEXT,
    edit_patterns JSONB,
    accuracy_score INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    bootstrapped_at TIMESTAMPTZ,
    emails_analysed INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contact_memory (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    contact_email TEXT,
    contact_name TEXT,
    relationship TEXT,
    history_note TEXT,
    preferred_tone TEXT,
    is_vip BOOLEAN DEFAULT false,
    is_ignored BOOLEAN DEFAULT false,
    last_contact TIMESTAMPTZ,
    email_count INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, contact_email)
);

CREATE TABLE IF NOT EXISTS topic_memory (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    intent TEXT NOT NULL,
    preferred_response JSONB,
    usage_count INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, intent)
);

CREATE TABLE IF NOT EXISTS processed_emails (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    message_id TEXT NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    user_email TEXT,
    status TEXT,
    locked_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    UNIQUE (message_id, user_email)
);

CREATE INDEX IF NOT EXISTS processed_emails_user_id_idx ON processed_emails(user_id);

CREATE TABLE IF NOT EXISTS email_history (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    user_email TEXT,
    message_id TEXT,
    thread_id TEXT,
    recipient TEXT,
    subject TEXT,
    ai_draft TEXT,
    final_sent TEXT,
    was_edited BOOLEAN,
    edit_diff JSONB,
    autonomy_level INTEGER,
    confidence INTEGER,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_history_user_id_idx ON email_history(user_id);

CREATE TABLE IF NOT EXISTS vault_metadata (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    file_path TEXT,
    file_hash TEXT,
    original_filename TEXT,
    file_type TEXT,
    size_kb INTEGER,
    doc_type TEXT,
    vendor TEXT,
    amount TEXT,
    doc_date DATE,
    expiry_date DATE,
    importance TEXT,
    summary TEXT,
    search_tags TEXT[],
    extracted_text TEXT,
    source TEXT,
    email_sender TEXT,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    file_expired BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS pending_sends (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    user_email TEXT,
    email_to TEXT,
    subject TEXT,
    body TEXT,
    attachments JSONB,
    thread_id TEXT,
    telegram_message_id TEXT,
    send_at TIMESTAMPTZ,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pending_sends_user_id_idx ON pending_sends(user_id);

CREATE TABLE IF NOT EXISTS follow_ups (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT,
    recipient TEXT,
    subject TEXT,
    sent_at TIMESTAMPTZ,
    follow_up_at TIMESTAMPTZ,
    status TEXT DEFAULT 'pending',
    reminder_sent BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS user_status (
    user_id PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'active',
    away_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auto_send_whitelist (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    email_intent TEXT,
    enabled BOOLEAN DEFAULT false,
    delay_mins INTEGER DEFAULT 3,
    undo_mins INTEGER DEFAULT 15,
    PRIMARY KEY (user_id, email_intent)
);

CREATE TABLE IF NOT EXISTS api_usage (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT,
    model TEXT,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_usd NUMERIC,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);
`;

    const outputPath = path.resolve(process.cwd(), 'scripts', 'setup.sql');
    await writeFile(outputPath, sql.trimStart(), 'utf8');

    console.log(`Schema written to ${outputPath}`);
    console.log('Run that SQL in your Supabase SQL editor.');
}

setupDatabase().catch((error) => {
    console.error('Error preparing database schema:', error.message);
    process.exitCode = 1;
});
