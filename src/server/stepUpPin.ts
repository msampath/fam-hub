import { scryptSync, timingSafeEqual } from 'crypto';

const STEPUP_KEYLEN = 32;

export function hashStepUpPin(pin: string, salt: string): string {
  return scryptSync(String(pin), String(salt), STEPUP_KEYLEN).toString('hex');
}

export function verifyStepUpPin(pin: string, hash: string, salt: string): boolean {
  if (!pin || !hash || !salt) return false;
  const a = Buffer.from(hashStepUpPin(pin, salt), 'hex');
  const b = Buffer.from(String(hash), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isValidPin(pin: unknown): boolean {
  return typeof pin === 'string' && /^\d{4,8}$/.test(pin);
}

export function nextPinLockEntry(
  entry: { fails: number; lockUntil: number } | undefined,
  valid: boolean, now: number,
  maxFails = 5, lockMs = 10 * 60_000,
): { fails: number; lockUntil: number } | null {
  if (valid) return null;
  const expiredLock = !!entry && entry.lockUntil !== 0 && entry.lockUntil <= now;
  const fails = expiredLock ? 1 : (entry?.fails ?? 0) + 1;
  return { fails, lockUntil: fails >= maxFails ? now + lockMs : 0 };
}
