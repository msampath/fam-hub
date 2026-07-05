import { describe, it, expect } from 'vitest';
import { buildAgentActionResult, detectUnbackedClaims } from '../utils/agentActions';
import type { AgentAction } from '../utils/agentClient';

let n = 0;
const mkId = () => `led-${++n}`;
const stamp = { createdAt: '2026-06-24', createdByUserId: 'u1', createdByEmail: 'a@b.com' };

describe('buildAgentActionResult', () => {
  it('counts auto-tier applied writes and summarizes them as "saved" (not "applied")', () => {
    const actions: AgentAction[] = [
      { tool: 'create_event', status: 'applied' },
      { tool: 'add_chore', status: 'applied' },
    ];
    const r = buildAgentActionResult(actions, mkId, stamp);
    expect(r.appliedCount).toBe(2);
    expect(r.ledger).toHaveLength(0);
    expect(r.summary).toMatch(/2 changes saved/);
    expect(r.summary).not.toMatch(/applied/);
  });

  it('stages confirm/stepup drafts as ledger rows with the right tier', () => {
    const actions: AgentAction[] = [
      { tool: 'reserve', status: 'requires_confirmation', artifact: { summary: "Araya's Place", link: 'https://maps.google.com/x' } },
      { tool: 'add_to_cart', status: 'requires_stepup', artifact: { title: 'Batteries', url: 'https://amazon.com/cart' } },
    ];
    const r = buildAgentActionResult(actions, mkId, stamp);
    expect(r.appliedCount).toBe(0);
    expect(r.ledger.map(l => l.riskTier)).toEqual(['confirm', 'stepup']);
    expect(r.ledger[0].link).toBe('https://maps.google.com/x');
    // reserve + add_to_cart are USER_COMPLETES handoffs → they land under Actions, and the copy says so.
    expect(r.summary).toMatch(/2 drafts staged in Actions/);
    expect(r.summary).not.toMatch(/Approv/);
  });

  it('labels each staged bucket by where it lands: Approvals (agent executes) vs Actions (you complete)', () => {
    const actions: AgentAction[] = [
      { tool: 'delete_event', status: 'requires_confirmation', artifact: { id: 'e1', title: 'Dentist' } },
      { tool: 'prepare_handoff', status: 'requires_confirmation', artifact: { title: 'Timed-entry pass', url: 'https://recreation.gov/x' } },
    ];
    const r = buildAgentActionResult(actions, mkId, stamp);
    expect(r.ledger).toHaveLength(2);
    expect(r.summary).toMatch(/1 draft staged — review in Approvals\./);
    expect(r.summary).toMatch(/1 draft staged in Actions — open & complete\./);
  });

  it('drops non-http(s) draft links (no javascript:/data: phishing into the Approve queue)', () => {
    const actions: AgentAction[] = [
      { tool: 'reserve', status: 'requires_confirmation', artifact: { summary: 'x', link: 'javascript:alert(1)' } },
    ];
    const r = buildAgentActionResult(actions, mkId, stamp);
    expect(r.ledger[0].link).toBeUndefined();
  });

  it('stages a folder-clear delete as ONE row carrying every doc id (capstone #7)', () => {
    const actions: AgentAction[] = [
      { tool: 'delete_document', status: 'requires_confirmation', artifact: { ids: ['d1', 'd2', 'd3'], folder: 'Newsletters', count: 3 } },
    ];
    const r = buildAgentActionResult(actions, mkId, stamp);
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0].refIds).toEqual(['d1', 'd2', 'd3']);
    expect(r.ledger[0].refId).toBeUndefined();
    expect(r.ledger[0].summary).toMatch(/Delete all 3 docs in "Newsletters"/);
  });

  it('stages a single delete with refId, not refIds', () => {
    const actions: AgentAction[] = [
      { tool: 'delete_document', status: 'requires_confirmation', artifact: { id: 'd9', name: 'Lease' } },
    ];
    const r = buildAgentActionResult(actions, mkId, stamp);
    expect(r.ledger[0].refId).toBe('d9');
    expect(r.ledger[0].refIds).toBeUndefined();
    expect(r.ledger[0].summary).toMatch(/Delete "Lease"/);
  });

  it('maps the new destructive chore/shopping tools to the right ledger fields', () => {
    const actions: AgentAction[] = [
      { tool: 'delete_chore', status: 'requires_confirmation', artifact: { title: 'Make bed' } },           // by title → payload
      { tool: 'delete_chore', status: 'requires_confirmation', artifact: { id: 'c7', title: 'Make bed' } }, // id known → refId
      { tool: 'clear_chores', status: 'requires_confirmation', artifact: { all: true } },
      { tool: 'delete_shopping_item', status: 'requires_confirmation', artifact: { text: 'milk' } },
      { tool: 'update_chore', status: 'requires_confirmation', artifact: { ref: { matchTitle: 'Make bed' }, changes: { points: 25 } } },
    ];
    const r = buildAgentActionResult(actions, mkId, stamp);
    expect(r.ledger).toHaveLength(5);
    const [delTitle, delId, clear, delShop, upd] = r.ledger;
    expect(delTitle).toMatchObject({ tool: 'delete_chore', payload: { title: 'Make bed' } });
    expect(delTitle.refId).toBeUndefined();
    expect(delId).toMatchObject({ tool: 'delete_chore', refId: 'c7' });
    expect(clear).toMatchObject({ tool: 'clear_chores', payload: { all: true } });
    expect(clear.summary).toMatch(/Delete ALL chores/);
    expect(delShop).toMatchObject({ tool: 'delete_shopping_item', payload: { text: 'milk' } });
    expect(upd).toMatchObject({ tool: 'update_chore', payload: { ref: { matchTitle: 'Make bed' } }, changes: { points: 25 } });
    expect(upd.summary).toMatch(/Update chore "Make bed"/);
  });

  it('maps delete_event by title+start to payload, and by id to refId', () => {
    const actions: AgentAction[] = [
      { tool: 'delete_event', status: 'requires_confirmation', artifact: { title: 'Zoo Day', start: '2026-07-05' } }, // by title → payload
      { tool: 'delete_event', status: 'requires_confirmation', artifact: { id: 'evt-9', title: 'Zoo Day' } },          // id known → refId
    ];
    const r = buildAgentActionResult(actions, mkId, stamp);
    expect(r.ledger).toHaveLength(2);
    const [byTitle, byId] = r.ledger;
    expect(byTitle).toMatchObject({ tool: 'delete_event', payload: { title: 'Zoo Day', start: '2026-07-05' } });
    expect(byTitle.refId).toBeUndefined();
    expect(byTitle.summary).toMatch(/Delete event "Zoo Day"/);
    expect(byId).toMatchObject({ tool: 'delete_event', refId: 'evt-9' });
  });

  it('stages an update_event with refId + changes so approval can merge it (agent path: mark free / move)', () => {
    const actions: AgentAction[] = [
      { tool: 'update_event', status: 'requires_confirmation', artifact: { id: 'evt-1', before: { title: 'Independence Day', category: 'Holiday' }, changes: { freeBusy: 'free' } } },
    ];
    const r = buildAgentActionResult(actions, mkId, stamp);
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0]).toMatchObject({ tool: 'update_event', refId: 'evt-1', changes: { freeBusy: 'free' } });
    expect(r.ledger[0].summary).toMatch(/Update "Independence Day"/);
  });

  it('ignores suggest_event (a tap-to-add chip, not an Approve-queue row)', () => {
    const r = buildAgentActionResult([{ tool: 'suggest_event', status: 'validated', artifact: { title: 'Zoo', start: '2026-07-04' } }], mkId, stamp);
    expect(r.ledger).toHaveLength(0);
    expect(r.appliedCount).toBe(0);
  });

  it('update_chore staged by id (no matchTitle) gets a non-empty summary — no blank quotes', () => {
    const r = buildAgentActionResult(
      [{ tool: 'update_chore', status: 'requires_confirmation', artifact: { ref: { id: 'c3' }, changes: { points: 5 } } }],
      mkId, stamp,
    );
    expect(r.ledger[0].summary).toBe('Update a chore');
  });

  it('carries a booking stub on a reserve/handoff draft so approval can land it on the calendar', () => {
    const actions: AgentAction[] = [
      { tool: 'reserve', status: 'requires_confirmation', artifact: { summary: 'Reserve: Cafe Flora', link: 'https://maps.google.com/x', booking: { title: 'Cafe Flora', start: '2026-07-09', startTime: '18:00' } } },
      { tool: 'prepare_handoff', status: 'requires_confirmation', artifact: { summary: 'Review & submit: DTF', link: 'https://www.yelp.com/reserve/dtf', title: 'DTF Bellevue', fields: [{ label: 'Date', value: '2026-07-09' }, { label: 'Time', value: '6:00 PM' }] } },
    ];
    const r = buildAgentActionResult(actions, mkId, stamp);
    expect((r.ledger[0].payload as any).booking).toEqual({ title: 'Cafe Flora', start: '2026-07-09', startTime: '18:00' });
    expect(r.ledger[0].link).toBe('https://maps.google.com/x');
    expect((r.ledger[1].payload as any).booking).toEqual({ title: 'DTF Bellevue', start: '2026-07-09', startTime: '18:00' });
    expect(r.ledger[1].link).toBe('https://www.yelp.com/reserve/dtf');
  });

  it('ignores unknown / read-only tools entirely', () => {
    const actions: AgentAction[] = [
      { tool: 'get_bills', status: 'validated' },        // read tool → not an action
      { tool: 'drop_database', status: 'applied' },        // unknown → ignored
    ];
    const r = buildAgentActionResult(actions, mkId, stamp);
    expect(r.appliedCount).toBe(0);
    expect(r.ledger).toHaveLength(0);
    expect(r.summary).toBe('');
  });
});

