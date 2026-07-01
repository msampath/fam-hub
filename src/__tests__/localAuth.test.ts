import { describe, it, expect } from 'vitest';
import { makeSalt, hashPassphrase, verifyPassphrase, isValidPassphrase, signSession, verifySession, newSession } from '../storage/localAuth';

describe('local household passphrase', () => {
  it('verifies the right passphrase and rejects the wrong one', () => {
    const salt = makeSalt();
    const hash = hashPassphrase('open sesame please', salt);
    expect(verifyPassphrase('open sesame please', hash, salt)).toBe(true);
    expect(verifyPassphrase('wrong phrase here', hash, salt)).toBe(false);
    expect(verifyPassphrase('', hash, salt)).toBe(false);
  });

  it('salts: same passphrase, different salt → different hash', () => {
    expect(hashPassphrase('hunter2222', makeSalt())).not.toBe(hashPassphrase('hunter2222', makeSalt()));
  });

  it('validates passphrase length bounds', () => {
    expect(isValidPassphrase('12345')).toBe(false);   // too short
    expect(isValidPassphrase('123456')).toBe(true);
    expect(isValidPassphrase(1234567 as any)).toBe(false);
  });
});

describe('box-signed session token', () => {
  const SECRET = 'box-secret-abc';
  const NOW = 1_700_000_000_000;

  it('round-trips a valid session', () => {
    const tok = signSession(newSession('hh-1', NOW), SECRET);
    const got = verifySession(tok, SECRET, NOW + 1000);
    expect(got?.householdId).toBe('hh-1');
  });

  it('rejects a tampered payload (signature mismatch)', () => {
    const tok = signSession(newSession('hh-1', NOW), SECRET);
    const forged = Buffer.from(JSON.stringify({ householdId: 'hh-EVIL', iat: NOW, exp: NOW + 1e9 })).toString('base64url') + '.' + tok.split('.')[1];
    expect(verifySession(forged, SECRET, NOW)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const tok = signSession(newSession('hh-1', NOW), SECRET);
    expect(verifySession(tok, 'other-secret', NOW)).toBeNull();
  });

  it('rejects an expired token', () => {
    const tok = signSession(newSession('hh-1', NOW, 1000), SECRET); // 1s ttl
    expect(verifySession(tok, SECRET, NOW + 2000)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifySession('', SECRET, NOW)).toBeNull();
    expect(verifySession('no-dot', SECRET, NOW)).toBeNull();
    expect(verifySession('.sig', SECRET, NOW)).toBeNull();
  });
});
