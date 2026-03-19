import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

// We use the service_role key for the backend to bypass Row Level Security
// and have full administrative access to all tables.
export const supabase = createClient(env.supabaseUrl, env.supabaseServiceKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
    },
});
