import { describe, it, expect } from 'vitest';
import { selectRelevantDocs, buildLocalKnowledgeFacts } from '../utils/localKnowledge';

const DOCS = [
  { name: 'Early-release policy', folder: 'School', text: 'Early release is every Wednesday at 1:30pm.', createdAt: '2026-01-01' },
  { name: 'Lease', folder: 'Home', text: 'Rent is due on the 1st. Landlord is Pat.', createdAt: '2026-02-01' },
  { name: 'Doctors', folder: 'Lists', text: 'Pediatrician: Dr. Kim, 555-0100.', createdAt: '2026-03-01' },
];

describe('selectRelevantDocs', () => {
  it('ranks docs by keyword overlap with the query', () => {
    const picked = selectRelevantDocs(DOCS, 'what is the early release schedule?', 1);
    expect(picked).toHaveLength(1);
    expect(picked[0].name).toBe('Early-release policy');
  });

  it('falls back to most-recent docs when nothing matches', () => {
    const picked = selectRelevantDocs(DOCS, 'unrelated zzzzz query', 1);
    expect(picked).toHaveLength(1);
    expect(picked[0].name).toBe('Doctors'); // newest createdAt
  });

  it('returns nothing for an empty corpus', () => {
    expect(selectRelevantDocs([], 'anything')).toEqual([]);
  });
});

describe('buildLocalKnowledgeFacts', () => {
  it('builds a LOCAL KNOWLEDGE FACTS block from the matching doc text', () => {
    const block = buildLocalKnowledgeFacts(DOCS, 'when is rent due', 2);
    expect(block).toMatch(/LOCAL KNOWLEDGE FACTS/);
    expect(block).toMatch(/Rent is due on the 1st/);
  });

  it('returns an empty string for an empty corpus', () => {
    expect(buildLocalKnowledgeFacts([], 'anything')).toBe('');
  });

  it('clips long document text to keep the prompt bounded', () => {
    const long = [{ name: 'Big', folder: 'X', text: 'rent ' + 'x'.repeat(2000), createdAt: '2026-01-01' }];
    const block = buildLocalKnowledgeFacts(long, 'rent', 1, 100);
    expect(block.length).toBeLessThan(400);
  });
});
