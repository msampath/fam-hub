import { describe, it, expect } from 'vitest';
import {
  isTransientError,
  orderFallbackModels,
  parseGeminiJSON,
  repairTruncatedJson,
  isRecoverableError,
  resolveFallbackChain,
  isLikelyTextModel,
  isLocalToken,
  buildAttemptChain,
  parseUsZip,
  checkRateWindow,
  pruneExpired,
  resetPruneTimer,
} from '../../server';

describe('isTransientError', () => {
  it('treats overload/capacity/network errors as transient (retry/fallback)', () => {
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ code: 429 })).toBe(true);
    expect(isTransientError({ status: 500 })).toBe(true);
    expect(isTransientError(new Error('503 UNAVAILABLE: high demand'))).toBe(true);
    expect(isTransientError(new Error('RESOURCE_EXHAUSTED'))).toBe(true);
    expect(isTransientError(new Error('The model is OVERLOADED'))).toBe(true);
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
    // AbortController cancellations (our fetch timeouts) are transient — the chain must advance,
    // not short-circuit as if the request were schema-fatal.
    expect(isTransientError(new Error('The operation was aborted'))).toBe(true);
    expect(isTransientError(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))).toBe(true);
    expect(isTransientError(new Error('AbortError: signal is aborted without reason'))).toBe(true);
  });

  it('treats client/auth/schema errors as fatal (do NOT retry)', () => {
    expect(isTransientError({ status: 400 })).toBe(false);
    expect(isTransientError({ status: 401 })).toBe(false);
    expect(isTransientError({ status: 404 })).toBe(false);
    expect(isTransientError(new Error('Invalid JSON schema'))).toBe(false);
    expect(isTransientError(new Error('API key not valid'))).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });
});

describe('orderFallbackModels', () => {
  it('orders lighter models first: flash-lite, flash, other, pro last', () => {
    const input = ['gemini-3.5-pro', 'gemini-3.5-flash', 'gemini-flash-lite', 'some-other-model'];
    expect(orderFallbackModels(input)).toEqual([
      'gemini-flash-lite',
      'gemini-3.5-flash',
      'some-other-model',
      'gemini-3.5-pro',
    ]);
  });

  it('is stable/alphabetical within the same tier and does not mutate input', () => {
    const input = ['gemini-2.0-flash', 'gemini-1.5-flash'];
    const out = orderFallbackModels(input);
    expect(out).toEqual(['gemini-1.5-flash', 'gemini-2.0-flash']);
    expect(input).toEqual(['gemini-2.0-flash', 'gemini-1.5-flash']); // unchanged
  });
});

describe('resolveFallbackChain (pinned vs auto-discovered)', () => {
  it('uses the pinned chain verbatim when one is provided, ignoring discovery', () => {
    const pinned = ['gemini-2.5-flash', 'gemini-2.0-flash'];
    const discovered = ['gemini-flash-lite', 'imagen-3.0'];
    expect(resolveFallbackChain(pinned, discovered, 'gemini-3.5-flash')).toEqual([
      'gemini-2.5-flash',
      'gemini-2.0-flash',
    ]);
  });

  it('falls back to the discovered list when no chain is pinned', () => {
    const discovered = ['gemini-flash-lite', 'gemini-2.0-flash'];
    expect(resolveFallbackChain([], discovered, 'gemini-3.5-flash')).toEqual(discovered);
  });

  it('always removes the primary from the chain (it already had its retries)', () => {
    expect(resolveFallbackChain(['gemini-3.5-flash', 'gemini-2.0-flash'], [], 'gemini-3.5-flash')).toEqual([
      'gemini-2.0-flash',
    ]);
  });
});

describe('isLocalToken', () => {
  it('recognizes the local/ollama sentinels (case-insensitive, trimmed)', () => {
    expect(isLocalToken('local')).toBe(true);
    expect(isLocalToken(' Local ')).toBe(true);
    expect(isLocalToken('OLLAMA')).toBe(true);
  });
  it('does not match real model ids', () => {
    expect(isLocalToken('gemini-flash-latest')).toBe(false);
    expect(isLocalToken('ollama:devstral')).toBe(false); // a model id, not the bare sentinel
    expect(isLocalToken('')).toBe(false);
  });
});

