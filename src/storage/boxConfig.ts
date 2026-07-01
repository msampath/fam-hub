// Box-level identity for the single-tenant LAN appliance, stored in the SQLite `meta` table: the one
// household id, the household passphrase (hash + salt), and the random session-signing secret. Pure over a
// minimal {getMeta,setMeta} store (the SqliteAdapter satisfies it) so it's unit-testable with a fake map.
import { randomUUID, randomBytes } from 'node:crypto';
import { makeSalt, hashPassphrase, verifyPassphrase } from './localAuth';

export interface MetaStore {
  getMeta(k: string): string | null;
  setMeta(k: string, v: string): void;
}

const K = { household: 'household_id', passHash: 'pass_hash', passSalt: 'pass_salt', secret: 'session_secret' } as const;

// The box's single household id (generated + persisted once). Stable across restarts.
export function getOrCreateHouseholdId(m: MetaStore): string {
  let id = m.getMeta(K.household);
  if (!id) { id = randomUUID(); m.setMeta(K.household, id); }
  return id;
}

// The HMAC secret used to sign/verify local session tokens (generated + persisted once). Keeping it in the DB
// means sessions survive restarts without an external secret to manage — fine for a single-tenant LAN box.
export function getSessionSecret(m: MetaStore): string {
  let s = m.getMeta(K.secret);
  if (!s) { s = randomBytes(32).toString('hex'); m.setMeta(K.secret, s); }
  return s;
}

// Has the owner completed first-run setup (set a household passphrase)?
export function isHouseholdConfigured(m: MetaStore): boolean {
  return !!(m.getMeta(K.passHash) && m.getMeta(K.passSalt));
}

// First-run (or reset): set the household passphrase + ensure the household id exists.
export function setHouseholdPassphrase(m: MetaStore, passphrase: string): void {
  const salt = makeSalt();
  m.setMeta(K.passSalt, salt);
  m.setMeta(K.passHash, hashPassphrase(passphrase, salt));
  getOrCreateHouseholdId(m);
}

// Verify a login attempt against the stored passphrase.
export function checkHouseholdPassphrase(m: MetaStore, passphrase: string): boolean {
  const hash = m.getMeta(K.passHash);
  const salt = m.getMeta(K.passSalt);
  return !!(hash && salt) && verifyPassphrase(passphrase, hash, salt);
}

// Change the passphrase: verify the OLD one, then store the NEW hash/salt AND rotate the session secret so
// EVERY outstanding session token is invalidated (the revocation path — a lost/decommissioned device's token
// stops working immediately). Returns false if the old passphrase is wrong (caller should reject, not rotate).
export function changeHouseholdPassphrase(m: MetaStore, oldPassphrase: string, newPassphrase: string): boolean {
  if (!checkHouseholdPassphrase(m, oldPassphrase)) return false;
  const salt = makeSalt();
  m.setMeta(K.passSalt, salt);
  m.setMeta(K.passHash, hashPassphrase(newPassphrase, salt));
  m.setMeta(K.secret, randomBytes(32).toString('hex')); // rotate → all previously-signed tokens no longer verify
  return true;
}
