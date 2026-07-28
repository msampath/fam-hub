// safeFetch — the redirect re-validation + credential-strip loop (the uncovered ~50% of ssrfGuard, and
// the DNS-rebind / redirect-to-private-IP defense). `undici` is mocked so no socket ever opens; `dns` is
// mocked so assertSafeUrl resolves deterministically. Locks in the F013/F041 remediation.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// One shared mock fetch the tests program per-hop. Hoisted so vi.mock can see it.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock('undici', () => ({
  fetch: mockFetch,
  Agent: class { constructor(public opts: any) {} },
}));
// assertSafeUrl calls dns.lookup(host, { all: true }) → must return an ARRAY of {address,family}.
// Resolve any hostname to a fixed PUBLIC IP so the guard admits it; IP-literal hosts (the private
// redirect target) skip DNS and are checked directly by isBlockedIp.
vi.mock('dns/promises', () => ({
  default: { lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) },
}));

import { safeFetch, readTextCapped } from '../utils/ssrfGuard';

// Minimal undici-Response stand-in: headers.get + a body with getReader/cancel.
function res(status: number, headers: Record<string, string> = {}, bodyChunks: string[] = []) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  let i = 0;
  return {
    status,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    body: {
      getReader: () => ({
        read: async () => (i < bodyChunks.length ? { done: false, value: new TextEncoder().encode(bodyChunks[i++]) } : { done: true, value: undefined }),
        cancel: async () => {},
      }),
      cancel: async () => {},
    },
    text: async () => bodyChunks.join(''),
  };
}

beforeEach(() => mockFetch.mockReset());

describe('safeFetch redirect handling', () => {
  it('re-validates each hop and rejects a 302 into a private address', async () => {
    // Public host resolves fine; the redirect target is a private IP literal → assertSafeUrl throws.
    mockFetch.mockResolvedValueOnce(res(302, { location: 'http://192.168.1.5/' }));
    await expect(safeFetch('https://example.com/', {})).rejects.toThrow(/private|blocked|not allowed|internal/i);
    expect(mockFetch).toHaveBeenCalledTimes(1); // never fetched the private target
  });

  it('stops after maxHops redirects', async () => {
    mockFetch.mockResolvedValue(res(302, { location: 'https://example.com/next' }));
    await expect(safeFetch('https://example.com/', {}, 3)).rejects.toThrow(/too many redirects/i);
  });

  it('strips Authorization/Cookie and switches to GET on a 303, keeping safe headers', async () => {
    mockFetch
      .mockResolvedValueOnce(res(303, { location: 'https://example.com/after' }))
      .mockResolvedValueOnce(res(200, {}, ['ok']));
    await safeFetch('https://example.com/', { method: 'POST', body: 'x', headers: { Authorization: 'Bearer secret', Cookie: 'sid=1', 'X-Ok': '1' } } as any);
    const secondInit = mockFetch.mock.calls[1][1];
    expect(secondInit.method).toBe('GET');
    expect(secondInit.body).toBeUndefined();
    const sentHeaders = Object.fromEntries(Object.entries(secondInit.headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(sentHeaders.authorization).toBeUndefined();
    expect(sentHeaders.cookie).toBeUndefined();
    expect(sentHeaders['x-ok']).toBe('1');
  });

  it('strips credentials even when headers is a Headers instance (F041 regression)', async () => {
    mockFetch
      .mockResolvedValueOnce(res(302, { location: 'https://example.com/after' }))
      .mockResolvedValueOnce(res(200, {}, ['ok']));
    const headers = new Headers({ Authorization: 'Bearer secret', 'X-Ok': '1' });
    await safeFetch('https://example.com/', { headers } as any);
    const sent = mockFetch.mock.calls[1][1].headers as Record<string, string>;
    const lower = Object.fromEntries(Object.entries(sent).map(([k, v]) => [k.toLowerCase(), v]));
    expect(lower.authorization).toBeUndefined();
    expect(lower['x-ok']).toBe('1');
  });

  it('returns a 3xx with no Location header as-is', async () => {
    mockFetch.mockResolvedValueOnce(res(302, {}));
    const r = await safeFetch('https://example.com/', {});
    expect(r.status).toBe(302);
  });
});

describe('readTextCapped', () => {
  it('reads a small streamed body fully', async () => {
    const r = res(200, {}, ['hello ', 'world']);
    expect(await readTextCapped(r, 1000)).toBe('hello world');
  });

  it('throws BODY_TOO_LARGE past the cap', async () => {
    const r = res(200, {}, ['x'.repeat(10), 'y'.repeat(10)]);
    await expect(readTextCapped(r, 15)).rejects.toThrow('BODY_TOO_LARGE');
  });
});
