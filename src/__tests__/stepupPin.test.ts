import { describe, it, expect } from 'vitest';
import { hashStepUpPin, verifyStepUpPin, isValidPin, nextPinLockEntry } from '../../server';

describe('step-up PIN hashing (server, scrypt + salt, never stores raw)', () => {
  it('a correct PIN verifies against its hash+salt', () => {
    const salt = 'a1b2c3d4';
    const hash = hashStepUpPin('1234', salt);
    expect(verifyStepUpPin('1234', hash, salt)).toBe(true);
  });

  it('a wrong PIN does not verify', () => {
    const salt = 'a1b2c3d4';
    const hash = hashStepUpPin('1234', salt);
    expect(verifyStepUpPin('0000', hash, salt)).toBe(false);
  });

  it('the same PIN under a different salt yields a different hash (salted)', () => {
    expect(hashStepUpPin('1234', 'saltA')).not.toBe(hashStepUpPin('1234', 'saltB'));
  });

  it('verify is false on missing/blank inputs (no crash, no accidental pass)', () => {
    expect(verifyStepUpPin('', 'x', 'y')).toBe(false);
    expect(verifyStepUpPin('1234', '', 'y')).toBe(false);
    expect(verifyStepUpPin('1234', 'x', '')).toBe(false);
  });

  it('verify is false (not a throw) when the stored hash is malformed', () => {
    const salt = 'salt';
    const hash = hashStepUpPin('1234', salt);
    expect(verifyStepUpPin('1234', hash.slice(0, 10), salt)).toBe(false); // truncated hash → length mismatch
  });

  it('isValidPin accepts 4–8 digits only', () => {
    expect(isValidPin('1234')).toBe(true);
    expect(isValidPin('12345678')).toBe(true);
    expect(isValidPin('123')).toBe(false);       // too short
    expect(isValidPin('123456789')).toBe(false); // too long
    expect(isValidPin('12a4')).toBe(false);      // non-digit
    expect(isValidPin(1234 as any)).toBe(false); // not a string
    expect(isValidPin('')).toBe(false);
  });
});

describe('PIN failure lockout transition (nextPinLockEntry — 5 fails → 10-min lock, success clears)', () => {
  const NOW = 1_000_000;
  const LOCK_MS = 10 * 60_000;

  it('failures accumulate without locking until the 5th', () => {
    let entry = nextPinLockEntry(undefined, false, NOW)!;
    expect(entry).toEqual({ fails: 1, lockUntil: 0 });
    entry = nextPinLockEntry(entry, false, NOW)!;
    entry = nextPinLockEntry(entry, false, NOW)!;
    entry = nextPinLockEntry(entry, false, NOW)!;
    expect(entry).toEqual({ fails: 4, lockUntil: 0 }); // 4 fails: still open
    entry = nextPinLockEntry(entry, false, NOW)!;
    expect(entry).toEqual({ fails: 5, lockUntil: NOW + LOCK_MS }); // 5th locks for 10 min
  });

  it('a correct PIN clears the slate entirely (returns null → delete)', () => {
    const fourFails = { fails: 4, lockUntil: 0 };
    expect(nextPinLockEntry(fourFails, true, NOW)).toBeNull();
    expect(nextPinLockEntry(undefined, true, NOW)).toBeNull();
  });

  it('after a served (expired) lockout, the next failure starts a FRESH count of 1, not 6', () => {
    const locked = { fails: 5, lockUntil: NOW };
    const after = nextPinLockEntry(locked, false, NOW + 1)!; // lock has expired
    expect(after).toEqual({ fails: 1, lockUntil: 0 });
  });

  it('honors custom thresholds (maxFails / lockMs parameters)', () => {
    const e = nextPinLockEntry({ fails: 1, lockUntil: 0 }, false, NOW, 2, 5000)!;
    expect(e).toEqual({ fails: 2, lockUntil: NOW + 5000 });
  });
});
