// Personalized digest content (W4): per-MEMBER "your day" sections + the richer calendar-driven
// nudge set (anniversary / trip-prep / computable retail moments). Pure text builders over the
// deterministic collections — the composing model may REPHRASE these facts, never add to them.
// Grounding rule: every nudge cites an event that actually exists (or a date that's computable);
// nothing is invented from vibes. Retail moments deliberately exclude vendor-variable dates
// (Prime Day moves yearly — an invented date is worse than no nudge).
import type { CalendarEvent, Chore, FamilyMember } from '../types';

const dayNum = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
const daysUntil = (from: string, to: string) => dayNum(to) - dayNum(from);
const eventDate = (e: CalendarEvent) => String(e.start || '').slice(0, 10);

// Per-member "your day": their events today + their chores still open. Members with nothing get no
// section (an empty "For Max:" is noise). 'Family'-tagged events count for everyone.
export function buildMemberSections(
  members: FamilyMember[], events: CalendarEvent[], chores: Chore[], today: string,
): string[] {
  const sections: string[] = [];
  for (const m of members || []) {
    const evs = (events || []).filter(e =>
      eventDate(e) === today
      && (!(e.members || []).length || (e.members || []).includes(m.name) || (e.members || []).includes('Family')));
    const open = (chores || []).filter(c =>
      c.assignedTo === m.name && (c.completedCount ?? 0) < (c.timesPerDay || 1));
    if (!evs.length && !open.length) continue;
    const lines = [
      ...evs.map(e => `  - ${e.title}${e.startTime ? ` at ${e.startTime}` : ''}`),
      ...open.map(c => `  - chore: ${c.title}`),
    ];
    sections.push(`For ${m.name}:\n${lines.join('\n')}`);
  }
  return sections;
}

// Richer nudges (all calendar-grounded):
// - anniversary/birthday within 7 days → plan/gift nudge (names the real event).
// - a trip/travel event starting in 3–7 days → pack / arrange pet care.
// - Black Friday (computable: the day after the 4th Thursday of November) within 10 days, ONLY when
//   the shopping list is non-trivial — "stock up on the big-ticket items you've been putting off".
export function buildRichNudges(
  events: CalendarEvent[], today: string, shoppingCount = 0,
): string[] {
  const nudges: string[] = [];
  for (const e of events || []) {
    const d = eventDate(e);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const dd = daysUntil(today, d);
    if (dd < 0 || dd > 7) continue;
    const title = String(e.title || '');
    if (/anniversar|birthday/i.test(title) && dd >= 1) {
      nudges.push(`${title} is in ${dd} day${dd === 1 ? '' : 's'} (${d}) — a gift or a plan beats a same-day scramble.`);
    }
    if (dd >= 3 && dd <= 7 && (/(^|\W)(trip|travel|vacation|flight|getaway|camping)(\W|$)/i.test(title) || /travel|trip/i.test(String(e.category || '')))) {
      nudges.push(`${title} starts ${d} — start the packing list and arrange pet/plant care now.`);
    }
  }
  // Black Friday: day after the 4th Thursday of November (computable, no invented dates).
  const year = +today.slice(0, 4);
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const firstThu = 1 + ((4 - nov1.getUTCDay() + 7) % 7);
  const bf = `${year}-11-${String(firstThu + 21 + 1).padStart(2, '0')}`;
  const toBf = daysUntil(today, bf);
  if (toBf >= 0 && toBf <= 10 && shoppingCount >= 3) {
    nudges.push(`Black Friday is ${bf} — worth checking which shopping-list items are worth holding for it.`);
  }
  return nudges;
}
