// Shared, provider-agnostic email ingestion (capabilities B1 bills + B2 packages). Adapters
// (GmailAdapter now; Microsoft Graph for live.com/outlook.com later) produce a NormalizedMessage;
// the per-capability parsers (bills.ts, packages.ts) consume it. Privacy contract (owner-consented):
// tight search filter at the fetch site, parse in-memory, store ONLY parsed fields — never the body.
// Pure (no I/O) → unit-testable; the server does the fetch + the AI parse call.

import { sanitizeForPrompt } from './promptSafety';

// Provider-agnostic email message. Carries only what bill/package parsing needs.
export interface NormalizedMessage {
  from: string;
  subject: string;
  date?: string;     // raw header date if available
  snippet: string;   // extracted text (capped, whitespace-collapsed) — transient parse input, not stored
}

// Shared "--- Email N --- From/Subject/Body" block builder for the bill/package/kids parse prompts.
// Email is UNTRUSTED, so every field is run through sanitizeForPrompt (strip control chars / cap) —
// prompt-injection defense (a crafted email can't carry "ignore your instructions").
export function emailBlocks(messages: NormalizedMessage[]): string {
  return (Array.isArray(messages) ? messages : []).map((m, i) =>
    `--- Email ${i + 1} ---\nFrom: ${sanitizeForPrompt(m.from, 200)}\nSubject: ${sanitizeForPrompt(m.subject, 200)}\nBody: ${sanitizeForPrompt(m.snippet, 1500)}`,
  ).join('\n\n');
}

// Case-insensitive header lookup over Gmail's payload.headers array.
export function gmailHeader(headers: { name?: string; value?: string }[] | undefined, name: string): string {
  const h = (Array.isArray(headers) ? headers : []).find(x => (x.name || '').toLowerCase() === name.toLowerCase());
  return (h?.value || '').trim();
}

// base64url-decode a Gmail body part to UTF-8 (Node Buffer). Tolerant of missing/garbage data.
export function decodeGmailBody(data: string | undefined): string {
  if (!data) return '';
  try { return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return ''; }
}

// Walk a (possibly multipart) Gmail payload for the best text body; strip HTML tags; fall back to the
// API snippet. Capped + whitespace-collapsed. The result is parse input only — never persisted.
export function extractGmailText(message: any, cap = 4000): string {
  const parts: any[] = [];
  const walk = (p: any) => { if (!p) return; if (Array.isArray(p.parts)) p.parts.forEach(walk); else parts.push(p); };
  walk(message?.payload);
  const part = parts.find(p => p.mimeType === 'text/plain') || parts.find(p => p.mimeType === 'text/html');
  let text = decodeGmailBody(part?.body?.data) || String(message?.snippet || '');
  if (part?.mimeType === 'text/html') text = text.replace(/<[^>]+>/g, ' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, cap);
}

// GmailAdapter: normalize a fetched Gmail message into the provider-agnostic shape.
export function normalizeGmail(message: any): NormalizedMessage {
  const headers = message?.payload?.headers;
  return {
    from: gmailHeader(headers, 'From').slice(0, 200),
    subject: gmailHeader(headers, 'Subject').slice(0, 200),
    date: gmailHeader(headers, 'Date') || undefined,
    snippet: extractGmailText(message),
  };
}

// GraphAdapter (Outlook / live.com / hotmail via Microsoft Graph): normalize a Graph `message` resource
// (/me/messages) into the SAME NormalizedMessage the bill/package/newsletter parsers consume. HTML bodies
// are stripped to text; capped + whitespace-collapsed. Same privacy contract as Gmail — the snippet is
// transient parse input, never persisted. Pure → unit-tested.
export function normalizeGraph(message: any): NormalizedMessage {
  const addr = message?.from?.emailAddress || {};
  const from = (addr.name && addr.address ? `${addr.name} <${addr.address}>` : (addr.address || addr.name || '')).slice(0, 200);
  let text = '';
  const body = message?.body;
  if (body?.content) {
    text = String(body.content);
    if (String(body.contentType || '').toLowerCase() === 'html') text = text.replace(/<[^>]+>/g, ' ');
  } else {
    text = String(message?.bodyPreview || '');
  }
  return {
    from,
    subject: String(message?.subject || '').slice(0, 200),
    date: message?.receivedDateTime || undefined,
    snippet: text.replace(/\s+/g, ' ').trim().slice(0, 4000),
  };
}
