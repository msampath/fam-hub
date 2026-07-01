import { describe, it, expect } from 'vitest';
import { cosineSimilarity, embedViaOllama } from '../utils/embeddings';
import { selectRelevantDocsSemantic } from '../utils/localKnowledge';
import type { KnowledgeDoc } from '../utils/localKnowledge';

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors, 0 for orthogonal, handles bad input', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1); // same direction
    expect(cosineSimilarity([], [1])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});

describe('embedViaOllama', () => {
  it('returns null (no throw) when the embed server fails', async () => {
    const badFetch = (async () => ({ ok: false } as Response)) as unknown as typeof fetch;
    expect(await embedViaOllama('hi', badFetch)).toBeNull();
    const throwFetch = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await embedViaOllama('hi', throwFetch)).toBeNull();
  });

  it('parses a valid embedding response', async () => {
    const okFetch = (async () => ({ ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) } as Response)) as unknown as typeof fetch;
    expect(await embedViaOllama('hi', okFetch)).toEqual([0.1, 0.2, 0.3]);
  });
});

describe('selectRelevantDocsSemantic', () => {
  const docs: KnowledgeDoc[] = [
    { name: 'Weekend events', text: 'VegFest at Marymoor on Saturday', createdAt: '2026-06-24' },
    { name: 'Lease', text: 'Rent due on the 1st', createdAt: '2026-06-01' },
  ];
  // Fake embedder: query "saturday plans" and the events doc share a dimension → high cosine.
  const fakeEmbed = async (t: string): Promise<number[] | null> => {
    const s = t.toLowerCase();
    return [s.includes('vegfest') || s.includes('saturday') || s.includes('weekend') ? 1 : 0, s.includes('rent') || s.includes('lease') ? 1 : 0];
  };

  it('ranks by embedding similarity', async () => {
    const out = await selectRelevantDocsSemantic(docs, 'what are the weekend plans', 1, fakeEmbed);
    expect(out[0].name).toBe('Weekend events');
  });

  it('falls back to keyword retrieval when the query cannot be embedded', async () => {
    const nullEmbed = async () => null;
    const out = await selectRelevantDocsSemantic(docs, 'rent', 1, nullEmbed);
    expect(out[0].name).toBe('Lease'); // keyword match on "rent"
  });
});
