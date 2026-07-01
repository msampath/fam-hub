import { describe, it, expect } from 'vitest';
import { gmailHeader, decodeGmailBody, extractGmailText, normalizeGmail, normalizeGraph } from '../utils/email';

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

describe('gmailHeader / decodeGmailBody', () => {
  it('finds a header case-insensitively', () => {
    const headers = [{ name: 'From', value: 'a@b.c' }, { name: 'Subject', value: 'Your bill' }];
    expect(gmailHeader(headers, 'from')).toBe('a@b.c');
    expect(gmailHeader(headers, 'SUBJECT')).toBe('Your bill');
    expect(gmailHeader(undefined, 'From')).toBe('');
  });
  it('base64url-decodes a body, and is safe on junk', () => {
    expect(decodeGmailBody(b64url('Amount due: $42'))).toBe('Amount due: $42');
    expect(decodeGmailBody(undefined)).toBe('');
  });
});

describe('extractGmailText', () => {
  it('prefers text/plain from a multipart payload', () => {
    const msg = { payload: { parts: [
      { mimeType: 'text/plain', body: { data: b64url('Pay $84.20 by 2026-07-01') } },
      { mimeType: 'text/html', body: { data: b64url('<p>ignored</p>') } },
    ] } };
    expect(extractGmailText(msg)).toBe('Pay $84.20 by 2026-07-01');
  });
  it('strips HTML when only text/html is present', () => {
    const msg = { payload: { mimeType: 'text/html', body: { data: b64url('<div>Bill <b>$10</b></div>') } } };
    expect(extractGmailText(msg)).toBe('Bill $10');
  });
  it('falls back to the snippet when no body part decodes', () => {
    expect(extractGmailText({ snippet: 'short preview' })).toBe('short preview');
  });
});

describe('normalizeGmail', () => {
  it('produces the provider-agnostic shape', () => {
    const msg = {
      snippet: 'Your statement is ready',
      payload: { headers: [{ name: 'From', value: 'billing@acme.com' }, { name: 'Subject', value: 'Acme statement' }, { name: 'Date', value: 'Tue, 17 Jun 2026' }] },
    };
    const n = normalizeGmail(msg);
    expect(n).toMatchObject({ from: 'billing@acme.com', subject: 'Acme statement', date: 'Tue, 17 Jun 2026' });
    expect(n.snippet).toContain('statement');
  });
});

describe('normalizeGraph (Outlook/Live adapter)', () => {
  it('maps a Graph message into the provider-agnostic shape, stripping HTML', () => {
    const msg = {
      from: { emailAddress: { name: 'Acme Billing', address: 'billing@acme.com' } },
      subject: 'Acme statement',
      receivedDateTime: '2026-06-17T09:00:00Z',
      body: { contentType: 'html', content: '<p>Your <b>statement</b> is ready</p>' },
    };
    const n = normalizeGraph(msg);
    expect(n).toMatchObject({ from: 'Acme Billing <billing@acme.com>', subject: 'Acme statement', date: '2026-06-17T09:00:00Z' });
    expect(n.snippet).toBe('Your statement is ready'); // tags stripped + whitespace-collapsed
  });

  it('falls back to bodyPreview when there is no body, and tolerates a missing sender', () => {
    const n = normalizeGraph({ subject: 'Hi', bodyPreview: 'short preview' });
    expect(n.snippet).toBe('short preview');
    expect(n.from).toBe('');
  });
});
