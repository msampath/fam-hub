import { describe, it, expect, afterEach, vi } from 'vitest';
import { shouldRunDigestNow, localDateHour } from '../utils/digest';
import { sendDigestEmail, makeMailer, consoleMailer } from '../utils/mailer';

describe('shouldRunDigestNow', () => {
  it('fires once at/after the send hour, and not again the same day', () => {
    expect(shouldRunDigestNow(7, 7, null, '2026-06-24')).toBe(true);
    expect(shouldRunDigestNow(9, 7, null, '2026-06-24')).toBe(true);
    expect(shouldRunDigestNow(6, 7, null, '2026-06-24')).toBe(false); // before the hour
    expect(shouldRunDigestNow(9, 7, '2026-06-24', '2026-06-24')).toBe(false); // already ran today
  });
});

describe('localDateHour (household timezone)', () => {
  // 2026-06-24 08:30 UTC — different civil hour/date depending on the zone.
  const utcInstant = new Date(Date.UTC(2026, 5, 24, 8, 30, 0));

  it('resolves the household-local date + hour from an IANA timezone', () => {
    // LA is UTC-7 in June → 01:30 same day.
    expect(localDateHour(utcInstant, 'America/Los_Angeles')).toEqual({ date: '2026-06-24', hour: 1 });
    // Kolkata is UTC+5:30 → 14:00 same day.
    expect(localDateHour(utcInstant, 'Asia/Kolkata')).toEqual({ date: '2026-06-24', hour: 14 });
  });

  it('rolls the date across the UTC-day boundary for the household zone', () => {
    // 2026-06-24 02:00 UTC is still 2026-06-23 19:00 in LA — the exact Cloud-Run evening-rollover bug.
    const lateUtc = new Date(Date.UTC(2026, 5, 24, 2, 0, 0));
    expect(localDateHour(lateUtc, 'America/Los_Angeles')).toEqual({ date: '2026-06-23', hour: 19 });
  });

  it('falls back to server-local when the timezone is missing or invalid', () => {
    const d = new Date(2026, 5, 24, 9, 0, 0); // local
    expect(localDateHour(d, undefined)).toEqual({ date: '2026-06-24', hour: 9 });
    expect(localDateHour(d, 'Not/AZone')).toEqual({ date: '2026-06-24', hour: 9 });
  });
});

describe('sendDigestEmail', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('is a no-op (skipped) when RESEND_API_KEY is unset', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const r = await sendDigestEmail('a@b.com', 's', 'body', (async () => ({ ok: true } as Response)) as any);
    expect(r).toEqual({ ok: false, skipped: true });
  });

  it('rejects an invalid recipient when configured', async () => {
    vi.stubEnv('RESEND_API_KEY', 'k');
    const r = await sendDigestEmail('not-an-email', 's', 'body', (async () => ({ ok: true } as Response)) as any);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/recipient/);
  });

  it('POSTs to Resend with auth when configured', async () => {
    vi.stubEnv('RESEND_API_KEY', 'k');
    const fetchMock = vi.fn(async () => ({ ok: true } as Response));
    const r = await sendDigestEmail('a@b.com', 'Subject', 'Body', fetchMock as any);
    expect(r).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as any).Authorization).toBe('Bearer k');
    expect(JSON.parse(init.body).to).toBe('a@b.com');
  });
});

describe('mailer port (Phase-6 adapters)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('MAILER=console prints instead of sending and reports ok', async () => {
    const lines: string[] = [];
    const m = consoleMailer(s => lines.push(s));
    const r = await m.send('a@b.com', 'Subj', 'Body');
    expect(r).toEqual({ ok: true });
    expect(lines[0]).toContain('to=a@b.com');
    expect(lines[0]).toContain('Subj');
  });

  it('makeMailer selects by MAILER env, defaulting to resend-with-key else skip-off', () => {
    expect(makeMailer({ MAILER: 'console' }).name).toBe('console');
    expect(makeMailer({ MAILER: 'off', RESEND_API_KEY: 'k' }).name).toBe('off');
    expect(makeMailer({ RESEND_API_KEY: 'k' }).name).toBe('resend');
    expect(makeMailer({}).name).toBe('off'); // keyless default NEVER silently "sends" anywhere
  });
});
