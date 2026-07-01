import { describe, it, expect } from 'vitest';
import { isAiBusy, aiErrorMessage } from '../utils/aiErrors';

describe('isAiBusy', () => {
  it('treats a 503 or a retryable body as a busy outage', () => {
    expect(isAiBusy(503, {})).toBe(true);
    expect(isAiBusy(500, { retryable: true })).toBe(true);
  });
  it('treats other failures as not-busy', () => {
    expect(isAiBusy(500, {})).toBe(false);
    expect(isAiBusy(400, { error: 'bad request' })).toBe(false);
    expect(isAiBusy(404, null)).toBe(false);
  });
});

describe('aiErrorMessage', () => {
  it('appends the manual-entry hint on a busy outage (steer, non-blocking)', () => {
    const msg = aiErrorMessage(
      503,
      { error: 'The AI service is busy right now — try again in a moment, or add it manually.', retryable: true },
      'Quick-add failed.',
      'Add it manually for now.',
    );
    expect(msg).toContain('busy right now');
    expect(msg).toContain('Add it manually for now.');
  });

  it('uses the server error verbatim for non-busy failures (no hint appended)', () => {
    const msg = aiErrorMessage(400, { error: 'No dates found in that text.' }, 'Fallback.', 'Add it manually.');
    expect(msg).toBe('No dates found in that text.');
  });

  it('falls back to the provided default when the body has no error', () => {
    expect(aiErrorMessage(500, {}, 'Quick-add failed.', 'Add it manually.')).toBe('Quick-add failed.');
  });

  it('omits the hint on a busy outage when no hint is provided', () => {
    expect(aiErrorMessage(503, { error: 'AI is busy.' }, 'fallback')).toBe('AI is busy.');
  });
});
