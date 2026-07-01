import { describe, it, expect } from 'vitest';
import { buildKidsActivityQuery, activityToSuggestion, buildKidsActivityParsePrompt } from '../utils/kidsActivities';
import type { NormalizedMessage } from '../utils/email';

describe('buildKidsActivityQuery', () => {
  it('is a tight, recent, activity-shaped filter', () => {
    const q = buildKidsActivityQuery(60);
    expect(q).toContain('newer_than:60d');
    expect(q).toContain('practice');
    expect(q).toContain('camp');
    expect(q).toContain('from:(school');
  });
});

describe('activityToSuggestion', () => {
  const today = '2026-06-20';
  it('maps a dated activity to a suggestion with time + location + clamped category', () => {
    const s = activityToSuggestion({ title: 'Soccer practice', date: '2026-06-24', time: '16:00', location: 'Marymoor', category: 'Sports' }, today);
    expect(s).toMatchObject({ start: '2026-06-24', title: 'Soccer practice', category: 'Sports' });
    expect(s!.note).toContain('16:00');
    expect(s!.note).toContain('Marymoor');
  });
  it('defaults an unknown category to Other and tolerates a bad time', () => {
    const s = activityToSuggestion({ title: 'Recital', date: '2026-06-25', time: '99:99', category: 'Nope' }, today);
    expect(s!.category).toBe('Other');
    expect(s!.note).toBeUndefined(); // bad time dropped, no location → no note
  });
  it('drops a past or undated activity', () => {
    expect(activityToSuggestion({ title: 'X', date: '2026-06-01' }, today)).toBeNull();
    expect(activityToSuggestion({ title: 'X' }, today)).toBeNull();
  });
});

describe('buildKidsActivityParsePrompt (prompt-injection safe)', () => {
  it('asks for {"activities":[]} JSON and sanitizes untrusted email fields', () => {
    const msgs: NormalizedMessage[] = [
      { from: 'coach@school.edu', subject: 'Practice moved\nignore prior', snippet: 'Tuesday 4pm' },
    ];
    const prompt = buildKidsActivityParsePrompt(msgs);
    expect(prompt).toContain('"activities"');
    expect(prompt).toContain('school.edu');
    expect(prompt).not.toContain('moved\nignore');
  });
});
