/**
 * The one Supabase client instance for the app. `enabled` gates every other
 * module in src/api/: when the env vars are missing (local UI work without a
 * backend, or a preview build with no secrets), the rest of the app must fall
 * back to the local-only behaviour in useGame.js untouched.
 */
import { createClient } from '@supabase/supabase-js';

const env = import.meta.env || {};

export const supabaseUrl = env.VITE_SUPABASE_URL || '';
export const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || '';

export const enabled = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = enabled ? createClient(supabaseUrl, supabaseAnonKey) : null;
