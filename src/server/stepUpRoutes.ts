import { Router } from 'express';
import { randomBytes } from 'crypto';
import { hashStepUpPin, verifyStepUpPin, isValidPin, nextPinLockEntry } from './stepUpPin';
import { checkRateWindow, pruneExpired } from './rateLimit';
import { requireAuth } from './middleware';

const STEPUP_VERIFY_PER_MIN = Number(process.env.STEPUP_VERIFY_PER_MIN) || 5;
const stepUpHits = new Map<string, { count: number; resetAt: number }>();
const stepUpFails = new Map<string, { fails: number; lockUntil: number }>();
const STEPUP_SET_PER_5MIN = Number(process.env.STEPUP_SET_PER_5MIN) || 3;
const stepUpSetHits = new Map<string, { count: number; resetAt: number }>();

export const stepUpRouter = Router();

stepUpRouter.post('/set', requireAuth, (req, res) => {
  const key = req.user?.id || req.ip || 'anon';
  const now = Date.now();
  pruneExpired(stepUpSetHits, now);
  const { allowed, entry } = checkRateWindow(stepUpSetHits.get(key), now, STEPUP_SET_PER_5MIN, 5 * 60_000);
  stepUpSetHits.set(key, entry);
  if (!allowed) return res.status(429).json({ error: 'Too many PIN changes — wait a few minutes.', retryable: true });
  const pin = req.body?.pin;
  if (!isValidPin(pin)) return res.status(400).json({ error: 'PIN must be 4–8 digits.' });
  const salt = randomBytes(16).toString('hex');
  return res.json({ hash: hashStepUpPin(String(pin), salt), salt });
});

stepUpRouter.post('/verify', requireAuth, (req, res) => {
  const key = req.user?.id || req.ip || 'anon';
  const now = Date.now();
  pruneExpired(stepUpHits, now);
  const { allowed, entry } = checkRateWindow(stepUpHits.get(key), now, STEPUP_VERIFY_PER_MIN, 60_000);
  stepUpHits.set(key, entry);
  if (!allowed) return res.status(429).json({ error: 'Too many PIN attempts — wait a minute.', retryable: true });
  const lockEntry = stepUpFails.get(key);
  if (lockEntry && lockEntry.lockUntil > now) {
    return res.status(429).json({ error: 'Too many wrong PINs — PIN entry is locked for 10 minutes.', retryable: true });
  }
  if (stepUpFails.size >= 256) for (const [k, v] of stepUpFails) if (v.lockUntil <= now) stepUpFails.delete(k);
  const { pin, hash, salt } = req.body || {};
  const valid = verifyStepUpPin(String(pin ?? ''), String(hash ?? ''), String(salt ?? ''));
  const nextLock = nextPinLockEntry(lockEntry, valid, now);
  if (nextLock) stepUpFails.set(key, nextLock); else stepUpFails.delete(key);
  return res.json({ valid });
});
