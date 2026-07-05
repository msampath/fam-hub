import { describe, it, expect } from 'vitest';
import { QUICKPATH_GOLDENS, scoreGolden, summarize, addDaysISO } from '../utils/evalScorers';

const TODAY = '2026-07-05';
const ok = (over = {}) => ({ answer: 'Done!', suggestions: [], actions: [], model: 'gemini-2.5-flash', usedFallback: false, ...over });

describe('eval goldens', () => {
  it('are well-formed: unique ids, non-empty prompts, at most one primary expectation style', () => {
    const ids = QUICKPATH_GOLDENS.map(g => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of QUICKPATH_GOLDENS) {
      expect(g.prompt.trim().length).toBeGreaterThan(5);
      // decline goldens must not also expect actions
      if (g.expect.decline) expect(g.expect.action).toBeUndefined();
    }
  });
});

describe('scoreGolden', () => {
  it('passes an action golden when the action is present, fails when absent', () => {
    const g = QUICKPATH_GOLDENS.find(x => x.id === 'act-shop-milk')!;
    expect(scoreGolden(g, ok({ actions: [{ type: 'add_shopping_item' }] }), TODAY).ok).toBe(true);
    const miss = scoreGolden(g, ok(), TODAY);
    expect(miss.ok).toBe(false);
    expect(miss.failures[0]).toMatch(/missing action add_shopping_item/);
  });

  it('fails a Q&A golden that hallucinates actions', () => {
    const g = QUICKPATH_GOLDENS.find(x => x.id === 'qa-week')!;
    const s = scoreGolden(g, ok({ actions: [{ type: 'create_event' }] }), TODAY);
    expect(s.ok).toBe(false);
    expect(s.failures[0]).toMatch(/expected no actions/);
  });

  it('recognizes the shared scope-guard decline and rejects declines that leak actions', () => {
    const g = QUICKPATH_GOLDENS.find(x => x.id === 'scope-math')!;
    const decline = "I'm the family's copilot — I can't help with that, but I can plan your week.";
    expect(scoreGolden(g, ok({ answer: decline }), TODAY).ok).toBe(true);
    expect(scoreGolden(g, ok({ answer: '1 + 1 equals 2.' }), TODAY).ok).toBe(false);
    expect(scoreGolden(g, ok({ answer: decline, actions: [{ type: 'add_chore' }] }), TODAY).ok).toBe(false);
  });

  it('enforces the forbidden-action safety golden and tomorrow date discipline', () => {
    const del = QUICKPATH_GOLDENS.find(x => x.id === 'safe-no-delete')!;
    expect(scoreGolden(del, ok({ actions: [{ type: 'delete_event' }] }), TODAY).ok).toBe(false);
    expect(scoreGolden(del, ok({ answer: 'I can stage that for approval instead.' }), TODAY).ok).toBe(true);

    const tom = QUICKPATH_GOLDENS.find(x => x.id === 'plan-tomorrow')!;
    expect(addDaysISO(TODAY, 1)).toBe('2026-07-06');
    expect(scoreGolden(tom, ok({ suggestions: [{ type: 'idea', start: '2026-07-06', title: 'Picnic' }] }), TODAY).ok).toBe(true);
    expect(scoreGolden(tom, ok({ suggestions: [{ type: 'idea', start: '2026-07-09', title: 'Picnic' }] }), TODAY).ok).toBe(false);
  });
});

describe('summarize', () => {
  it('computes pass rate and local-serve rate', () => {
    const s = summarize('local', [
      { id: 'a', ok: true, servedBy: 'ollama:gpt-oss:20b', usedFallback: false, failures: [] },
      { id: 'b', ok: false, servedBy: 'gemini-2.5-flash', usedFallback: true, failures: ['x'] },
    ]);
    expect(s.passRate).toBe(0.5);
    expect(s.localServeRate).toBe(0.5);
  });
});
