// Local household auth for the single-click LAN appliance — the SQLite/local-mode replacement for Supabase
// auth. The box stores a household PASSPHRASE (scrypt hash + salt) and a random SESSION SECRET; a successful
// login mints a compact box-signed session token carrying the householdId. There's ONE household per box
// (single-tenant LAN), so this is a shared household credential, not per-user accounts — the existing
// `members` collection still provides the per-parent/kid profiles inside the household. Trusted-LAN posture
// (like today's kiosk): the passphrase gates the box; the LAN is the perimeter.
//
// Pure crypto only (no DB, no Express) so it's unit-tested directly. scrypt is synchronous like the existing
// step-up PIN; logins are rare + rate-limited, so the brief block is fine.
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

const KEYLEN = 32;

export function makeSalt(): string {
  return randomBytes(16).toString('hex');
}

export function hashPassphrase(passphrase: string, salt: string): string {
  return scryptSync(String(passphrase), String(salt), KEYLEN).toString('hex');
}

// Constant-time verify (never short-circuits on a length/byte mismatch via string compare).
export function verifyPassphrase(passphrase: string, hash: string, salt: string): boolean {
  if (!passphrase || !hash || !salt) return false;
  const a = Buffer.from(hashPassphrase(passphrase, salt), 'hex');
  const b = Buffer.from(String(hash), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// A reasonable household passphrase: 6–128 chars (a memorable family phrase, stronger than a 4-digit PIN
// since it gates the whole box). Not over-constrained — the LAN is the real perimeter.
export function isValidPassphrase(p: unknown): p is string {
  return typeof p === 'string' && p.length >= 6 && p.length <= 128;
}

export interface Session { householdId: string; iat: number; exp: number }

// Compact box-signed token: base64url(payload) + "." + HMAC-SHA256(base64url(payload)). No external JWT dep;
// the box owns both sign + verify with its SESSION SECRET, so a client can't forge a session.
export function signSession(payload: Session, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// Verify signature (constant-time) + expiry. Returns the session, or null if forged/expired/malformed.
export function verifySession(token: string, secret: string, nowMs: number): Session | null {
  if (!token || !secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Session;
    if (!payload || typeof payload.householdId !== 'string' || !payload.householdId) return null;
    if (typeof payload.exp !== 'number' || payload.exp < nowMs) return null;
    // Reject a future-dated token (clock skew tolerance 60s): a sane box never mints iat in the future, and it
    // bounds the window if the signing secret ever leaked + an attacker tried to pre-date a long-lived token.
    if (typeof payload.iat !== 'number' || payload.iat > nowMs + 60_000) return null;
    return payload;
  } catch {
    return null;
  }
}

// Build a session valid for `ttlMs` (default 30 days — a family box, not a bank).
export function newSession(householdId: string, nowMs: number, ttlMs = 30 * 24 * 3600_000): Session {
  return { householdId, iat: nowMs, exp: nowMs + ttlMs };
}
