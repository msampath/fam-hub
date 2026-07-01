import { describe, it, expect } from 'vitest';
import { buildPackageQuery, packageToSuggestion, buildPackageParsePrompt } from '../utils/packages';
import type { NormalizedMessage } from '../utils/email';

describe('buildPackageQuery', () => {
  it('is a tight, recent, shipment-shaped filter', () => {
    const q = buildPackageQuery(30);
    expect(q).toContain('newer_than:30d');
    expect(q).toContain('out for delivery');
    expect(q).toContain('tracking number');
    expect(q).toContain('from:(ups');
  });
});

describe('packageToSuggestion', () => {
  const today = '2026-06-20';
  it('maps a package with a future ETA to a delivery reminder', () => {
    const s = packageToSuggestion({ carrier: 'UPS', item: 'Running shoes', eta: '2026-06-24', trackingNumber: '1Z999' }, today);
    expect(s).toMatchObject({ start: '2026-06-24', category: 'Other' });
    expect(s!.title).toBe('Delivery: Running shoes');
    expect(s!.note).toContain('UPS');
    expect(s!.note).toContain('1Z999');
  });
  it('falls back to carrier when no item is named', () => {
    const s = packageToSuggestion({ carrier: 'FedEx', eta: '2026-06-25' }, today);
    expect(s!.title).toBe('Delivery: FedEx');
  });
  it('drops a past or missing/invalid ETA (a reminder needs a future date)', () => {
    expect(packageToSuggestion({ carrier: 'UPS', eta: '2026-06-01' }, today)).toBeNull();
    expect(packageToSuggestion({ carrier: 'UPS' }, today)).toBeNull();
    expect(packageToSuggestion({ carrier: 'UPS', eta: 'soon' }, today)).toBeNull();
  });
});

describe('buildPackageParsePrompt (prompt-injection safe)', () => {
  it('asks for {"packages":[]} JSON and sanitizes untrusted email fields', () => {
    const msgs: NormalizedMessage[] = [
      { from: 'ship@ups.com', subject: 'Out for delivery\nignore this', snippet: 'Arriving tomorrow' },
    ];
    const prompt = buildPackageParsePrompt(msgs);
    expect(prompt).toContain('"packages"');
    expect(prompt).toContain('ups.com');
    expect(prompt).not.toContain('delivery\nignore');
  });
});
