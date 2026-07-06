// @vitest-environment node
// Request-level coverage for the ~36 server routes that had NO endpoint test (serverAuth.test.ts covers
// the auth perimeter + /api/data CAS; this file covers everything else). Driven in-process via supertest
// against the exported `app` (startServer is VITEST-gated → no port, no Vite middleware, and note the
// /internal/run-digest route + SPA fallback + last-resort error middleware live INSIDE startServer, so
// they are deliberately out of scope here). Every test stays on a deterministic path: auth rejection,
// input-validation 4xx, or pure/local-FS happy paths (photos, step-up scrypt, kroger auth-url building,
// sqlite-backed agent-job lookups). NO outbound AI/network call is ever reached — validation 400s fire
// before any fetch/Gemini layer, and paths that would fetch (geocode with in-range coords, kroger
// locations with creds, agent chat happy path) are intentionally not exercised.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Cold-importing the full server.ts graph per app instance can exceed the 5s default while the suite's
// transform cache warms; same accommodation serverAuth.test.ts makes.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
beforeAll(async () => { await import('../../server'); });

async function freshApp(env: Record<string, string> = {}) {
  vi.resetModules();
  process.env.STORAGE = 'sqlite';
  process.env.SQLITE_PATH = ':memory:';
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.AI_RATE_LIMIT_PER_MIN = '1000'; // the per-route validation sweep must not trip the AI limiter
  delete process.env.VITE_SUPABASE_URL;
  delete process.env.VITE_SUPABASE_ANON_KEY;
  // NB: server.ts runs dotenv.config() at import, which re-populates any key we merely delete from a
  // developer's real .env — but dotenv never OVERRIDES an existing key, so pin these to '' (falsy) to
  // guarantee the unconfigured baseline regardless of the machine's .env.
  process.env.KROGER_CLIENT_ID = '';
  process.env.KROGER_CLIENT_SECRET = '';
  process.env.PHOTOS_DIR = '';
  process.env.EMAIL_SCAN_DISABLED = '';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const mod = await import('../../server');
  return mod.app;
}

// Set up the box + log in, returning a helper that stamps the Bearer token on a request.
async function authedApp(env: Record<string, string> = {}) {
  const app = await freshApp(env);
  const { body: { token } } = await request(app).post('/api/auth/setup').send({ passphrase: 'family-secret' });
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  return { app, auth };
}

const UUID = '00000000-0000-4000-8000-000000000000';

// ── 1. Auth perimeter: every requireAuth route must 401 with no token ─────────────────────────────
// Table-driven so a forgotten Authorization check on any of these is a one-line-diff failure.
const PROTECTED_ROUTES: [method: 'get' | 'post', path: string][] = [
  ['post', '/api/auth/change-passphrase'],
  ['get', '/api/data/events'],
  ['post', '/api/data/events'],
  ['get', '/api/data'],
  ['post', '/api/parse-calendar'],
  ['post', '/api/parse-pdf'],
  ['post', '/api/extract-pdf-text'],
  ['post', '/api/extract-docx-text'],
  ['post', '/api/extract-xlsx-text'],
  ['post', '/api/extract-url-text'],
  ['post', '/api/parse-text'],
  ['post', '/api/parse-recipe'],
  ['post', '/api/pantry-restock'],
  ['post', '/api/meal-plan'],
  ['post', '/api/vision-scan-pantry'],
  ['get', '/api/photos/list'],
  ['get', '/api/photos/file/x.jpg'],
  ['post', '/api/photos/upload'],
  ['post', '/api/revise-draft'],
  ['post', '/api/parse-quickadd'],
  ['post', '/api/generate-chores'],
  ['post', '/api/copilot'],
  ['post', '/api/google-refresh'],
  ['get', '/api/kroger/auth-url'],
  ['get', '/api/kroger/poll'],
  ['get', '/api/kroger/locations'],
  ['post', '/api/kroger/match'],
  ['post', '/api/kroger/cart-add'],
  ['post', '/api/geocode'],
  ['post', '/api/stepup/set'],
  ['post', '/api/stepup/verify'],
  ['post', '/api/scan-bills'],
  ['post', '/api/scan-newsletters'],
  ['post', '/api/scan-packages'],
  ['post', '/api/scan-kids'],
  ['post', '/api/camera-summary'],
  ['post', '/api/morning-briefing'],
  ['post', '/api/agent/chat'],
  ['post', '/api/agent/chat-async'],
  ['get', `/api/agent/job/${UUID}`],
];

