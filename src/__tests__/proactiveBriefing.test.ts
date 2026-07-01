import { describe, it, expect } from 'vitest';
import { buildProactiveLedger, buildGoalNudges } from '../utils/proactiveBriefing';
import type { Briefing } from '../utils/briefing';
import type { CalendarEvent, LedgerEntry, Goal } from '../types';

let n = 0;
const mkId = () => `pr-${++n}`;
const stamp = { createdAt: '2026-06-25', createdByUserId: 'concierge', createdByEmail: 'concierge@familyhub' };
const TODAY = '2026-06-25';
const emptyBriefing: Briefing = { title: 'x', lines: [], nudges: [] };

describe('buildProactiveLedger (#1 proactive)', () => {
  it('stages a gift draft from a birthday nudge that carries a listItem', () => {
    const briefing: Briefing = { ...emptyBriefing, nudges: [
      { kind: 'birthday', date: '2026-06-30', text: "🎁 Mia's Birthday on Tue Jun 30 — add a gift?", listItem: 'Gift for Mia' },
      { kind: 'anniversary', date: '2026-07-02', text: '💐 Anniversary — plan something' }, // no listItem → skipped
    ] };
    const out = buildProactiveLedger(briefing, null, [], TODAY, mkId, stamp);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tool: 'add_shopping_item', status: 'pending', riskTier: 'confirm', proactiveDate: TODAY });
    expect((out[0].payload as any).text).toBe('Gift for Mia');
  });

  it('stages an umbrella when rain is likely during a today outdoor event', () => {
    const events: CalendarEvent[] = [{ id: 'e1', title: 'Soccer practice', start: TODAY } as any];
    const weather = { time: [TODAY], precipitation_probability_max: [80] };
    const out = buildProactiveLedger(emptyBriefing, weather, events, TODAY, mkId, stamp);
    expect(out).toHaveLength(1);
    expect((out[0].payload as any).text).toBe('Umbrella');
    expect(out[0].summary).toMatch(/Rain likely \(80%\).*Soccer practice/);
  });

  it('does NOT stage an umbrella for an indoor event or a dry forecast', () => {
    const dry = buildProactiveLedger(emptyBriefing, { time: [TODAY], precipitation_probability_max: [10] }, [{ id: 'e1', title: 'Soccer practice', start: TODAY } as any], TODAY, mkId, stamp);
    expect(dry).toHaveLength(0);
    const indoor = buildProactiveLedger(emptyBriefing, { time: [TODAY], precipitation_probability_max: [90] }, [{ id: 'e2', title: 'Piano lesson', start: TODAY } as any], TODAY, mkId, stamp);
    expect(indoor).toHaveLength(0);
  });

  it('returns nothing for an empty briefing + no weather', () => {
    expect(buildProactiveLedger(emptyBriefing, null, [], TODAY, mkId, stamp)).toEqual([]);
  });

  it('de-dupes against an item already pending in the ledger (cross-day re-run)', () => {
    const briefing: Briefing = { ...emptyBriefing, nudges: [
      { kind: 'birthday', date: '2026-06-30', text: '🎁 gift?', listItem: 'Gift for Mia' },
    ] };
    const existing: LedgerEntry[] = [
      { id: 'old', tool: 'add_shopping_item', riskTier: 'confirm', status: 'pending', payload: { text: 'gift for mia' } } as any,
    ];
    expect(buildProactiveLedger(briefing, null, [], TODAY, mkId, stamp, existing)).toHaveLength(0);
  });
});

describe('buildGoalNudges (A6 goal loop — scheduler half)', () => {
  const g = (over: Partial<Goal>): Goal => ({ id: 'g', text: 'Plan Rainier trip', status: 'active', ...over } as Goal);
  it('nudges a goal waiting on an approval toward the app', () => {
    const out = buildGoalNudges([g({ status: 'waiting', steps: [{ title: 'Reserve pass', status: 'blocked' }] })]);
    expect(out).toEqual(['🎯 "Plan Rainier trip" — waiting on your approval in the app.']);
  });
  it('surfaces the nextAction for an active goal', () => {
    expect(buildGoalNudges([g({ nextAction: 'Pick the venue' })])).toEqual(['🎯 "Plan Rainier trip" — next: Pick the venue.']);
  });
  it('counts remaining steps when there is no nextAction', () => {
    expect(buildGoalNudges([g({ steps: [{ title: 'a', status: 'done' }, { title: 'b', status: 'pending' }] })]))
      .toEqual(['🎯 "Plan Rainier trip" — 1 step left.']);
  });
  it('skips done / abandoned goals', () => {
    expect(buildGoalNudges([g({ status: 'done' }), g({ status: 'abandoned' })])).toEqual([]);
  });
});
