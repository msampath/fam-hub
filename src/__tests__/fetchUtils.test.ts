// Coverage for fetchCloudRunIdToken (H1 agent-auth): mints the Google ID token Cloud Run's own IAM gate
// requires when the concierge-agent service is deployed --no-allow-unauthenticated. Only attempted when
// K_SERVICE is set (Cloud Run sets this; local dev and a bare `node server.ts` never do) — mocked fetch,
// no real metadata server.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchCloudRunIdToken } from '../server/fetchUtils';

const ORIGINAL_K_SERVICE = process.env.K_SERVICE;

beforeEach(() => { delete process.env.K_SERVICE; vi.restoreAllMocks(); });
afterEach(() => { if (ORIGINAL_K_SERVICE === undefined) delete process.env.K_SERVICE; else process.env.K_SERVICE = ORIGINAL_K_SERVICE; });

describe('fetchCloudRunIdToken', () => {
  it('returns null WITHOUT attempting a fetch when not running on Cloud Run (K_SERVICE unset)', async () => {
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    expect(await fetchCloudRunIdToken('https://agent-v2-abc.a.run.app')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches the metadata server with the audience + Metadata-Flavor header, returns the trimmed token', async () => {
    process.env.K_SERVICE = 'family-hub-web-v2';
    const fetchSpy = vi.fn(async (url: string, init: any) => {
      expect(url).toContain('metadata.google.internal');
      expect(url).toContain(encodeURIComponent('https://agent-v2-abc.a.run.app'));
      expect(init.headers['Metadata-Flavor']).toBe('Google');
      return { ok: true, text: async () => '  a.google.id.token  \n' };
    });
    (globalThis as any).fetch = fetchSpy;
    expect(await fetchCloudRunIdToken('https://agent-v2-abc.a.run.app')).toBe('a.google.id.token');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null when the metadata server responds non-ok', async () => {
    process.env.K_SERVICE = 'family-hub-web-v2';
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, text: async () => '' }));
    expect(await fetchCloudRunIdToken('https://agent-v2-abc.a.run.app')).toBeNull();
  });

  it('returns null (not throw) when the fetch itself fails', async () => {
    process.env.K_SERVICE = 'family-hub-web-v2';
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('network down'); });
    expect(await fetchCloudRunIdToken('https://agent-v2-abc.a.run.app')).toBeNull();
  });
});
