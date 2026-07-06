// askConciergeAgentAsync — the queue-and-poll client for /api/agent/chat-async (roadmap "Async agent
// jobs"). Not yet wired into the UI; these tests are the shipping gate. Node env (no DOM): the seam is
// global fetch + timers, mocked per the krogerClient.test.ts pattern (fake timers + a tick() driver).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { askConciergeAgentAsync, AGENT_JOB_POLL_MS, AGENT_JOB_MAX_POLLS } from '../utils/agentClient';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('VITE_AGENT_BASE_URL', 'on'); // the on/off flag that reveals the agent
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const json = (body: any, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) });

// Advance the 2s poll loop N times, flushing the awaits between ticks (same driver as the kroger test).
async function tick(n: number) { for (let i = 0; i < n; i++) { await vi.advanceTimersByTimeAsync(AGENT_JOB_POLL_MS); } }

// Script the server: POST accepts with a jobId; each GET walks the given status sequence (sticking on
// the last entry), so a test reads like the job's actual lifecycle.
function scriptServer(jobId: string, polls: any[]) {
  let pollCount = 0;
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/agent/chat-async') return json({ jobId });
    if (url === `/api/agent/job/${jobId}`) return json(polls[Math.min(pollCount++, polls.length - 1)]);
    return json({}, false, 404);
  });
}

describe('askConciergeAgentAsync', () => {
  it('POSTs the SAME turn body as the sync client, then polls to done and resolves the AgentReply shape', async () => {
    scriptServer('J1', [
      { id: 'J1', status: 'queued' },
      { id: 'J1', status: 'running' },
      { id: 'J1', status: 'done', reply: 'Zoo day added.', sessionId: 's9', model: 'gemini-x', actions: [{ tool: 'create_event', status: 'applied' }, { notATool: true }] },
    ]);

    const p = askConciergeAgentAsync('the-jwt', 's0', 'plan a zoo day', { family: 'Ava (7)' });
    await tick(3);
    await expect(p).resolves.toEqual({
      reply: 'Zoo day added.',
      sessionId: 's9',
      model: 'gemini-x',
      actions: [{ tool: 'create_event', status: 'applied', tier: undefined, artifact: undefined, message: undefined }], // malformed element dropped
    });

    // The queue POST carries the identical turn-body contract the sync path sends.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agent/chat-async');
    expect((init.headers as any).Authorization).toBe('Bearer the-jwt');
    expect(JSON.parse(init.body as string)).toEqual({ message: 'plan a zoo day', sessionId: 's0', family: 'Ava (7)' });
    // Polls hit the job route WITH the JWT (requireAuth guards it server-side).
    const [pollUrl, pollInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(pollUrl).toBe('/api/agent/job/J1');
    expect((pollInit.headers as any).Authorization).toBe('Bearer the-jwt');
  });

  it('falls back to the CALLER’s sessionId when a done job carries none (conversation not dropped)', async () => {
    scriptServer('J2', [{ id: 'J2', status: 'done', reply: 'hi', actions: [] }]);
    const out = await (async () => { const p = askConciergeAgentAsync('jwt', 's-prev', 'hello'); await tick(1); return p; })();
    expect(out.sessionId).toBe('s-prev');
  });

  it('rejects with the job’s honest failure text when the worker landed it in error', async () => {
    scriptServer('J3', [{ id: 'J3', status: 'running' }, { id: 'J3', status: 'error', reply: 'The agent returned HTTP 503.' }]);
    const p = askConciergeAgentAsync('jwt', '', 'hi');
    const assertion = expect(p).rejects.toThrow('The agent returned HTTP 503.');
    await tick(2);
    await assertion;
  });

  it('gives up honestly after ~3 minutes of a still-running job (the process-died contract)', async () => {
    scriptServer('J4', [{ id: 'J4', status: 'running' }]); // never completes — e.g. the server died mid-turn
    const p = askConciergeAgentAsync('jwt', '', 'hi');
    const assertion = expect(p).rejects.toThrow(/still working after 3 minutes/i);
    await tick(AGENT_JOB_MAX_POLLS);
    await assertion;
    expect(fetchMock.mock.calls.length).toBe(1 + AGENT_JOB_MAX_POLLS); // the POST + every poll, then stop
  });

  it('is terminal when a poll itself fails (expired session / job gone) — no blind spinning', async () => {
    let first = true;
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/agent/chat-async') return json({ jobId: 'J5' });
      if (first) { first = false; return json({ id: 'J5', status: 'running' }); }
      return json({ error: 'No such job.' }, false, 404);
    });
    const p = askConciergeAgentAsync('jwt', '', 'hi');
    const assertion = expect(p).rejects.toThrow(/could not be checked \(404\)/i);
    await tick(2);
    await assertion;
  });

  it('rejects up front when the queue POST fails or returns no jobId (nothing to poll)', async () => {
    fetchMock.mockImplementation(() => json({}, false, 503));
    await expect(askConciergeAgentAsync('jwt', '', 'hi')).rejects.toThrow(/unavailable right now \(503\)/i);

    fetchMock.mockImplementation(() => json({ notAJobId: true }));
    await expect(askConciergeAgentAsync('jwt', '', 'hi')).rejects.toThrow(/did not accept/i);
  });

  it('throws (no fetch at all) when the agent panel is not configured', async () => {
    vi.stubEnv('VITE_AGENT_BASE_URL', '');
    await expect(askConciergeAgentAsync('jwt', '', 'hi')).rejects.toThrow(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
