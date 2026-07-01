import { describe, it, expect } from 'vitest';
import {
  earnedXp, redeemedXp, availableXp, bankedXp, lifetimeEarnedXp,
  isoWeekKey, applyWeeklyReset, applyDailyReset,
} from '../utils/chores';
import type { Chore, Redemption, XpBankEntry } from '../types';

const chore = (over: Partial<Chore> & { id: string }): Chore => ({
  title: 'C', assignedTo: 'Leo', points: 10, completed: false,
  completedCount: 0, timesPerDay: 1, repeatType: 'daily', ...over,
});
const redemption = (over: Partial<Redemption> & { id: string }): Redemption => ({
  rewardTitle: 'Ice cream', cost: 20, member: 'Leo', date: '2026-06-16T00:00:00Z', ...over,
});

describe('earnedXp (this week)', () => {
  it('sums points proportional to completion, rounded once per chore', () => {
    const chores = [
      chore({ id: '1', assignedTo: 'Leo', points: 10, completedCount: 1, timesPerDay: 1 }), // 10
      chore({ id: '2', assignedTo: 'Leo', points: 15, completedCount: 1, timesPerDay: 2 }), // round(7.5)=8
      chore({ id: '3', assignedTo: 'Emma', points: 30, completedCount: 1, timesPerDay: 1 }),
    ];
    expect(earnedXp(chores, 'Leo')).toBe(18);
    expect(earnedXp(chores, 'Emma')).toBe(30);
  });

  it('is divide-by-zero safe (timesPerDay 0 treated as 1)', () => {
    expect(earnedXp([chore({ id: '1', completedCount: 1, timesPerDay: 0, points: 10 })], 'Leo')).toBe(10);
  });

  it('returns 0 for a member with no chores', () => {
    expect(earnedXp([], 'Leo')).toBe(0);
  });
});

describe('redeemedXp', () => {
  it('sums redemption costs for the member only', () => {
    const reds = [
      redemption({ id: 'a', member: 'Leo', cost: 20 }),
      redemption({ id: 'b', member: 'Leo', cost: 5 }),
      redemption({ id: 'c', member: 'Emma', cost: 50 }),
    ];
    expect(redeemedXp(reds, 'Leo')).toBe(25);
    expect(redeemedXp(reds, 'Emma')).toBe(50);
  });
});

describe('bankedXp & lifetimeEarnedXp', () => {
  const bank: XpBankEntry[] = [{ member: 'Leo', earned: 50 }, { member: 'Leo', earned: 20 }, { member: 'Emma', earned: 5 }];
  it('bankedXp sums prior-week banked entries per member', () => {
    expect(bankedXp(bank, 'Leo')).toBe(70);
    expect(bankedXp(bank, 'Emma')).toBe(5);
    expect(bankedXp(bank, 'Nobody')).toBe(0);
  });
  it('lifetimeEarnedXp = banked + this week', () => {
    const chores = [chore({ id: '1', assignedTo: 'Leo', points: 30, completedCount: 1, timesPerDay: 1 })];
    expect(lifetimeEarnedXp(bank, chores, 'Leo')).toBe(100); // 70 banked + 30 this week
  });
});

describe('availableXp (lifetime earned − redeemed)', () => {
  it('counts banked + this week, minus redeemed', () => {
    const bank: XpBankEntry[] = [{ member: 'Leo', earned: 50 }];
    const chores = [chore({ id: '1', assignedTo: 'Leo', points: 100, completedCount: 1, timesPerDay: 1 })];
    const reds = [redemption({ id: 'a', member: 'Leo', cost: 30 })];
    expect(availableXp(bank, chores, reds, 'Leo')).toBe(120); // (50+100)-30
  });

  it('never goes negative', () => {
    const chores = [chore({ id: '1', assignedTo: 'Leo', points: 10, completedCount: 1, timesPerDay: 1 })];
    const reds = [redemption({ id: 'a', member: 'Leo', cost: 999 })];
    expect(availableXp([], chores, reds, 'Leo')).toBe(0);
  });

  it('uncheck after banking cannot reduce banked XP below what was earned', () => {
    const bank: XpBankEntry[] = [{ member: 'Leo', earned: 100 }];
    // This week's chore is now unchecked (completedCount 0) → this-week earned 0,
    // but the banked 100 stands. Redeeming 100 then unchecking can't create debt beyond floor.
    const reds = [redemption({ id: 'a', member: 'Leo', cost: 100 })];
    expect(availableXp(bank, [], reds, 'Leo')).toBe(0); // 100 banked − 100 redeemed
    expect(lifetimeEarnedXp(bank, [], 'Leo')).toBe(100); // banked is immutable
  });
});

