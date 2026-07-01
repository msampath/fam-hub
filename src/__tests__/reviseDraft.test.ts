import { describe, it, expect } from 'vitest';
import { buildRevisePrompt, shapeRevisedDraft } from '../utils/reviseDraft';

describe('buildRevisePrompt', () => {
  it('includes the draft summary, the feedback, and the no-pay/same-kind guardrails', () => {
    const p = buildRevisePrompt('reserve', { summary: "Araya's Place", link: 'https://maps.google.com/x' }, 'somewhere cheaper');
    expect(p).toMatch(/Araya's Place/);
    expect(p).toMatch(/somewhere cheaper/);
    expect(p).toMatch(/SAME kind/);
    expect(p).toMatch(/NEVER book, buy, or pay/);
    expect(p).toMatch(/https:\/\/maps\.google\.com\/x/);
  });
});

describe('shapeRevisedDraft', () => {
  it('merges whitelisted event fields into changes for update_event', () => {
    const r = shapeRevisedDraft('update_event', { summary: 'Move to Tue 3pm', changes: { start: '2026-07-07', startTime: '15:00', id: 'hack', members: ['x'] } }, { summary: 'old' });
    expect(r.summary).toBe('Move to Tue 3pm');
    expect(r.changes).toEqual({ start: '2026-07-07', startTime: '15:00' }); // id + members dropped (not whitelisted)
  });

  it('ignores changes for non-event drafts and keeps a refreshed http(s) link', () => {
    const r = shapeRevisedDraft('reserve', { summary: 'A cheaper spot', changes: { start: '2026-07-07' }, link: 'https://maps.google.com/y' }, { summary: 'old' });
    expect(r.changes).toBeUndefined();
    expect(r.link).toBe('https://maps.google.com/y');
  });

  it('drops a non-http link (no javascript:/data: into a draft)', () => {
    const r = shapeRevisedDraft('reserve', { summary: 'x', link: 'javascript:alert(1)' }, { summary: 'old' });
    expect(r.link).toBeUndefined();
  });

  it('falls back to the original summary when the model returns nothing usable', () => {
    const r = shapeRevisedDraft('add_to_cart', { summary: '   ' }, { summary: 'AA batteries ×2' });
    expect(r.summary).toBe('AA batteries ×2');
  });

  it('captures a refreshed item text for a cart draft', () => {
    const r = shapeRevisedDraft('add_to_cart', { summary: 'Rechargeable AAs', text: 'Rechargeable AA batteries ×4' }, { summary: 'old' });
    expect(r.text).toBe('Rechargeable AA batteries ×4');
  });

  it('accepts a validated freeBusy on an update_event and drops a garbage value', () => {
    expect(shapeRevisedDraft('update_event', { summary: 'free it', changes: { freeBusy: 'FREE' } }, { summary: 'old' }).changes).toEqual({ freeBusy: 'free' });
    expect(shapeRevisedDraft('update_event', { summary: 'x', changes: { freeBusy: 'maybe' } }, { summary: 'old' }).changes).toBeUndefined();
  });

  it('extracts ONLY freeBusy from a delete_event revision (the keep-and-mark-free conversion)', () => {
    // "make it free" on a delete draft → the one field that converts it to a kept, free/busy event.
    const r = shapeRevisedDraft('delete_event', { summary: 'Keep it, mark free', changes: { freeBusy: 'free', start: '2026-07-04', title: 'hack' } }, { summary: 'Delete "Independence Day"' });
    expect(r.changes).toEqual({ freeBusy: 'free' }); // start/title NOT applied to a delete draft
  });

  it('buildRevisePrompt tells a delete draft how to convert to keep-and-mark-free', () => {
    const p = buildRevisePrompt('delete_event', { summary: 'Delete "Independence Day"' }, 'make it free');
    expect(p).toMatch(/freeBusy/);
    expect(p).toMatch(/KEEP it/i);
  });
});