describe('detectUnbackedClaims (honesty guard — narrated but not called)', () => {
  const set_goal: AgentAction = { tool: 'set_goal', status: 'validated', artifact: { id: 'g1', text: 'Trip' } } as any;
  const handoff: AgentAction = { tool: 'prepare_handoff', status: 'requires_confirmation', artifact: { summary: 'Lodging', link: 'https://x' } } as any;

  it('flags a PAST-TENSE goal claim with no set_goal action', () => {
    const out = detectUnbackedClaims('I have set up a new multi-step Goal to track this trip.', []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/tracked Goal/i);
  });
  it('flags a staged-booking claim with no handoff action', () => {
    const out = detectUnbackedClaims('I have staged two reservation drafts for you in your Approvals.', []);
    expect(out.some(c => /booking\/pass|booking/i.test(c))).toBe(true);
  });
  it('does NOT flag when the matching tool actually fired', () => {
    expect(detectUnbackedClaims('I have set up a Goal and staged the lodging booking in your Actions.', [set_goal, handoff])).toEqual([]);
  });
  it('does NOT flag a DEFERRED (future-tense) claim', () => {
    expect(detectUnbackedClaims("Once we clear the Zoo Day conflict, I'll set up the lodging booking for you.", [])).toEqual([]);
  });
  it('flags a goal-COMPLETION claim with no set_goal action (the lite-model lie)', () => {
    const out = detectUnbackedClaims('I have marked the goal as complete. The goal for your Vancouver trip is now fully complete.', []);
    expect(out.some(c => /goal\/task was updated or complete/i.test(c))).toBe(true);
  });
  it('flags an "updated the task" completion claim with no set_goal action', () => {
    const out = detectUnbackedClaims("I've updated the task to reflect that the lodging is now complete.", []);
    expect(out.some(c => /updated or complete/i.test(c))).toBe(true);
  });
  it('does NOT flag a goal-completion claim when set_goal actually fired', () => {
    expect(detectUnbackedClaims('I have marked the goal as complete.', [set_goal])).toEqual([]);
  });
  it('flags a "booked" claim ALWAYS (no-payment honesty), even when a handoff was staged', () => {
    const out = detectUnbackedClaims('Your trip is now fully planned and booked.', [handoff]);
    expect(out.some(c => /never book, reserve, or pay/i.test(c))).toBe(true);
  });
  it('does NOT false-positive on a 2nd-person / negation booking mention', () => {
    expect(detectUnbackedClaims("I haven't booked anything — you book the lodging yourself from the link in Actions.", [handoff])).toEqual([]);
  });
  it('does NOT flag a venue NO-AVAILABILITY report ("the hotel is fully booked")', () => {
    expect(detectUnbackedClaims("That hotel is fully booked for those dates — here are two others with rooms.", [])).toEqual([]);
  });
  it('does NOT flag a non-goal "marked it complete" / "that task is done" (briefing/calendar)', () => {
    expect(detectUnbackedClaims("Updated your calendar — I've marked it complete.", [])).toEqual([]);
    expect(detectUnbackedClaims("Leo still has one task left; the other task is done.", [])).toEqual([]);
  });
});
