import { describe, it, expect } from 'vitest';
import { clampDocText } from '../utils/docView';

describe('clampDocText (viewer hang fix)', () => {
  it('returns short text unchanged', () => {
    expect(clampDocText('Early release is Wednesday.')).toBe('Early release is Wednesday.');
  });

  it('caps long text and appends a "showing first N of M" note', () => {
    const long = 'x'.repeat(20000);
    const out = clampDocText(long, 6000);
    expect(out.length).toBeLessThan(6200);
    expect(out).toMatch(/showing the first 6,000 of 20,000 characters/);
  });

  it('strips control chars but keeps tab/newline/carriage-return', () => {
    const withCtrl = 'a\x01b\x07c\td\ne\rf'; // \x01 and \x07 are control chars to strip
    expect(clampDocText(withCtrl)).toBe('abc\td\ne\rf');
  });

  it('handles empty / nullish input', () => {
    expect(clampDocText('')).toBe('');
    expect(clampDocText(undefined as unknown as string)).toBe('');
  });
});
