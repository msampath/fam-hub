import { describe, it, expect } from 'vitest';
import { hashStepUpPin, verifyStepUpPin, isValidPin } from '../../server';

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
