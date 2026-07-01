import { describe, it, expect } from 'vitest';
import { matchOwnProfileIndex, healMemberLink } from '../utils/identity';
import type { FamilyMember } from '../types';

const mk = (over: Partial<FamilyMember>): FamilyMember => ({ name: 'X', role: 'Parent', color: 'indigo', ...over });

describe('matchOwnProfileIndex', () => {
  const members = [
    mk({ name: 'Dad', userId: 'u-dad', email: 'dad@example.com' }),
    mk({ name: 'Mom', userId: 'u-mom-OLD', email: 'Mom@Example.com' }),
    mk({ name: 'Leo', role: 'Kid' }), // a kid, no account
  ];

  it('matches by auth userId (fast path)', () => {
    expect(matchOwnProfileIndex(members, 'u-dad', 'whatever@x.com')).toBe(0);
  });
  it('matches by email when the userId has drifted (case-insensitive)', () => {
    // Mom signed in with a NEW userId, but the same email → still her profile.
    expect(matchOwnProfileIndex(members, 'u-mom-NEW', 'mom@example.com')).toBe(1);
  });
  it('returns -1 when neither id nor email matches', () => {
    expect(matchOwnProfileIndex(members, 'u-ghost', 'ghost@example.com')).toBe(-1);
  });
  it('is null-safe and ignores blank email/userId', () => {
    expect(matchOwnProfileIndex(members, undefined, undefined)).toBe(-1);
    expect(matchOwnProfileIndex(null as any, 'u-dad', undefined)).toBe(-1);
  });
});

describe('healMemberLink', () => {
  const members = [mk({ name: 'Mom', userId: 'u-mom-OLD', email: 'mom@example.com' })];

  it('re-links a drifted userId and reports a change', () => {
    const { members: out, changed } = healMemberLink(members, 0, 'u-mom-NEW', 'mom@example.com');
    expect(changed).toBe(true);
    expect(out[0].userId).toBe('u-mom-NEW');
    expect(out[0].email).toBe('mom@example.com');
    expect(members[0].userId).toBe('u-mom-OLD'); // input not mutated
  });
  it('backfills a missing email (matched by userId) and reports a change', () => {
    const noEmail = [mk({ name: 'Dad', userId: 'u-dad' })];
    const { members: out, changed } = healMemberLink(noEmail, 0, 'u-dad', 'dad@example.com');
    expect(changed).toBe(true);
    expect(out[0].email).toBe('dad@example.com');
  });
  it('reports no change when already linked', () => {
    const { changed } = healMemberLink(members, 0, 'u-mom-OLD', 'mom@example.com');
    expect(changed).toBe(false);
  });
  it('never clears an existing email when none is provided', () => {
    const { members: out } = healMemberLink(members, 0, 'u-mom-NEW', undefined);
    expect(out[0].email).toBe('mom@example.com');
  });
  it('is a no-op for an out-of-range index', () => {
    expect(healMemberLink(members, 5, 'x', 'y@z.com').changed).toBe(false);
  });
});