describe('buildAttemptChain (explicit deterministic order)', () => {
  it('preserves the exact configured order, including a local token mid-chain', () => {
    const chain = buildAttemptChain('gemini-flash-latest', [
      'gemini-3.5-flash', 'gemini-flash-lite-latest', 'gemini-pro-latest',
      'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'local',
      'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro',
    ]);
    expect(chain).toEqual([
      'gemini-flash-latest', 'gemini-3.5-flash', 'gemini-flash-lite-latest', 'gemini-pro-latest',
      'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'local',
      'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro',
    ]);
    expect(chain.indexOf('local')).toBe(6); // local stays exactly where configured
  });

  it('de-dupes case-insensitively (first wins) and drops blanks', () => {
    expect(buildAttemptChain('gemini-flash-latest', ['Gemini-Flash-Latest', '', '  ', 'gemini-2.5-flash']))
      .toEqual(['gemini-flash-latest', 'gemini-2.5-flash']);
  });
});

describe('checkRateWindow (AI-endpoint per-user limiter)', () => {
  const WIN = 60_000;
  it('starts a fresh window on first call and counts up to the cap', () => {
    let e = checkRateWindow(undefined, 1_000, 3, WIN);
    expect(e.allowed).toBe(true);
    expect(e.entry).toEqual({ count: 1, resetAt: 61_000 });
    e = checkRateWindow(e.entry, 1_100, 3, WIN); expect(e.allowed).toBe(true); expect(e.entry.count).toBe(2);
    e = checkRateWindow(e.entry, 1_200, 3, WIN); expect(e.allowed).toBe(true); expect(e.entry.count).toBe(3);
  });

  it('blocks once the cap is reached within the window (count not incremented further)', () => {
    const atCap = { count: 3, resetAt: 61_000 };
    const r = checkRateWindow(atCap, 2_000, 3, WIN);
    expect(r.allowed).toBe(false);
    expect(r.entry).toBe(atCap); // unchanged
  });

  it('resets after the window elapses', () => {
    const atCap = { count: 3, resetAt: 61_000 };
    const r = checkRateWindow(atCap, 61_000, 3, WIN); // now >= resetAt
    expect(r.allowed).toBe(true);
    expect(r.entry).toEqual({ count: 1, resetAt: 121_000 });
  });
});

describe('pruneExpired (rate/quota Map eviction — prevents unbounded growth)', () => {
  it('is a no-op below the size floor (cheap on the personal-app path)', () => {
    resetPruneTimer();
    const m = new Map<string, { count: number; resetAt: number }>();
    m.set('a', { count: 1, resetAt: 100 }); // expired vs now=200 but under the floor
    pruneExpired(m, 200);
    expect(m.size).toBe(1);
  });

  it('evicts only expired entries once the Map grows past the floor and 60s elapsed', () => {
    resetPruneTimer();
    const m = new Map<string, { count: number; resetAt: number }>();
    for (let i = 0; i < 300; i++) m.set('exp' + i, { count: 1, resetAt: 100 }); // all expired @ now=100_000
    m.set('live', { count: 1, resetAt: 200_000 });                              // still active
    pruneExpired(m, 100_000);
    expect(m.has('live')).toBe(true);
    expect(m.size).toBe(1); // the 300 expired entries are gone
  });

  it('skips prune when called within the 60s interval', () => {
    resetPruneTimer();
    const m = new Map<string, { count: number; resetAt: number }>();
    for (let i = 0; i < 300; i++) m.set('exp' + i, { count: 1, resetAt: 100 });
    pruneExpired(m, 100_000); // first prune runs
    expect(m.size).toBe(0);
    for (let i = 0; i < 300; i++) m.set('exp' + i, { count: 1, resetAt: 100 });
    pruneExpired(m, 100_001); // within 60s — skipped
    expect(m.size).toBe(300);
  });
});

describe('parseUsZip (home-location input)', () => {
  it('accepts a 5-digit ZIP (with optional spaces or +4) and returns the 5-digit core', () => {
    expect(parseUsZip('98074')).toBe('98074');
    expect(parseUsZip('  98074  ')).toBe('98074');
    expect(parseUsZip('98074-1234')).toBe('98074');
  });
  it('rejects town names, partial digits, and junk', () => {
    expect(parseUsZip('Sammamish, WA')).toBeNull();
    expect(parseUsZip('9807')).toBeNull();
    expect(parseUsZip('980745')).toBeNull();
    expect(parseUsZip('')).toBeNull();
  });
});

describe('isLikelyTextModel (auto-discovery name filter)', () => {
  it('keeps text/chat models', () => {
    expect(isLikelyTextModel('gemini-3.5-flash')).toBe(true);
    expect(isLikelyTextModel('gemini-2.0-flash-lite')).toBe(true);
    expect(isLikelyTextModel('gemini-2.5-pro')).toBe(true);
  });

  it('drops image/TTS/embedding/video families that can still advertise generateContent', () => {
    expect(isLikelyTextModel('imagen-3.0-generate')).toBe(false);
    expect(isLikelyTextModel('gemini-2.5-flash-tts')).toBe(false);
    expect(isLikelyTextModel('text-embedding-004')).toBe(false);
    expect(isLikelyTextModel('veo-2.0')).toBe(false);
    expect(isLikelyTextModel('gemini-2.0-flash-exp-image-generation')).toBe(false);
    expect(isLikelyTextModel('')).toBe(false);
  });
});

