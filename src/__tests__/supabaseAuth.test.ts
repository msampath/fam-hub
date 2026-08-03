// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the args passed to signInWithOAuth so we can assert redirectTo.
const signInWithOAuth = vi.fn().mockResolvedValue({ data: {}, error: null });

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { signInWithOAuth },
  }),
}));

describe('signInWithGoogle redirectTo', () => {
  beforeEach(() => {
    signInWithOAuth.mockClear();
  });

  it('sends origin + /fam-hub (no trailing slash) as redirectTo', async () => {
    const { signInWithGoogle } = await import('../supabase');
    await signInWithGoogle();

    expect(signInWithOAuth).toHaveBeenCalledTimes(1);
    const opts = signInWithOAuth.mock.calls[0][0].options;

    // Must be an exact string, so it exact-matches the corresponding entry in Supabase
    // Redirect URLs (Bug 8). Appending '/' would force reliance on a "<origin>/**" glob,
    // which is not a dependable match. The app lives at /fam-hub, so login must return there.
    expect(opts.redirectTo).toBe(`${window.location.origin}/fam-hub`);
    expect(opts.redirectTo.endsWith('/')).toBe(false);
  });
});
