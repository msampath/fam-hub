import { describe, it, expect } from 'vitest';
import { buildHandoffDraft } from '../utils/handoff';

describe('buildHandoffDraft (A3 — loop-closing handoff)', () => {
  it('builds a draft with the real URL + the fields-to-enter summarized (honest: not "pre-filled")', () => {
    const d = buildHandoffDraft({
      title: 'Mount Rainier timed-entry pass',
      url: 'https://www.recreation.gov/timed-entry/10086910',
      fields: [{ label: 'Date', value: '2026-07-11' }, { label: 'Party size', value: '4' }],
    })!;
    expect(d.link).toBe('https://www.recreation.gov/timed-entry/10086910');
    expect(d.summary).toMatch(/^Mount Rainier timed-entry pass — details to enter:/);
    expect(d.summary).not.toMatch(/pre-filled|Review & submit/); // honest framing — the link can't inject values
    expect(d.summary).toMatch(/Date: 2026-07-11/);
    expect(d.fields).toHaveLength(2);
  });

  it('returns null without a real http(s) URL (no handoff to a made-up link)', () => {
    expect(buildHandoffDraft({ title: 'x', url: 'not-a-url' })).toBeNull();
    expect(buildHandoffDraft({ title: 'x', url: 'javascript:alert(1)' })).toBeNull();
    expect(buildHandoffDraft({ title: '', url: 'https://example.com' })).toBeNull();
  });

  it('drops empty fields and caps the count', () => {
    const d = buildHandoffDraft({
      title: 'Soccer registration', url: 'https://example.org/signup',
      fields: [{ label: '', value: 'x' }, { label: 'Name', value: '' }, { label: 'Age', value: '8' }],
    })!;
    expect(d.fields).toEqual([{ label: 'Age', value: '8' }]);
  });
});
