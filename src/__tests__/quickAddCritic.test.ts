import { describe, it, expect } from 'vitest';
import { verifyQuickAdd, buildQuickAddCriticNote, coerceQuickAdd } from '../utils/quickAddCritic';
import { verifyActionClaims, unbackedClaimCorrection } from '../utils/copilotCritic';

const CTX = { members: ['Ava', 'Max'], stores: ['Costco', 'Indian Store', 'Grocery Store', 'Other'], today: '2026-07-05' };

describe('verifyQuickAdd', () => {
  it('accepts a clean event / shopping / chore parse', () => {
    expect(verifyQuickAdd({ kind: 'event', event: { title: 'Dentist', start: '2026-07-08', startTime: '14:00', members: ['Ava'] } }, CTX)).toEqual([]);
    expect(verifyQuickAdd({ kind: 'shopping', items: [{ text: 'milk', store: 'Costco' }] }, CTX)).toEqual([]);
    expect(verifyQuickAdd({ kind: 'chore', chore: { title: 'Water plants', assignedTo: 'Max' } }, CTX)).toEqual([]);
  });

  it('names the concrete problems: bad kind, past/fake dates, unknown member, invalid store', () => {
    expect(verifyQuickAdd({ kind: 'reminder' } as any, CTX)[0]).toMatch(/kind/);
    expect(verifyQuickAdd({ kind: 'event', event: { title: 'X', start: '2026-02-30' } }, CTX).join()).toMatch(/REAL calendar date/);
    expect(verifyQuickAdd({ kind: 'event', event: { title: 'X', start: '2026-07-01' } }, CTX).join()).toMatch(/in the past/);
    expect(verifyQuickAdd({ kind: 'event', event: { title: 'X', start: '2026-07-08', members: ['Bob'] } }, CTX).join()).toMatch(/not a known family member/);
    expect(verifyQuickAdd({ kind: 'shopping', items: [{ text: 'rice', store: 'Walmart' }] }, CTX).join()).toMatch(/must be one of/);
    expect(verifyQuickAdd({ kind: 'chore', chore: { title: 'Tidy', assignedTo: 'Bob' } }, CTX).join()).toMatch(/not a known family member/);
  });

  it('lets multi-kid chore phrases through verbatim', () => {
    expect(verifyQuickAdd({ kind: 'chore', chore: { title: 'Tidy', assignedTo: 'both kids' } }, CTX)).toEqual([]);
  });

  it('builds a critic note that lists every issue', () => {
    const note = buildQuickAddCriticNote(['a', 'b']);
    expect(note).toMatch(/- a\n- b/);
  });
});

describe('coerceQuickAdd', () => {
  it('coerces fixable fields and never invents required ones', () => {
    const out = coerceQuickAdd({
      kind: 'event',
      event: { title: 'Party', start: '2026-07-08', startTime: '4pm', category: 'Fun', members: ['Bob', 'Ava'] },
    }, CTX);
    expect(out.event!.category).toBe('Other');
    expect(out.event!.startTime).toBeUndefined();  // '4pm' dropped, not guessed
    expect(out.event!.members).toEqual(['Ava']);   // unknown member dropped, known kept
  });

  it('defaults bad stores and clamps chore numbers', () => {
    const shop = coerceQuickAdd({ kind: 'shopping', items: [{ text: 'rice', store: 'Walmart' }, { text: '' }] }, CTX);
    expect(shop.items).toEqual([{ text: 'rice', store: 'Grocery Store' }]);
    const chore = coerceQuickAdd({ kind: 'chore', chore: { title: 'Tidy', assignedTo: 'Max', points: -5, timesPerDay: 99, repeatType: 'monthly' } }, CTX);
    expect(chore.chore).toMatchObject({ points: 10, timesPerDay: 10, repeatType: 'daily' });
  });
});

describe('verifyActionClaims (quick-path honesty guard)', () => {
  it('flags a completed claim with no matching action — the exact live failure', () => {
    const issues = verifyActionClaims("I've added milk to your shopping list.", []);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('add_shopping_item');
    expect(verifyActionClaims("I've scheduled a dentist appointment for Max next Tuesday at 2 PM.", []).length).toBe(1);
    expect(verifyActionClaims("I've added a chore for Ava to water the plants.", []).length).toBe(1);
  });

  it('stays quiet when the action backs the claim, and on offers/deferrals', () => {
    expect(verifyActionClaims("I've added milk to your shopping list.", [{ type: 'add_shopping_item' }])).toEqual([]);
    expect(verifyActionClaims('Want me to add milk to the shopping list?', [])).toEqual([]);
    expect(verifyActionClaims("I can schedule that for Tuesday — just say the word.", [])).toEqual([]);
    expect(verifyActionClaims("I'll put milk on the shopping list right away.", [])).toEqual([]);
    expect(verifyActionClaims('Here is what is on your calendar this week.', [])).toEqual([]);
  });

  it('catches the live evasions: third-person copilot voice and plural "chores"', () => {
    expect(verifyActionClaims("Okay, the family's copilot has added milk to your shopping list.", []).length).toBe(1);
    expect(verifyActionClaims('Okay, I\'ve added "Water plants" to Ava\'s chores for tomorrow morning.', []).length).toBe(1);
    expect(verifyActionClaims('I added milk to the shopping list.', []).length).toBe(1);
  });

  it('unbackedClaimCorrection appends the honest correction only when needed', () => {
    expect(unbackedClaimCorrection("I've added milk to your shopping list.", [])).toMatch(/isn't saved yet/);
    expect(unbackedClaimCorrection("I've added milk to your shopping list.", [{ type: 'add_shopping_item' }])).toBeNull();
  });
});
