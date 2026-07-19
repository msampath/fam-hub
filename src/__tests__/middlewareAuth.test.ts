// @vitest-environment node
// Coverage for the CLOUD-mode auth path (src/server/middleware.ts requireAuth jose/JWKS branch), which
// had NO test — serverAuth.test.ts exercises only the LOCAL_MODE box-session path. `jose` is mocked so
// no real Supabase JWKS is fetched: we drive jwtVerify's outcome (valid payload / claim rejection /
// throw) and assert requireAuth's 200-passthrough vs 401. A protected route that returns a deterministic
// non-401 once auth passes (cloud /api/copilot → 400 "Prompt is required") is the discriminator.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// One shared mock we reconfigure per test; vi.mock is hoisted and its factory object survives the
// per-test vi.resetModules() re-import of the server graph, so this reference stays wired.
const mockJwtVerify = vi.fn();
vi.mock('jose', () => ({
  createRemoteJWKSet: () => ({}),        // never actually consulted — jwtVerify is fully mocked
  jwtVerify: (...args: any[]) => mockJwtVerify(...args),
}));

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

async function cloudApp() {
  vi.resetModules();
  process.env.STORAGE = 'supabase';
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.AI_RATE_LIMIT_PER_MIN = '1000';
  const mod = await import('../../server');
  return mod.app;
}

const bearer = (r: request.Test) => r.set('Authorization', 'Bearer any.jwt.here');

describe('requireAuth cloud (JWKS/jose) path', () => {
  beforeEach(() => mockJwtVerify.mockReset());

  it('passes a well-formed token (valid sub) through to the handler', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 'user-123', aud: 'authenticated' } });
    const app = await cloudApp();
    // Auth passes → the copilot handler's own 400 (no prompt) proves we got past requireAuth.
    const res = await bearer(request(app).post('/api/copilot').send({}));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Prompt is required');
  });

  it('pins issuer + audience when calling jwtVerify', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 'user-123' } });
    const app = await cloudApp();
    await bearer(request(app).post('/api/copilot').send({ prompt: undefined }));
    expect(mockJwtVerify).toHaveBeenCalledWith(
      'any.jwt.here',
      expect.anything(),
      expect.objectContaining({ issuer: 'https://example.supabase.co/auth/v1', audience: 'authenticated' }),
    );
  });

  it('rejects a verified token that carries no sub claim with 401 (never populates req.user)', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { aud: 'authenticated' } }); // no sub
    const app = await cloudApp();
    const res = await bearer(request(app).post('/api/copilot').send({ prompt: 'hi' }));
    expect(res.status).toBe(401);
  });

  it('401s a request with no Authorization header before jose is consulted', async () => {
    const app = await cloudApp();
    const res = await request(app).post('/api/copilot').send({ prompt: 'hi' });
    expect(res.status).toBe(401);
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });
});