describe('isoWeekKey (ISO-8601, Monday start)', () => {
  it('Thursday Jan 1 2026 is week 01', () => {
    expect(isoWeekKey(new Date(2026, 0, 1))).toBe('2026-W01');
  });
  it('Monday Jan 5 2026 is week 02', () => {
    expect(isoWeekKey(new Date(2026, 0, 5))).toBe('2026-W02');
  });
  it('Thursday Dec 31 2026 is week 53', () => {
    expect(isoWeekKey(new Date(2026, 11, 31))).toBe('2026-W53');
  });
  it('Friday Jan 1 2027 belongs to ISO 2026-W53 (year boundary)', () => {
    expect(isoWeekKey(new Date(2027, 0, 1))).toBe('2026-W53');
  });
});

describe('applyWeeklyReset', () => {
  it('banks this-week earned per member and zeroes completedCounts', () => {
    const chores = [
      chore({ id: '1', assignedTo: 'Leo', points: 100, completedCount: 1, timesPerDay: 1 }),
      chore({ id: '2', assignedTo: 'Emma', points: 40, completedCount: 1, timesPerDay: 2 }), // round(20)=20
    ];
    const { chores: next, bank } = applyWeeklyReset(chores, []);
    expect(next.every(c => c.completedCount === 0 && c.completed === false)).toBe(true);
    expect(bankedXp(bank, 'Leo')).toBe(100);
    expect(bankedXp(bank, 'Emma')).toBe(20);
  });

  it('accumulates across multiple weekly resets', () => {
    let chores = [chore({ id: '1', assignedTo: 'Leo', points: 100, completedCount: 1, timesPerDay: 1 })];
    let bank: XpBankEntry[] = [];
    ({ chores, bank } = applyWeeklyReset(chores, bank)); // bank Leo 100, counts → 0
    expect(bankedXp(bank, 'Leo')).toBe(100);
    // next week: Leo completes again
    chores = chores.map(c => ({ ...c, completedCount: 1 }));
    ({ chores, bank } = applyWeeklyReset(chores, bank)); // bank Leo +100 → 200
    expect(bankedXp(bank, 'Leo')).toBe(200);
  });

  it('does not bank members who earned nothing this week', () => {
    const chores = [chore({ id: '1', assignedTo: 'Leo', points: 100, completedCount: 0, timesPerDay: 1 })];
    const { bank } = applyWeeklyReset(chores, []);
    expect(bank).toEqual([]);
  });

  it('does not mutate the input chores or bank', () => {
    const chores = [chore({ id: '1', assignedTo: 'Leo', points: 100, completedCount: 1, timesPerDay: 1 })];
    const bank: XpBankEntry[] = [{ member: 'Leo', earned: 10 }];
    applyWeeklyReset(chores, bank);
    expect(chores[0].completedCount).toBe(1); // unchanged
    expect(bank[0].earned).toBe(10);          // unchanged
  });
});

describe('applyDailyReset (midnight rollover)', () => {
  it('banks + zeroes DAILY chores but leaves WEEKLY chores untouched', () => {
    const chores = [
      chore({ id: 'd', assignedTo: 'Leo', points: 20, completedCount: 1, timesPerDay: 1, repeatType: 'daily' }),
      chore({ id: 'w', assignedTo: 'Leo', points: 50, completedCount: 1, timesPerDay: 1, repeatType: 'weekly' }),
    ];
    const { chores: next, bank } = applyDailyReset(chores, []);
    expect(next.find(c => c.id === 'd')!.completedCount).toBe(0);  // daily reset
    expect(next.find(c => c.id === 'd')!.completed).toBe(false);
    expect(next.find(c => c.id === 'w')!.completedCount).toBe(1);  // weekly untouched
    expect(bankedXp(bank, 'Leo')).toBe(20);                        // only the daily XP banked
  });

  it('treats an unspecified repeatType as daily', () => {
    const chores = [{ ...chore({ id: 'x', assignedTo: 'Emma', points: 10, completedCount: 1 }), repeatType: undefined as any }];
    const { chores: next, bank } = applyDailyReset(chores, []);
    expect(next[0].completedCount).toBe(0);
    expect(bankedXp(bank, 'Emma')).toBe(10);
  });

  it('accumulates banked XP across multiple daily resets (no loss across the week)', () => {
    let chores = [chore({ id: 'd', assignedTo: 'Leo', points: 20, completedCount: 1, timesPerDay: 1, repeatType: 'daily' })];
    let bank: XpBankEntry[] = [];
    ({ chores, bank } = applyDailyReset(chores, bank)); // day 1 → bank 20, count 0
    chores = chores.map(c => ({ ...c, completedCount: 1 }));
    ({ chores, bank } = applyDailyReset(chores, bank)); // day 2 → bank +20 → 40
    expect(bankedXp(bank, 'Leo')).toBe(40);
  });

  it('does not mutate inputs', () => {
    const chores = [chore({ id: 'd', assignedTo: 'Leo', points: 20, completedCount: 1, repeatType: 'daily' })];
    const bank: XpBankEntry[] = [{ member: 'Leo', earned: 5 }];
    applyDailyReset(chores, bank);
    expect(chores[0].completedCount).toBe(1);
    expect(bank[0].earned).toBe(5);
  });
});
