import { describe, it, expect, vi, afterEach } from 'vitest';
import { askConciergeAgent, isAgentConfigured } from '../utils/agentClient';

describe('agentClient', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('isAgentConfigured reflects VITE_AGENT_BASE_URL (the on/off flag)', () => {
    vi.stubEnv('VITE_AGENT_BASE_URL', '');
    expect(isAgentConfigured()).toBe(false);
    vi.stubEnv('VITE_AGENT_BASE_URL', 'on');
    expect(isAgentConfigured()).toBe(true);
  });

  it('throws (does not call fetch) when not configured', async () => {
    vi.stubEnv('VITE_AGENT_BASE_URL', '');
    const fetchMock = vi.spyOn(globalThis, 'fetch' as any);
    await expect(askConciergeAgent('jwt', '', 'hi')).rejects.toThrow(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to the SAME-ORIGIN /api/agent/chat with the JWT + message, and parses {reply,sessionId,actions}', async () => {
    vi.stubEnv('VITE_AGENT_BASE_URL', 'on'); // value is just a flag now, not a URL
    const fetchMock = vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true, json: async () => ({ reply: 'Added it.', sessionId: 's1', actions: [{ tool: 'create_event', status: 'applied' }] }),
    } as any);
    const out = await askConciergeAgent('the-jwt', 's0', 'add a zoo day');
    expect(out).toEqual({ reply: 'Added it.', sessionId: 's1', actions: [{ tool: 'create_event', status: 'applied' }] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agent/chat'); // same-origin, proxied by Express (CSP-safe)
    expect((init.headers as any).Authorization).toBe('Bearer the-jwt');
    expect(JSON.parse(init.body as string)).toEqual({ message: 'add a zoo day', sessionId: 's0', clientDate: expect.any(String) });
  });

  it('omits sessionId on a fresh conversation and Authorization when no JWT', async () => {
    vi.stubEnv('VITE_AGENT_BASE_URL', 'on');
    const fetchMock = vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true, json: async () => ({ reply: 'hi', sessionId: 'new' }),
    } as any);
    await askConciergeAgent(null, '', 'hello');
    const init = (fetchMock.mock.calls[0] as any)[1] as RequestInit;
    expect('Authorization' in (init.headers as any)).toBe(false);
    expect(JSON.parse(init.body as string)).toEqual({ message: 'hello', clientDate: expect.any(String) });
  });

  it('throws a friendly error on a non-2xx response', async () => {
    vi.stubEnv('VITE_AGENT_BASE_URL', 'on');
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({ ok: false, status: 503 } as any);
    await expect(askConciergeAgent('jwt', '', 'hi')).rejects.toThrow(/unavailable/i);
  });
});
