// @vitest-environment node
// Integration coverage for the LAN-appliance auth perimeter + data API (server.ts LOCAL_MODE). These routes
// are the single-tenant box's security boundary — household-passphrase login, box-signed sessions, and the
// /api/data CAS path — and had NO request-level test (server.ts sat at ~27%). Driven in-process via supertest
// against the exported `app` (startServer is VITEST-gated, so importing the module binds no port). Each test
// gets a FRESH module + in-memory SQLite via vi.resetModules(), so the box starts unconfigured every time.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';

// Each test resetModules() + re-imports the large server.ts graph for isolation; that cold import can exceed
// the 5s default when the whole suite's transform cache is cold, so give this file room and warm it once.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
beforeAll(async () => { await import('../../server'); });

async function freshApp(env: Record<string, string> = {}) {
  vi.resetModules();
  process.env.STORAGE = 'sqlite';
  process.env.SQLITE_PATH = ':memory:';
  process.env.GEMINI_API_KEY = 'test-key';
  delete process.env.VITE_SUPABASE_URL;
  delete process.env.VITE_SUPABASE_ANON_KEY;
  delete process.env.LOGIN_PER_MIN;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const mod = await import('../../server');
  return mod.app;
}

const PASS = 'family-secret';

describe('LAN appliance auth + data API (LOCAL_MODE)', () => {
  it('GET /api/auth/status reports sqlite mode + unconfigured on a fresh box', async () => {
    const app = await freshApp();
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'sqlite', configured: false });
  });

  it('first /api/auth/setup returns a session token + flips status to configured; a 2nd setup 409s', async () => {
    const app = await freshApp();
    const setup = await request(app).post('/api/auth/setup').send({ passphrase: PASS });
    expect(setup.status).toBe(200);
    expect(typeof setup.body.token).toBe('string');

    const status = await request(app).get('/api/auth/status');
    expect(status.body).toEqual({ mode: 'sqlite', configured: true });

    const again = await request(app).post('/api/auth/setup').send({ passphrase: PASS });
    expect(again.status).toBe(409);
  });

  it('/api/auth/setup rejects a too-short passphrase with 400 (before configuring)', async () => {
    const app = await freshApp();
    const res = await request(app).post('/api/auth/setup').send({ passphrase: 'short' });
    expect(res.status).toBe(400);
  });

  it('/api/auth/login: correct passphrase 200s with a token; wrong passphrase 401s', async () => {
    const app = await freshApp();
    await request(app).post('/api/auth/setup').send({ passphrase: PASS });

    const ok = await request(app).post('/api/auth/login').send({ passphrase: PASS });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.token).toBe('string');

    const bad = await request(app).post('/api/auth/login').send({ passphrase: 'wrong-pass' });
    expect(bad.status).toBe(401);
  });

  it('/api/data/:key requires a valid Bearer token (no header → 401, garbage → 401, valid → 200)', async () => {
    const app = await freshApp();
    const { body: { token } } = await request(app).post('/api/auth/setup').send({ passphrase: PASS });

    expect((await request(app).get('/api/data/events')).status).toBe(401);
    expect((await request(app).get('/api/data/events').set('Authorization', 'Bearer not.a.real.token')).status).toBe(401);
    expect((await request(app).get('/api/data/events').set('Authorization', `Bearer ${token}`)).status).toBe(200);
  });

  it('POST then GET /api/data/:key round-trips household data; an invalid key is a clean 400', async () => {
    const app = await freshApp();
    const { body: { token } } = await request(app).post('/api/auth/setup').send({ passphrase: PASS });
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

    const save = await auth(request(app).post('/api/data/events').send({ data: [{ id: 'e1', title: 'Zoo' }] }));
    expect(save.status).toBe(200);
    expect(save.body.ok).toBe(true);

    const load = await auth(request(app).get('/api/data/events'));
    expect(load.status).toBe(200);
    expect(load.body.data).toEqual([{ id: 'e1', title: 'Zoo' }]);

    const badKey = await auth(request(app).get('/api/data/BadKey'));
    expect(badKey.status).toBe(400);
  });

  it('a stale-version POST /api/data/:key is rejected 409 (CAS delegated to the adapter)', async () => {
    const app = await freshApp();
    const { body: { token } } = await request(app).post('/api/auth/setup').send({ passphrase: PASS });
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

    const first = await auth(request(app).post('/api/data/chores').send({ data: [{ id: 'c1' }], version: null }));
    expect(first.status).toBe(200);
    const version = first.body.version;
    // Re-using the now-stale version (the row already moved to `version`) must conflict, not clobber.
    const stale = await auth(request(app).post('/api/data/chores').send({ data: [{ id: 'c2' }], version: 'an-old-version' }));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('stale');
    // The valid current version succeeds.
    const ok = await auth(request(app).post('/api/data/chores').send({ data: [{ id: 'c2' }], version }));
    expect(ok.status).toBe(200);
  });

  it('login is rate-limited per IP (429 once the per-minute window fills)', async () => {
    const app = await freshApp({ LOGIN_PER_MIN: '3' });
    await request(app).post('/api/auth/setup').send({ passphrase: PASS });
    let sawLimit = false;
    for (let i = 0; i < 6; i++) {
      const r = await request(app).post('/api/auth/login').send({ passphrase: 'wrong' });
      if (r.status === 429) { sawLimit = true; break; }
    }
    expect(sawLimit).toBe(true);
  });

  it('cloud mode (STORAGE=supabase) returns 400 from the local-only auth + data endpoints', async () => {
    const app = await freshApp({ STORAGE: 'supabase', VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon-key' });
    expect((await request(app).post('/api/auth/setup').send({ passphrase: PASS })).status).toBe(400);
    expect((await request(app).post('/api/auth/login').send({ passphrase: PASS })).status).toBe(400);
  });
});