describe('parseGeminiJSON', () => {
  it('parses plain and markdown-fenced JSON', () => {
    expect(parseGeminiJSON('{"a":1}')).toEqual({ a: 1 });
    expect(parseGeminiJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseGeminiJSON('```\n[1,2]\n```')).toEqual([1, 2]);
  });

  it('recovers JSON wrapped in conversational prose (no fence) via brace-extraction', () => {
    expect(parseGeminiJSON('Sure! Here is the plan: {"a":1} — hope that helps!')).toEqual({ a: 1 });
    expect(parseGeminiJSON('Here you go:\n[1,2,3]')).toEqual([1, 2, 3]);
    expect(parseGeminiJSON('Reply: {"items":[1,2]}')).toEqual({ items: [1, 2] }); // object wins (appears first)
  });

  it('throws a malformed-tagged (recoverable) error on truncated/garbage JSON', () => {
    // Mirrors the real incident: a repetition loop blew the output-token ceiling and the JSON
    // was cut off mid-string ("Unterminated string in JSON"). This must be RECOVERABLE so
    // callGeminiJSON falls back to another model instead of hard-failing as "all models down".
    let caught: any;
    try { parseGeminiJSON('{"title":"zoo zoo zoo'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.malformedResponse).toBe(true);
    expect(isRecoverableError(caught)).toBe(true);
  });
});

describe('repairTruncatedJson (salvage a runaway/looped response — keep the good answer)', () => {
  it('recovers the complete reply + earlier suggestions when a LATER field loops and truncates', () => {
    // The real incident: reply (first, complete) is fine; the 2nd suggestion's `type` ran away mid-string
    // and blew the token cap. Repair closes the dangling string + structures so the answer survives.
    const raw = '{"reply":"Visit the Woodland Park Zoo (~39 min).","suggestions":[{"start":"2026-06-27","type":"place","ref":"P3"},{"start":"2026-06-28","type":"place_ref_id_loop_loop_loop_loop';
    const r = repairTruncatedJson(raw);
    expect(r.reply).toBe('Visit the Woodland Park Zoo (~39 min).');
    expect(r.suggestions[0]).toEqual({ start: '2026-06-27', type: 'place', ref: 'P3' }); // the complete one survives
    expect(r.suggestions).toHaveLength(2); // the looped one is salvaged-but-garbage (dropped later by validation)
  });
  it('drops a dangling comma when truncated between elements', () => {
    const r = repairTruncatedJson('{"reply":"ok","suggestions":[{"a":1},');
    expect(r).toEqual({ reply: 'ok', suggestions: [{ a: 1 }] });
  });
  it('falls back to extracting just the reply when the structure is unsalvageable', () => {
    // Truncated right after a colon (no value) → won't balance-parse, so at least the prose is preserved.
    const r = repairTruncatedJson('{"reply":"Here is a great plan for the weekend.","suggestions":[{"x":');
    expect(r).toEqual({ reply: 'Here is a great plan for the weekend.', suggestions: [], actions: [] });
  });
  it('salvages a truncated ARRAY response (event/PDF extraction callers use [])', () => {
    // Anchored on the leading '[' — keeps the complete first element when the second is cut off mid-string.
    const r = repairTruncatedJson('[{"title":"Camp","start":"2026-07-01"},{"title":"Trip","start":"2026-08-1');
    expect(Array.isArray(r)).toBe(true);
    expect(r[0]).toEqual({ title: 'Camp', start: '2026-07-01' });
    expect(r).toHaveLength(2); // second element salvaged-but-partial (its truncated value closed)
  });
  it('returns null when there is nothing parseable to salvage', () => {
    expect(repairTruncatedJson('not json at all')).toBeNull();
    expect(repairTruncatedJson('')).toBeNull();
  });
});

describe('isRecoverableError', () => {
  it('is true for transient errors and malformed responses, false for fatal ones', () => {
    expect(isRecoverableError({ status: 503 })).toBe(true);
    expect(isRecoverableError(Object.assign(new Error('bad json'), { malformedResponse: true }))).toBe(true);
    expect(isRecoverableError({ status: 400 })).toBe(false);
    expect(isRecoverableError(new Error('API key not valid'))).toBe(false);
    expect(isRecoverableError(null)).toBe(false);
  });
});
