import type { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_MODE } from './config';
import { verifySession } from '../storage/localAuth';
import { getSqliteAdapter } from '../storage';
import { getSessionSecret } from '../storage/boxConfig';
import { checkRateWindow, pruneExpired } from './rateLimit';

// ── Auth: verify the caller's Supabase session on protected API routes ─────────
// LOCAL_MODE (the LAN appliance) has no Supabase — and @supabase/supabase-js now throws on an empty
// URL — so only construct the cloud auth client when Supabase is actually configured. requireAuth
// returns on the LOCAL_MODE branch before ever touching it.
const supabaseAuth = LOCAL_MODE
  ? null
  : createClient(
      process.env.VITE_SUPABASE_URL || '',
      process.env.VITE_SUPABASE_ANON_KEY || '',
    );

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  // LAN appliance: a box-signed household session (from /api/auth/login), verified locally — no Supabase.
  if (LOCAL_MODE) {
    const sess = verifySession(token, getSessionSecret(getSqliteAdapter()), Date.now());
    if (!sess) return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
    req.householdId = sess.householdId;
    return next();
  }
  const { data, error } = await supabaseAuth!.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }
  req.user = data.user;
  next();
}

// ── Per-user rate limit for the AI (cost-bearing) endpoints ─────────────────────
// Auth alone doesn't stop a signed-in user (or a stolen session) running an automated loop that
// burns the Gemini quota / runs up cost / DoSes the household. A fixed per-minute window per user
// caps that. In-memory (single-instance app; resets on restart — fine here). Tune via env.
const AI_RATE_LIMIT_PER_MIN = Number(process.env.AI_RATE_LIMIT_PER_MIN) || 20;
const AI_RATE_WINDOW_MS = 60_000;
const aiRateHits = new Map<string, { count: number; resetAt: number }>();

// Express middleware: rate-limit per authenticated user (falls back to IP). Returns 429 with
// retryable:true so the client surfaces the same non-blocking "AI busy — add it manually" steer.
export function aiRateLimit(req: Request, res: Response, next: NextFunction) {
  const key = req.user?.id || req.householdId || req.ip || 'anon';
  const now = Date.now();
  pruneExpired(aiRateHits, now);
  const { allowed, entry } = checkRateWindow(aiRateHits.get(key), now, AI_RATE_LIMIT_PER_MIN, AI_RATE_WINDOW_MS);
  aiRateHits.set(key, entry);
  if (!allowed) {
    return res.status(429).json({ error: "You're sending AI requests too fast — wait a moment and try again.", retryable: true });
  }
  next();
}
