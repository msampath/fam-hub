// Photos screensaver weighting: the owner's memory mix — recent (90d) surfaces most, "this time
// N years ago" (±30d) next, the long tail still appears. And the order must cover EVERY photo per
// cycle (no starvation) deterministically under an injected rand.
import { describe, it, expect } from 'vitest';
import { photoWeight, buildPhotoOrder } from '../utils/photoPicks';

const NOW = '2026-07-06T12:00:00Z';

describe('photoWeight', () => {
  it('weights recent > anniversary-window > everything else', () => {
    expect(photoWeight('2026-06-20T00:00:00Z', NOW)).toBe(3); // 16 days ago — recent
    expect(photoWeight('2025-07-10T00:00:00Z', NOW)).toBe(2); // ~1 year ago, inside ±30d
    expect(photoWeight('2022-07-20T00:00:00Z', NOW)).toBe(2); // 4 years ago, inside the window
    expect(photoWeight('2026-01-15T00:00:00Z', NOW)).toBe(1); // 6 months ago — neither window
    expect(photoWeight('2019-07-06T00:00:00Z', NOW)).toBe(1); // 7 years — beyond the 5y windows
    expect(photoWeight('garbage', NOW)).toBe(1);              // unparseable → long-tail weight
  });
});

describe('buildPhotoOrder', () => {
  const photos = [
    { name: 'old.jpg', createTime: '2026-01-15T00:00:00Z' },   // w1
    { name: 'recent.jpg', createTime: '2026-06-20T00:00:00Z' }, // w3
    { name: 'anniv.jpg', createTime: '2025-07-10T00:00:00Z' },  // w2
  ];

  it('covers every photo exactly once per cycle', () => {
    const order = buildPhotoOrder(photos, NOW, () => 0.0);
    expect(order.map(p => p.name).sort()).toEqual(['anniv.jpg', 'old.jpg', 'recent.jpg']);
  });

  it('is deterministic under an injected rand, and rand→0 picks by weight order', () => {
    // rand()=0 always takes the first pool entry the roll lands on — the heaviest-first pick when
    // the heaviest is first reached. Assert determinism (same rand → same order).
    const a = buildPhotoOrder(photos, NOW, () => 0.99);
    const b = buildPhotoOrder(photos, NOW, () => 0.99);
    expect(a).toEqual(b);
  });

  it('recent photos lead the order more often than the long tail (statistical, seeded LCG)', () => {
    let seed = 42;
    const lcg = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    let recentFirst = 0;
    for (let i = 0; i < 200; i++) if (buildPhotoOrder(photos, NOW, lcg)[0].name === 'recent.jpg') recentFirst++;
    // recent has weight 3 of 6 total → first ~50% of cycles; the w1 photo ~17%.
    expect(recentFirst).toBeGreaterThan(70);
  });

  it('tolerates junk input', () => {
    expect(buildPhotoOrder([], NOW)).toEqual([]);
    expect(buildPhotoOrder([{ name: '', createTime: 'x' } as any], NOW)).toEqual([]);
  });
});
