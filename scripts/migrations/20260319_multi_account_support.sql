CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS user_accounts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    gmail_token JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_accounts_user_id_idx ON user_accounts(user_id);

ALTER TABLE processed_emails ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();
ALTER TABLE processed_emails ADD COLUMN IF NOT EXISTS user_email TEXT;
ALTER TABLE email_history ADD COLUMN IF NOT EXISTS user_email TEXT;
ALTER TABLE pending_sends ADD COLUMN IF NOT EXISTS user_email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_status TEXT DEFAULT 'not_started';
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_data JSONB DEFAULT '{}'::jsonb;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'email'
    ) AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'gmail_token'
    ) THEN
        INSERT INTO user_accounts (user_id, email, gmail_token, created_at, updated_at)
        SELECT
            id,
            lower(trim(email)),
            gmail_token,
            COALESCE(created_at, NOW()),
            COALESCE(updated_at, NOW())
        FROM users
        WHERE email IS NOT NULL
          AND gmail_token IS NOT NULL
        ON CONFLICT (email) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            gmail_token = EXCLUDED.gmail_token,
            updated_at = EXCLUDED.updated_at;

        UPDATE processed_emails pe
        SET user_email = lower(trim(u.email))
        FROM users u
        WHERE pe.user_id = u.id
          AND pe.user_email IS NULL
          AND u.email IS NOT NULL;

        UPDATE email_history eh
        SET user_email = lower(trim(u.email))
        FROM users u
        WHERE eh.user_id = u.id
          AND eh.user_email IS NULL
          AND u.email IS NOT NULL;

        UPDATE pending_sends ps
        SET user_email = lower(trim(u.email))
        FROM users u
        WHERE ps.user_id = u.id
          AND ps.user_email IS NULL
          AND u.email IS NOT NULL;
    END IF;
END $$;

UPDATE processed_emails
SET id = gen_random_uuid()
WHERE id IS NULL;

ALTER TABLE processed_emails DROP CONSTRAINT IF EXISTS processed_emails_pkey;
ALTER TABLE processed_emails ADD CONSTRAINT processed_emails_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX IF NOT EXISTS processed_emails_message_account_key
    ON processed_emails (message_id, user_email);

ALTER TABLE users DROP COLUMN IF EXISTS gmail_token;
ALTER TABLE users DROP COLUMN IF EXISTS email;