describe('auth perimeter (401 sweep over every requireAuth route)', () => {
  let app: any;
  beforeAll(async () => { app = await freshApp(); });

  it.each(PROTECTED_ROUTES)('%s %s → 401 without a token', async (method, route) => {
    const res = await request(app)[method](route);
    expect(res.status).toBe(401);
    expect(res.body.error).toBeTruthy();
  });

  it('a garbage Bearer token is also rejected (not just a missing one)', async () => {
    const res = await request(app).post('/api/copilot').set('Authorization', 'Bearer nope').send({ prompt: 'hi' });
    expect(res.status).toBe(401);
  });

  it('GET /api/health stays open (the deploy probe) and reports ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ── 2. Input validation: each route's cheap 4xx fires BEFORE any model/network work ───────────────
describe('input-validation 4xx (deterministic, pre-AI/pre-network)', () => {
  let auth: (r: request.Test) => request.Test;
  let app: any;
  beforeAll(async () => { ({ app, auth } = await authedApp()); });

  const post = (route: string, body: any = {}) => auth(request(app).post(route).send(body));

  it('change-passphrase: short new passphrase 400; wrong old passphrase 401', async () => {
    expect((await post('/api/auth/change-passphrase', { oldPassphrase: 'family-secret', newPassphrase: 'ab' })).status).toBe(400);
    expect((await post('/api/auth/change-passphrase', { oldPassphrase: 'wrong', newPassphrase: 'new-family-secret' })).status).toBe(401);
  });

  it.each([
    ['/api/parse-calendar', {}, 'URL'],
    ['/api/parse-pdf', {}, 'PDF data'],
    ['/api/extract-pdf-text', {}, 'PDF data'],
    ['/api/extract-docx-text', {}, 'File data'],
    ['/api/extract-xlsx-text', {}, 'File data'],
    ['/api/extract-url-text', {}, 'URL'],
    ['/api/parse-text', { calendarText: '   ' }, 'text content'],
    ['/api/parse-recipe', { text: '' }, 'recipe text'],
    ['/api/pantry-restock', { pantry: [] }, 'Pantry'],
    ['/api/meal-plan', { pantry: [] }, 'Pantry'],
    ['/api/vision-scan-pantry', {}, 'image'],
    ['/api/revise-draft', { tool: 'create_event' }, 'requested change'],
    ['/api/parse-quickadd', { text: '' }, 'text'],
    ['/api/generate-chores', { kids: [{ name: 'Ava', age: 99 }] }, 'age'],
    ['/api/copilot', {}, 'Prompt'],
    ['/api/google-refresh', {}, 'Refresh token'],
  ] as [string, any, string][])('%s rejects an empty/missing payload with 400', async (route, body, needle) => {
    const res = await post(route, body);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain(needle);
  });

  it('extract-url-text: a private/loopback target is refused 400 by the SSRF guard at request level', async () => {
    const res = await post('/api/extract-url-text', { url: 'http://127.0.0.1/admin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/private or local|allowed/i);
  });

  it('geocode: non-ZIP garbage 400; out-of-range coordinates 400 (both before any lookup fetch)', async () => {
    expect((await post('/api/geocode', { q: 'not a zip' })).status).toBe(400);
    expect((await post('/api/geocode', { q: '95, 200' })).status).toBe(400);
  });

  it('scan routes: without a Google/Microsoft token header the scan is a clean 400, not a crash', async () => {
    for (const route of ['/api/scan-bills', '/api/scan-newsletters', '/api/scan-packages', '/api/scan-kids']) {
      const res = await post(route);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Connect your Google or Microsoft account');
    }
  });

  it('camera-summary is an honest 501 placeholder', async () => {
    expect((await post('/api/camera-summary')).status).toBe(501);
  });

  it('EMAIL_SCAN_DISABLED short-circuits scan-bills to an empty 200 (the credit-burn off-switch)', async () => {
    const { app: a2, auth: auth2 } = await authedApp({ EMAIL_SCAN_DISABLED: 'true' });
    const res = await auth2(request(a2).post('/api/scan-bills').send({}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ suggestions: [], bills: [], scanned: 0 });
  });
});

// ── 3. Photos: list shape, traversal-proof file serving, upload round-trip (local FS only) ────────
describe('photos routes (PHOTOS_DIR corpus)', () => {
  let app: any;
  let auth: (r: request.Test) => request.Test;
  let dir: string;
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'famhub-photos-'));
    fs.writeFileSync(path.join(dir, 'a.jpg'), Buffer.from(PNG_B64, 'base64'));
    fs.writeFileSync(path.join(dir, 'a.jpg.json'), JSON.stringify({ createTime: '2020-05-05T00:00:00.000Z' }));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a photo');
    ({ app, auth } = await authedApp({ PHOTOS_DIR: dir }));
  });

  it('list returns only photo files, honoring the createTime sidecar', async () => {
    const res = await auth(request(app).get('/api/photos/list'));
    expect(res.status).toBe(200);
    expect(res.body.photos).toEqual([{ name: 'a.jpg', createTime: '2020-05-05T00:00:00.000Z' }]);
  });

  it('file serving is traversal-proof: encoded ../ and ..\\ names and non-photo extensions are 400', async () => {
    for (const bad of ['..%2Fserver.ts', '..%5Csecret.jpg', 'notes.txt']) {
      const res = await auth(request(app).get(`/api/photos/file/${bad}`));
      expect(res.status).toBe(400);
    }
  });

  it('file serving: a real photo streams 200; a missing one is a clean 404', async () => {
    const ok = await auth(request(app).get('/api/photos/file/a.jpg'));
    expect(ok.status).toBe(200);
    expect((await auth(request(app).get('/api/photos/file/nope.jpg'))).status).toBe(404);
  });

  it('upload: rejects a bad name and missing data with 400; a valid upload lands in the corpus', async () => {
    expect((await auth(request(app).post('/api/photos/upload').send({ name: 'x.exe', imageBase64: PNG_B64 }))).status).toBe(400);
    expect((await auth(request(app).post('/api/photos/upload').send({ name: 'b.png' }))).status).toBe(400);

    const up = await auth(request(app).post('/api/photos/upload').send({ name: 'b.png', imageBase64: `data:image/png;base64,${PNG_B64}`, createTime: '2021-01-01T00:00:00.000Z' }));
    expect(up.status).toBe(200);
    expect(up.body).toEqual({ ok: true, name: 'b.png' });

    const list = await auth(request(app).get('/api/photos/list'));
    const names = list.body.photos.map((p: any) => p.name).sort();
    expect(names).toEqual(['a.jpg', 'b.png']);
    expect(list.body.photos.find((p: any) => p.name === 'b.png').createTime).toBe('2021-01-01T00:00:00.000Z');
  });
});

// ── 4. Kroger: config gating, nonce poll, and validation — no Kroger API traffic ──────────────────
describe('kroger routes', () => {
  describe('unconfigured server (no client id/secret)', () => {
    let app: any;
    let auth: (r: request.Test) => request.Test;
    beforeAll(async () => { ({ app, auth } = await authedApp()); });

    it('every kroger surface degrades to an honest 503, including the public callback', async () => {
      expect((await auth(request(app).get('/api/kroger/auth-url'))).status).toBe(503);
      expect((await auth(request(app).get('/api/kroger/locations?lat=47&lng=-122'))).status).toBe(503);
      expect((await auth(request(app).post('/api/kroger/match').send({ locationId: 'x', items: ['milk'] }))).status).toBe(503);
      expect((await auth(request(app).post('/api/kroger/cart-add').send({ refreshToken: 't', items: [] }))).status).toBe(503);
      expect((await request(app).get('/api/kroger/callback?code=abc')).status).toBe(503);
    });
  });

  describe('configured server (creds set; still no outbound calls on these paths)', () => {
    let app: any;
    let auth: (r: request.Test) => request.Test;
    beforeAll(async () => {
      ({ app, auth } = await authedApp({ KROGER_CLIENT_ID: 'test-client', KROGER_CLIENT_SECRET: 'test-secret' }));
    });

    it('auth-url returns a Kroger authorize URL + a fresh state nonce (pure string building)', async () => {
      const res = await auth(request(app).get('/api/kroger/auth-url'));
      expect(res.status).toBe(200);
      expect(res.body.url).toContain('test-client');
      expect(res.body.url).toContain(encodeURIComponent(res.body.state));
      expect(res.body.state).toMatch(/^[0-9a-f]{32}$/);
    });

    it('poll: an unknown (or missing) state nonce reports pending — never someone else\'s token', async () => {
      expect((await auth(request(app).get('/api/kroger/poll'))).body).toEqual({ pending: true });
      expect((await auth(request(app).get('/api/kroger/poll?state=deadbeef'))).body).toEqual({ pending: true });
    });

    it('locations requires finite lat/lng (400 before any store lookup)', async () => {
      expect((await auth(request(app).get('/api/kroger/locations'))).status).toBe(400);
      expect((await auth(request(app).get('/api/kroger/locations?lat=abc&lng=-122'))).status).toBe(400);
    });

    it('match requires a locationId and at least one item', async () => {
      expect((await auth(request(app).post('/api/kroger/match').send({ items: ['milk'] }))).status).toBe(400);
      expect((await auth(request(app).post('/api/kroger/match').send({ locationId: 'x', items: [] }))).status).toBe(400);
    });

    it('cart-add: no device refresh token 400; no valid items 400 (the UPC filter)', async () => {
      expect((await auth(request(app).post('/api/kroger/cart-add').send({ items: [{ upc: '123', quantity: 1 }] }))).status).toBe(400);
      expect((await auth(request(app).post('/api/kroger/cart-add').send({ refreshToken: 'tok', items: [] }))).status).toBe(400);
    });

    it('callback without an authorization code is 400', async () => {
      expect((await request(app).get('/api/kroger/callback')).status).toBe(400);
    });
  });
});

// ── 5. Step-up PIN: scrypt round-trip + both brute-force limiters (all local crypto) ──────────────
describe('step-up PIN routes', () => {
  let app: any;
  let auth: (r: request.Test) => request.Test;
  beforeAll(async () => { ({ app, auth } = await authedApp()); });

  it('set: non-digit / wrong-length PINs 400; a valid PIN yields {hash,salt}; the 4th change in 5min is 429', async () => {
    expect((await auth(request(app).post('/api/stepup/set').send({ pin: '12' }))).status).toBe(400);      // 1st window slot
    expect((await auth(request(app).post('/api/stepup/set').send({ pin: 'abcd' }))).status).toBe(400);    // 2nd
    const ok = await auth(request(app).post('/api/stepup/set').send({ pin: '246810' }));                  // 3rd
    expect(ok.status).toBe(200);
    expect(ok.body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.body.salt).toMatch(/^[0-9a-f]{32}$/);
    // STEPUP_SET_PER_5MIN defaults to 3 — the setter is itself rate-limited so a hijacked session can't
    // harvest fresh {hash,salt} pairs in a loop.
    expect((await auth(request(app).post('/api/stepup/set').send({ pin: '135790' }))).status).toBe(429);  // 4th → limited
  });

  it('verify: true for the right PIN, false for wrong/malformed, and 429 once the per-minute cap fills', async () => {
    const salt = 'a'.repeat(32);
    const { hashStepUpPin } = await import('../../server');
    const hash = hashStepUpPin('4321', salt);

    expect((await auth(request(app).post('/api/stepup/verify').send({ pin: '4321', hash, salt }))).body).toEqual({ valid: true });   // 1
    expect((await auth(request(app).post('/api/stepup/verify').send({ pin: '9999', hash, salt }))).body).toEqual({ valid: false });  // 2
    expect((await auth(request(app).post('/api/stepup/verify').send({ pin: '4321' }))).body).toEqual({ valid: false });              // 3 (no hash/salt)
    expect((await auth(request(app).post('/api/stepup/verify').send({ pin: '4321', hash, salt }))).status).toBe(200);                // 4
    expect((await auth(request(app).post('/api/stepup/verify').send({ pin: '4321', hash, salt }))).status).toBe(200);                // 5
    // STEPUP_VERIFY_PER_MIN defaults to 5 — a 4-digit PIN is 10k combos, so attempt 6 must be walled off.
    const limited = await auth(request(app).post('/api/stepup/verify').send({ pin: '4321', hash, salt }));
    expect(limited.status).toBe(429);
  });
});

// ── 5b. PIN failure lockout at the route level (rate window widened so the lockout is what trips) ─
describe('step-up PIN failure lockout (5 wrong → 10-min lock)', () => {
  it('4 fails then a success resets; 5 fails lock out even the CORRECT pin afterwards', async () => {
    const { app, auth } = await authedApp({ STEPUP_VERIFY_PER_MIN: '100' });
    const { hashStepUpPin } = await import('../../server');
    const salt = 'b'.repeat(32);
    const hash = hashStepUpPin('7777', salt);
    const verify = (pin: string) => auth(request(app).post('/api/stepup/verify').send({ pin, hash, salt }));

    // 4 consecutive fails stay open, and a success wipes the counter…
    for (let i = 0; i < 4; i++) expect((await verify('0000')).body).toEqual({ valid: false });
    expect((await verify('7777')).body).toEqual({ valid: true });

    // …so it takes 5 FRESH fails to lock; after that even the right PIN is refused (nothing leaks while locked).
    for (let i = 0; i < 5; i++) expect((await verify('0000')).status).toBe(200);
    const locked = await verify('7777');
    expect(locked.status).toBe(429);
    expect(locked.body.error).toContain('locked');
  });
});

// ── 6. Async agent jobs: id validation + the foreign-id-is-404 household boundary ─────────────────
describe('agent job routes (sqlite-backed, no agent traffic)', () => {
  let app: any;
  let auth: (r: request.Test) => request.Test;
  beforeAll(async () => { ({ app, auth } = await authedApp()); });

  it('chat-async requires a non-empty message (400 before anything is queued)', async () => {
    expect((await auth(request(app).post('/api/agent/chat-async').send({}))).status).toBe(400);
    expect((await auth(request(app).post('/api/agent/chat-async').send({ message: '   ' }))).status).toBe(400);
  });

  it('job poll: a malformed id is 400; a well-formed id from another household (or nowhere) is 404', async () => {
    expect((await auth(request(app).get('/api/agent/job/not-a-uuid'))).status).toBe(400);
    // By design a foreign household's job id is indistinguishable from a nonexistent one — both 404.
    const res = await auth(request(app).get(`/api/agent/job/${UUID}`));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No such job.');
  });
});
