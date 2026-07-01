// Identity linking for family-member profiles. A profile is the signed-in user's own when it
// matches their auth userId OR their (stable) Google email. Keying on email is what lets a profile
// survive an auth userId change (Supabase re-issues ids across project resets / re-auth), so the
// user is never wrongly re-prompted to "pick a nickname" or split into a new household. Pure/tested.
import type { FamilyMember } from '../types';

// Index of the signed-in user's OWN profile — auth userId first, else the stable email
// (case-insensitive). -1 if none. Email is the durable key; userId is the fast path.
export function matchOwnProfileIndex(
  members: FamilyMember[], userId: string | undefined, email: string | undefined,
): number {
  const list = Array.isArray(members) ? members : [];
  const emailLc = (email || '').trim().toLowerCase();
  return list.findIndex(m =>
    (!!userId && m.userId === userId) ||
    (!!emailLc && !!m.email && m.email.trim().toLowerCase() === emailLc));
}

// Re-link the matched profile to the current account: set userId + backfill email when either is
// stale/missing. Returns the (possibly new) members array and whether anything changed — so the
// caller can persist only on a real change. Pure (no mutation of the input).
export function healMemberLink(
  members: FamilyMember[], idx: number, userId: string, email: string | undefined,
): { members: FamilyMember[]; changed: boolean } {
  if (idx < 0 || idx >= members.length) return { members, changed: false };
  const m = members[idx];
  const nextEmail = email || m.email; // never clear an existing email
  if (m.userId === userId && (m.email || '') === (nextEmail || '')) return { members, changed: false };
  const updated = members.map((x, i) => (i === idx ? { ...x, userId, email: nextEmail } : x));
  return { members: updated, changed: true };
}
