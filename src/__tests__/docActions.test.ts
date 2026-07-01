import { describe, it, expect } from 'vitest';
import { resolveDoc, normalizeFolder } from '../utils/docActions';
import { buildAgentActionResult } from '../utils/agentActions';
import type { LibraryDoc } from '../types';
import type { AgentAction } from '../utils/agentClient';

const docs: LibraryDoc[] = [
  { id: 'd1', folder: 'School', name: 'Band calendar', text: '...' },
  { id: 'd2', folder: 'Home', name: 'Lease', text: '...' },
];

describe('resolveDoc', () => {
  it('matches by exact id', () => {
    expect(resolveDoc(docs, { id: 'd2' })?.name).toBe('Lease');
  });
  it('matches by exact name (case-insensitive), then substring', () => {
    expect(resolveDoc(docs, { name: 'lease' })?.id).toBe('d2');
    expect(resolveDoc(docs, { name: 'band' })?.id).toBe('d1');
  });
  it('returns null when nothing matches', () => {
    expect(resolveDoc(docs, { name: 'mortgage' })).toBeNull();
    expect(resolveDoc(docs, {})).toBeNull();
  });
  it('with fuzzy=false (destructive delete) requires an exact id/name — no substring match', () => {
    // "band" only substring-matches "Band calendar"; strict mode must NOT resolve it.
    expect(resolveDoc(docs, { name: 'band' }, false)).toBeNull();
    // exact name + exact id still resolve under strict mode.
    expect(resolveDoc(docs, { name: 'Band calendar' }, false)?.id).toBe('d1');
    expect(resolveDoc(docs, { id: 'd2' }, false)?.name).toBe('Lease');
  });
});

describe('normalizeFolder', () => {
  it('defaults blank to Uncategorized', () => {
    expect(normalizeFolder('')).toBe('Uncategorized');
    expect(normalizeFolder(undefined)).toBe('Uncategorized');
    expect(normalizeFolder('  Taxes ')).toBe('Taxes');
  });
});

describe('buildAgentActionResult — doc tools', () => {
  let n = 0;
  const mkId = () => `led-${++n}`;
  const stamp = { createdAt: '2026-06-24' };

  it('move_document applied → counted, no ledger', () => {
    const actions: AgentAction[] = [{ tool: 'move_document', status: 'applied', artifact: { id: 'd1', name: 'Band calendar', folder: 'Music' } }];
    const r = buildAgentActionResult(actions, mkId, stamp);
    expect(r.appliedCount).toBe(1);
    expect(r.ledger).toHaveLength(0);
  });

  it('delete_document confirm → ledger row carrying the doc id as refId', () => {
    const actions: AgentAction[] = [{ tool: 'delete_document', status: 'requires_confirmation', artifact: { id: 'd2', name: 'Lease' } }];
    const r = buildAgentActionResult(actions, mkId, stamp);
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0].tool).toBe('delete_document');
    expect(r.ledger[0].riskTier).toBe('confirm');
    expect(r.ledger[0].refId).toBe('d2');
    expect(r.ledger[0].summary).toMatch(/Delete "Lease"/);
  });
});
