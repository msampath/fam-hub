import type { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { LOCAL_MODE } from './config';
import { verifySession } from '../storage/localAuth';
import { getSqliteAdapter } from '../storage';
import { getSessionSecret } from '../storage/boxConfig';
import { checkRateWindow, pruneExpired } from './rateLimit';

// ── Auth: verify the caller's JWT locally (no per-request Supabase round-trip) ──
// Cloud mode: verify the Supabase-issued JWT signature against the project's JWKS endpoint.
// createRemoteJWKSet caches keys and auto-refetches on unknown kid (handles rotation).
const jwks = LOCAL_MODE
  ? null
  : createRemoteJWKSet(new URL(`${process.env.VITE_SUPABASE_URL}/auth/v1/.well-known/jwks.json`));

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
  try {
    const { payload } = await jwtVerify(token, jwks!);
    req.user = { id: payload.sub } as any;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }
}

// ── Pre-auth IP throttle (cloud only): cap requests per IP before the Supabase getUser call ──
// Without this, anyone can flood requireAuth with random Bearer tokens, each triggering a
// blocking getUser round-trip. In LOCAL_MODE the LAN login has its own per-IP limiter.
const PRE_AUTH_PER_MIN = Number(process.env.PRE_AUTH_PER_MIN) || 60;
const preAuthHits = new Map<string, { count: number; resetAt: number }>();

export function preAuthThrottle(req: Request, res: Response, next: NextFunction) {
  if (LOCAL_MODE) return next();
  const key = req.ip || 'anon';
  const now = Date.now();
  pruneExpired(preAuthHits, now);
  const { allowed, entry } = checkRateWindow(preAuthHits.get(key), now, PRE_AUTH_PER_MIN, 60_000);
  preAuthHits.set(key, entry);
  if (!allowed) {
    return res.status(429).json({ error: 'Too many requests — please wait a moment.' });
  }
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
