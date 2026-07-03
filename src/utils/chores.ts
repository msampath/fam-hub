// Chore helpers (pure, unit-tested).
import { CHORE_SLOTS } from '../constants';
import type { Chore, Redemption, XpBankEntry } from '../types';

// XP a kid has earned THIS WEEK — proportional to chore completion, rounded once per
// chore so it reconciles with each chore's stated total points (no per-rep rounding
// drift, divide-by-zero-safe). Chore completedCounts reset weekly (see applyWeeklyReset),
// so this is the *current week's* earnings; prior weeks live in the XP bank.
export function earnedXp(chores: Chore[], memberName: string): number {
  return chores
    .filter(c => c.assignedTo === memberName)
    .reduce((acc, c) => acc + Math.round((c.points || 0) * ((c.completedCount ?? 0) / (c.timesPerDay || 1))), 0);
}

// XP banked from PRIOR weeks for a member (immutable once banked).
export function bankedXp(bank: XpBankEntry[], memberName: string): number {
  return bank.filter(b => b.member === memberName).reduce((acc, b) => acc + (b.earned || 0), 0);
}

// Lifetime earned = banked (prior weeks) + this week's live earnings.
export function lifetimeEarnedXp(bank: XpBankEntry[], chores: Chore[], memberName: string): number {
  return bankedXp(bank, memberName) + earnedXp(chores, memberName);
}

// XP a kid has already SPENT on rewards (lifetime).
export function redeemedXp(redemptions: Redemption[], memberName: string): number {
  return redemptions
    .filter(r => r.member === memberName)
    .reduce((acc, r) => acc + (r.cost || 0), 0);
}

// XP a kid has left to spend = lifetime earned − lifetime redeemed (never negative).
export function availableXp(
  bank: XpBankEntry[], chores: Chore[], redemptions: Redemption[], memberName: string,
): number {
  return Math.max(0, lifetimeEarnedXp(bank, chores, memberName) - redeemedXp(redemptions, memberName));
}

// ISO-8601 week key (Monday-start), e.g. "2026-W25". Pure — caller passes the date.
export function isoWeekKey(d: Date): string {
  // Copy to UTC midnight to avoid TZ/DST drift, then walk to the Thursday of this week
  // (ISO weeks are defined by their Thursday) and count weeks from the year's first Thursday.
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // → Thursday of this week
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

// Weekly reset (pure): bank each member's CURRENT week earnings into the XP bank, then
// zero every chore's completedCount. Banking reads the pre-reset chores, so nothing is
// lost. Members are derived from the chores' assignees (the only source of earned XP).
// Bank each member's earned XP from `source` chores into a FRESH copy of `bank` (pure). Shared by the weekly
// and daily resets — both read PRE-reset chores so nothing is lost; they differ only in which chores feed this.
function bankEarnings(source: Chore[], bank: XpBankEntry[]): XpBankEntry[] {
  const nextBank: XpBankEntry[] = bank.map(b => ({ ...b }));
  for (const member of Array.from(new Set(source.map(c => c.assignedTo)))) {
    const gained = earnedXp(source, member);
    if (gained <= 0) continue;
    const existing = nextBank.find(b => b.member === member);
    if (existing) existing.earned += gained;
    else nextBank.push({ member, earned: gained });
  }
  return nextBank;
}

export function applyWeeklyReset(
  chores: Chore[], bank: XpBankEntry[],
): { chores: Chore[]; bank: XpBankEntry[] } {
  return {
    chores: chores.map(c => ({ ...c, completedCount: 0, completed: false })),
    bank: bankEarnings(chores, bank),
  };
}

// Daily reset (pure): on a local-day rollover, bank each member's earnings from their DAILY chores
// (repeatType !== 'weekly') and zero ONLY those chores' completedCount, so a daily chore (e.g. "brush teeth")
// becomes actionable again the next day WITHOUT losing the XP it earned. Weekly chores are untouched.
export function applyDailyReset(
  chores: Chore[], bank: XpBankEntry[],
): { chores: Chore[]; bank: XpBankEntry[] } {
  const isDaily = (c: Chore) => c.repeatType !== 'weekly';
  return {
    chores: chores.map(c => (isDaily(c) ? { ...c, completedCount: 0, completed: false } : c)),
    bank: bankEarnings(chores.filter(isDaily), bank),
  };
}

// Emoji icon for a chore title, so pre-readers (kid mode targets age 4+) can navigate by picture.
// Deliberately a pure keyword map, NOT a stored field: no Chore schema / COLLECTIONS / MCP-validator
// churn, and copilot-created chores get an icon for free. First match wins; ⭐ when nothing matches.
// Order matters where words collide ("feed the dog" → 🐶 not 🐾; "water the plants" → 🪴).
const CHORE_EMOJI: [RegExp, string][] = [
  [/\bbed\b/i, '🛏️'],
  [/teeth|tooth|brush/i, '🪥'],
  [/bath|shower/i, '🛁'],
  [/piano|music|guitar|violin/i, '🎹'],
  [/dish|plate|table/i, '🍽️'],
  [/laundry|clothes|fold|sock/i, '🧺'],
  [/trash|garbage|recycl/i, '🗑️'],
  [/dog|puppy/i, '🐶'],
  [/cat|kitten|litter/i, '🐱'],
  [/fish|aquarium/i, '🐠'],
  [/feed|\bpet\b/i, '🐾'],
  [/plant|water|flower|garden/i, '🪴'],
  [/toy|playroom|tidy|pick up/i, '🧸'],
  [/school|backpack|\bbag\b|lunch/i, '🎒'],
  [/homework|study|practice/i, '✏️'],
  [/book|read/i, '📚'],
  [/room|vacuum|sweep|dust|clean/i, '🧹'],
  [/shoe/i, '👟'],
];
export function choreEmoji(title: string): string {
  const t = String(title || '');
  for (const [re, emoji] of CHORE_EMOJI) if (re.test(t)) return emoji;
  return '⭐';
}

// Does a chore belong in the selected slot? Lenient: chores with no slot, or an
// "Anytime"/unrecognized slot, always show. A chore is only hidden when its slot
// names a *different* known bucket than the filter.
export function choreMatchesSlot(scheduleTimeOfDay: string | undefined, filter: string): boolean {
  if (filter === 'All') return true;
  const slot = (scheduleTimeOfDay || '').toLowerCase();
  if (!slot) return true;
  const mentionsKnown = CHORE_SLOTS.some(s => slot.includes(s.toLowerCase()));
  if (!mentionsKnown) return true; // "Anytime" / legacy free-text → always visible
  return slot.includes(filter.toLowerCase());
}
