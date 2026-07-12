import { storageMode } from '../storage';

export const STORAGE_MODE = storageMode();
export const LOCAL_MODE = STORAGE_MODE === 'sqlite';
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const PORT = Number(process.env.PORT) || 4894;
// Same precedence storageMode()/persistence.ts already use (SUPABASE_URL wins, VITE_ prefix is the
// browser-facing fallback) — cloud-only call sites (JWKS, digest, agent proxy) must resolve the SAME
// var storageMode() itself accepted, or a SUPABASE_URL-only deploy selects cloud mode then crashes here.
export const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
