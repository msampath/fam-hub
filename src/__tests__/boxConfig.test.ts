import { describe, it, expect } from 'vitest';
import { SqliteAdapter } from '../storage/sqlite';
import { getOrCreateHouseholdId, getSessionSecret, isHouseholdConfigured, setHouseholdPassphrase, checkHouseholdPassphrase, changeHouseholdPassphrase } from '../storage/boxConfig';

const mk = () => new SqliteAdapter(':memory:'); // satisfies MetaStore via getMeta/setMeta

describe('boxConfig (box identity in the SQLite meta table)', () => {
  it('household id + session secret are generated once and stable', () => {
    const db = mk();
    const id = getOrCreateHouseholdId(db);
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(getOrCreateHouseholdId(db)).toBe(id);             // stable
    const secret = getSessionSecret(db);
    expect(secret).toHaveLength(64);
    expect(getSessionSecret(db)).toBe(secret);               // stable
  });

  it('not configured until a passphrase is set; then login verifies', () => {
    const db = mk();
    expect(isHouseholdConfigured(db)).toBe(false);
    setHouseholdPassphrase(db, 'our family phrase');
    expect(isHouseholdConfigured(db)).toBe(true);
    expect(checkHouseholdPassphrase(db, 'our family phrase')).toBe(true);
    expect(checkHouseholdPassphrase(db, 'wrong')).toBe(false);
    expect(getOrCreateHouseholdId(db)).toBeTruthy();          // setup ensured an id
  });

  it('change passphrase: wrong old is rejected (secret unchanged); correct old rotates the secret (revocation)', () => {
    const db = mk();
    setHouseholdPassphrase(db, 'old phrase');
    const secretBefore = getSessionSecret(db);
    // Wrong current passphrase → rejected, nothing changes.
    expect(changeHouseholdPassphrase(db, 'not the phrase', 'new phrase')).toBe(false);
    expect(checkHouseholdPassphrase(db, 'old phrase')).toBe(true);   // still the old one
    expect(getSessionSecret(db)).toBe(secretBefore);                 // secret NOT rotated
    // Correct current passphrase → new one works, old fails, secret rotated (all outstanding tokens invalidated).
    expect(changeHouseholdPassphrase(db, 'old phrase', 'new phrase')).toBe(true);
    expect(checkHouseholdPassphrase(db, 'new phrase')).toBe(true);
    expect(checkHouseholdPassphrase(db, 'old phrase')).toBe(false);
    expect(getSessionSecret(db)).not.toBe(secretBefore);
    expect(getSessionSecret(db)).toHaveLength(64);
  });
});
