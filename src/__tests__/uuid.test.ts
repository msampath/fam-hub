import { describe, it, expect } from 'vitest';
import { uuid } from '../utils/uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('uuid', () => {
  it('returns a v4-shaped id and is unique across calls', () => {
    const a = uuid();
    const b = uuid();
    expect(a).toMatch(V4);
    expect(b).toMatch(V4);
    expect(a).not.toBe(b);
  });

  it('falls back to getRandomValues when crypto.randomUUID is unavailable (insecure-context LAN)', () => {
    const c: any = (globalThis as any).crypto;
    const orig = c.randomUUID;
    try {
      c.randomUUID = undefined; // simulate a plain-http LAN origin where randomUUID is gone
      const id = uuid();
      expect(id).toMatch(V4); // still a valid v4, built from getRandomValues
    } finally {
      c.randomUUID = orig;
    }
  });
});
