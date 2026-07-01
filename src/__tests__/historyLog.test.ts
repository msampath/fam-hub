import { describe, it, expect } from 'vitest';
import {
  appendCapped,
  truncateForLog,
  buildCopilotLogEntry,
  buildQuickAddLogEntry,
  buildLedgerEntry,
  MAX_LOGGED_ANSWER,
  LEDGER_CAP,
} from '../utils/historyLog';
import type { Authored } from '../types';

const stamp: Authored = { createdAt: '2026-06-18T00:00:00Z', createdByUserId: 'u1', createdByEmail: 'a@b.c' };

describe('appendCapped', () => {
  it('appends at the end (newest last)', () => {
    expect(appendCapped([1, 2], 3, 10)).toEqual([1, 2, 3]);
  });

  it('keeps only the most-recent `cap`, dropping the oldest', () => {
    const out = appendCapped([1, 2, 3], 4, 3);
    expect(out).toEqual([2, 3, 4]); // 1 (oldest) dropped, newest kept
  });

  it('tolerates a non-array list', () => {
    expect(appendCapped(undefined as any, 'x', 5)).toEqual(['x']);
  });
});

describe('truncateForLog', () => {
  it('leaves a short string unchanged', () => {
    expect(truncateForLog('hi', 10)).toBe('hi');
  });

  it('truncates a long string and marks it', () => {
    const out = truncateForLog('x'.repeat(50), 10);
    expect(out).toBe('x'.repeat(10) + '…[truncated]');
  });

  it('returns empty string for non-strings', () => {
    expect(truncateForLog(undefined, 10)).toBe('');
    expect(truncateForLog(42 as any, 10)).toBe('');
  });
});

describe('buildCopilotLogEntry', () => {
  it('captures the structured turn with author stamp', () => {
    const entry = buildCopilotLogEntry('cplog-1', 'plan saturday', {
      answer: 'Try the zoo.',
      model: 'qwen2.5:14b',
      usedFallback: false,
      suggestions: [{ start: '2026-06-20', title: 'Zoo' }],
      actions: [{ type: 'create_event', payload: {} }],
    }, stamp);
    expect(entry).toMatchObject({
      id: 'cplog-1',
      prompt: 'plan saturday',
      answer: 'Try the zoo.',
      model: 'qwen2.5:14b',
      usedFallback: false,
      createdByEmail: 'a@b.c',
      createdByUserId: 'u1',
    });
    expect(entry.suggestions).toHaveLength(1);
    expect(entry.actions).toHaveLength(1);
  });

  it('truncates a very long answer to MAX_LOGGED_ANSWER', () => {
    const entry = buildCopilotLogEntry('cplog-2', 'q', { answer: 'a'.repeat(MAX_LOGGED_ANSWER + 500) }, stamp);
    expect(entry.answer.length).toBe(MAX_LOGGED_ANSWER + '…[truncated]'.length);
    expect(entry.answer.endsWith('…[truncated]')).toBe(true);
  });

  it('omits empty/absent suggestions + actions (undefined, not [])', () => {
    const entry = buildCopilotLogEntry('cplog-3', 'q', { answer: 'a', suggestions: [], actions: [] }, stamp);
    expect(entry.suggestions).toBeUndefined();
    expect(entry.actions).toBeUndefined();
    expect(entry.usedFallback).toBe(false);
  });

  it('tolerates null data', () => {
    const entry = buildCopilotLogEntry('cplog-4', 'q', null, stamp);
    expect(entry.answer).toBe('');
    expect(entry.model).toBeUndefined();
  });
});

describe('buildLedgerEntry', () => {
  it('builds an applied auto entry with summary + refId (a reference, not a PII copy) + stamp', () => {
    const entry = buildLedgerEntry('ledg-1', 'create_event', 'auto', 'applied',
      { summary: 'Added "Zoo" on 2026-06-20', refId: 'cop-1' }, stamp);
    expect(entry).toMatchObject({
      id: 'ledg-1', tool: 'create_event', riskTier: 'auto', status: 'applied',
      summary: 'Added "Zoo" on 2026-06-20', refId: 'cop-1', createdByEmail: 'a@b.c', createdByUserId: 'u1',
    });
    expect('payload' in entry).toBe(false); // internal creates reference by id, never copy the record
  });

  it('builds a pending confirm entry carrying before + changes', () => {
    const entry = buildLedgerEntry('ledg-2', 'update_event', 'confirm', 'pending',
      { summary: 'Proposed change to "Soccer"', before: { id: 'e1', title: 'Soccer' }, changes: { start: '2026-06-22' } }, stamp);
    expect(entry).toMatchObject({ tool: 'update_event', riskTier: 'confirm', status: 'pending' });
    expect(entry.before).toEqual({ id: 'e1', title: 'Soccer' });
    expect(entry.changes).toEqual({ start: '2026-06-22' });
  });

  it('omits absent optional fields (no undefined keys serialized)', () => {
    const entry = buildLedgerEntry('ledg-3', 'add_chore', 'auto', 'applied', undefined, stamp);
    expect('summary' in entry).toBe(false);
    expect('before' in entry).toBe(false);
    expect('changes' in entry).toBe(false);
    expect('payload' in entry).toBe(false);
    expect('refId' in entry).toBe(false);
    expect(entry).toMatchObject({ id: 'ledg-3', tool: 'add_chore', status: 'applied' });
  });

  it('rolls the ledger at LEDGER_CAP via appendCapped (newest kept)', () => {
    let list: ReturnType<typeof buildLedgerEntry>[] = [];
    for (let i = 0; i < LEDGER_CAP + 5; i++) {
      list = appendCapped(list, buildLedgerEntry(`ledg-${i}`, 'create_event', 'auto', 'applied', undefined, stamp), LEDGER_CAP);
    }
    expect(list).toHaveLength(LEDGER_CAP);
    expect(list[list.length - 1].id).toBe(`ledg-${LEDGER_CAP + 4}`);
    expect(list[0].id).toBe('ledg-5'); // first 5 dropped
  });
});

describe('buildQuickAddLogEntry', () => {
  it('captures text + kind + summary + stamp', () => {
    const entry = buildQuickAddLogEntry('qalog-1', 'milk and eggs', 'shopping', '✓ Added 2 items', stamp);
    expect(entry).toMatchObject({
      id: 'qalog-1',
      text: 'milk and eggs',
      kind: 'shopping',
      summary: '✓ Added 2 items',
      createdByEmail: 'a@b.c',
    });
  });

  it('normalizes a falsy kind to undefined', () => {
    const entry = buildQuickAddLogEntry('qalog-2', 'huh?', '', 'x', stamp);
    expect(entry.kind).toBeUndefined();
  });
});
