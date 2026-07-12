// Sample household for the no-login demo (Supabase anonymous auth). When a visitor taps "Try the demo"
// they get a fresh anonymous session + a brand-new household; instead of the name prompt we seed this
// so the dashboard lands populated and lively, and the grounded copilot works out of the box (a home
// location is seeded so the mandatory-location gate is already satisfied). Pure + deterministic from
// (today, userId) apart from the uuid()s, so it's unit-testable.
import { uuid } from './uuid';
import { MEMBER_COLORS_LIST } from '../constants';
import { addDaysISO, weekdayOf } from './copilotHarness';
import type { FamilyMember, CalendarEvent, Chore, ShoppingItem, HouseholdSettings, Bill, LibraryDoc, Goal, LedgerEntry } from '../types';

// `today` is local ISO 'YYYY-MM-DD'; `userId` is the anonymous visitor's auth id (links the "You" parent
// so authorship + account-linking resolve). Returns a map of collection dataKey → seeded array.
export function buildDemoSeed(today: string, userId: string): Record<string, any[]> {
  const members: FamilyMember[] = [
    { name: 'You', role: 'Parent', color: MEMBER_COLORS_LIST[0].color, userId },
    { name: 'Ava', role: 'Kid', color: MEMBER_COLORS_LIST[5].color },
    { name: 'Max', role: 'Kid', color: MEMBER_COLORS_LIST[2].color },
  ];

  const ev = (over: Partial<CalendarEvent>): CalendarEvent => ({
    id: uuid(), title: '', start: today, category: 'Other', ageGroup: 'All ages', members: ['Everyone'], ...over,
  });
  const events: CalendarEvent[] = [
    ev({ title: 'Ava soccer practice', start: addDaysISO(today, 1), startTime: '16:00', endTime: '17:00', category: 'Sports', members: ['Ava'] }),
    ev({ title: 'Dentist — Ava', start: addDaysISO(today, 3), startTime: '14:00', endTime: '14:45', members: ['Ava'] }),
    ev({ title: 'Max swim lesson', start: addDaysISO(today, 2), startTime: '17:30', endTime: '18:15', category: 'Sports', members: ['Max'] }),
    ev({ title: 'Family movie night', start: addDaysISO(today, 5), startTime: '19:00', members: ['Everyone'] }),
    // A birthday inside the nudge horizon: fires BOTH the deterministic gift nudge AND gives the
    // morning planner a concrete fact to propose from — the briefing-preview demo beat lands populated.
    ev({ title: "Grandma's birthday", start: addDaysISO(today, 6), members: ['Everyone'] }),
  ];

  const chore = (title: string, who: string, slot: string): Chore => ({
    id: uuid(), title, assignedTo: who, points: 5, completed: false, completedCount: 0, timesPerDay: 1, repeatType: 'daily', scheduleTimeOfDay: slot,
  });
  const chores: Chore[] = [
    chore('Make your bed', 'Ava', 'Morning'),
    chore('Feed the dog', 'Max', 'Morning'),
    chore('Pack school bag', 'Ava', 'Evening'),
    chore('Tidy the playroom', 'Max', 'Evening'),
  ];

  const shop = (text: string, store: ShoppingItem['store']): ShoppingItem => ({ id: uuid(), text, completed: false, store });
  const shopping: ShoppingItem[] = [
    shop('Milk', 'Grocery Store'),
    shop('Bananas', 'Grocery Store'),
    shop('Paper towels', 'Costco'),
  ];

  // Seed a home location so the copilot's grounded suggestions work immediately (and the mandatory
  // home-location gate is satisfied). Sammamish, WA — the project's running example.
  const settings: HouseholdSettings[] = [{ homeLabel: 'Sammamish, WA', homeLat: 47.6163, homeLng: -122.0356 }];

  // Seed a couple of bills so the bills_agent has something to report in the no-login demo (a real
  // signed-in user gets these from the autonomous email scan instead). Parsed fields only.
  const bills: Bill[] = [
    { id: uuid(), payee: 'Puget Sound Energy', amount: '$84.20', dueDate: addDaysISO(today, 6), account: '••4821', createdAt: today },
    { id: uuid(), payee: 'Comcast', amount: '$120.00', dueDate: addDaysISO(today, 12), createdAt: today },
  ];

  // Seed one ingested "newsletter" doc so the local-knowledge grounding (copilot + the agent's
  // search_local_knowledge) has corpus to work with in the no-login demo. A real user gets these from the
  // autonomous newsletter scan instead.
  const documents: LibraryDoc[] = [
    { id: uuid(), folder: 'Newsletters', name: 'Eastside Weekend Guide', createdAt: today,
      text: 'From: EverOut Seattle\nThis weekend on the Eastside: VegFest at Marymoor Park (Saturday, free), '
        + 'the Redmond Lights market, and a family nature walk at Lake Sammamish State Park on Sunday morning.' },
  ];

  // Seed one in-progress goal so the Today GoalsStrip lands populated AND the morning planner has an
  // open goal whose next step it can propose (approval advances it — the goal loop, visible on arrival).
  const goals: Goal[] = [
    { id: 'goal-' + uuid(), text: 'Plan a state-park day trip', status: 'active',
      nextAction: 'Get the Discover Pass', category: 'outing',
      steps: [
        { title: 'Pick the park + date', status: 'done' },
        { title: 'Get the Discover Pass', status: 'active' },
        { title: 'Pack + go', status: 'pending' },
      ] },
  ];

  // Seed ONE pending confirm-tier draft so the Approvals queue is visible the moment a judge arrives
  // (the button only renders when something is pending or resolved — an empty fresh household would hide
  // the safety-gate surface entirely). Shaped exactly like a suggest_event the copilot stages from an
  // inbox find: it references the seeded "Eastside Weekend Guide" newsletter, and approving it rides the
  // existing booking-payload apply path (becomes a calendar event — zero special-casing). Distinct
  // title/date from anything the morning planner proposes, so the briefing's "Stage drafts" beat still
  // stages its own drafts (no dedupe collision). No proactiveDate: this is an inbox find, not a
  // morning-planner draft, and that field keys the digest's same-day dedupe.
  const walkDate = addDaysISO(today, 4);
  const actionledger: LedgerEntry[] = [
    {
      id: 'ledg-' + uuid(),
      tool: 'suggest_event', riskTier: 'confirm', status: 'pending',
      summary: `Add "Family nature walk — Lake Sammamish State Park" ${weekdayOf(walkDate)} 10:00 AM (from your Eastside Weekend Guide)`,
      payload: { booking: { title: 'Family nature walk — Lake Sammamish State Park', start: walkDate, startTime: '10:00' } },
      createdAt: today, createdByUserId: userId,
    },
  ];

  return { members, events, chores, shopping, settings, bills, documents, goals, actionledger };
}
