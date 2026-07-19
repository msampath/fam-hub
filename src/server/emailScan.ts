import { Router } from 'express';
import type { Request } from 'express';
import { Type } from '@google/genai';
import { normalizeGmail, normalizeGraph, type NormalizedMessage } from '../utils/email';
import { buildBillQuery, billToSuggestion, buildBillParsePrompt, type ParsedBill } from '../utils/bills';
import { buildNewsletterQuery, buildNewsletterClassifyPrompt } from '../utils/newsletters';
import { buildPackageQuery, packageToSuggestion, buildPackageParsePrompt, type ParsedPackage } from '../utils/packages';
import { buildKidsActivityQuery, activityToSuggestion, buildKidsActivityParsePrompt, type ParsedActivity } from '../utils/kidsActivities';
import { callGeminiJSON } from './gemini';
import { fetchWithTimeout, mapWithConcurrency } from './fetchUtils';
import { requireAuth, aiRateLimit } from './middleware';

async function gmailScan(accessToken: string, query: string, maxResults = 30):
  Promise<{ messages: NormalizedMessage[]; status?: number; error?: string }> {
  const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
  const q = encodeURIComponent(query);
  const listR = await fetchWithTimeout(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${maxResults}`, 8000, auth);
  if (!listR.ok) {
    if (listR.status === 401 || listR.status === 403) return { messages: [], status: 403, error: 'Gmail access not granted — sign out and back in to allow email reading.' };
    return { messages: [], status: 502, error: 'Could not read email right now.' };
  }
  const listData: any = await listR.json();
  const ids: string[] = (Array.isArray(listData?.messages) ? listData.messages : []).slice(0, maxResults).map((m: any) => m?.id).filter(Boolean);
  // Hydrate up to 6 messages concurrently (was strictly serial — ~30 sequential round-trips blocked
  // every interactive scan for several seconds before the AI parse even started). null marks a skipped
  // message (same try/catch-skip semantics as before), filtered out below; order is preserved.
  const hydrated = await mapWithConcurrency(ids, 6, async (id): Promise<NormalizedMessage | null> => {
    try {
      const r = await fetchWithTimeout(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, 8000, auth);
      return r.ok ? normalizeGmail(await r.json()) : null;
    } catch (e: any) {
      console.warn('gmailScan: skipped a message:', e?.message || e);
      return null;
    }
  });
  const messages: NormalizedMessage[] = hydrated.filter((m): m is NormalizedMessage => m !== null);
  return { messages };
}

async function graphScan(accessToken: string, maxResults = 30):
  Promise<{ messages: NormalizedMessage[]; status?: number; error?: string }> {
  const url = `https://graph.microsoft.com/v1.0/me/messages?$top=${maxResults}`
    + `&$select=from,subject,receivedDateTime,bodyPreview,body&$orderby=receivedDateTime desc`;
  const r = await fetchWithTimeout(url, 8000, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) return { messages: [], status: 403, error: 'Outlook access not granted — reconnect your Microsoft account.' };
    return { messages: [], status: 502, error: 'Could not read email right now.' };
  }
  const data: any = await r.json();
  const messages = (Array.isArray(data?.value) ? data.value : []).slice(0, maxResults).map(normalizeGraph);
  return { messages };
}

async function fetchInbox(req: Request, query: string, maxResults = 30):
  Promise<{ messages: NormalizedMessage[]; status?: number; error?: string }> {
  const graphToken = String(req.headers['x-graph-token'] || '');
  if (graphToken) return graphScan(graphToken, maxResults);
  const googleToken = String(req.headers['x-google-token'] || '');
  if (googleToken) return gmailScan(googleToken, query, maxResults);
  return { messages: [], status: 400, error: 'Connect your Google or Microsoft account to scan email.' };
}

function dedupeSuggestions<T extends { start: string; title: string }>(list: (T | null)[], cap = 20): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of list) {
    if (!s) continue;
    const k = `${s.start}|${s.title.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

const BILL_SYSTEM = 'You extract bills / payment-due items from emails into strict JSON. Never invent amounts or dates; omit any field you cannot read.';
const BILL_SCHEMA = {
  type: Type.OBJECT,
  properties: { bills: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
    payee: { type: Type.STRING }, amount: { type: Type.STRING }, dueDate: { type: Type.STRING }, account: { type: Type.STRING },
    confidence: { type: Type.NUMBER, description: 'Your 0-1 confidence this is a REAL bill with correctly-read fields. Use below 0.5 when unsure — such rows are discarded.' },
  }, required: ['payee'] } } },
  required: ['bills'],
};

const EMAIL_SCAN_DISABLED = process.env.EMAIL_SCAN_DISABLED === 'true';
const SCAN_GENCONFIG = { maxOutputTokens: 1024 };
const SCAN_LOCAL_OPTS = { local: { maxOutputTokens: 4096, think: 'low' as const } };
const confidentRows = <T,>(rows: T[]): T[] =>
  rows.filter(r => typeof (r as { confidence?: unknown })?.confidence !== 'number' || (r as { confidence: number }).confidence >= 0.5);

export const emailScanRouter = Router();

emailScanRouter.post('/scan-bills', requireAuth, aiRateLimit, async (req, res) => {
  if (EMAIL_SCAN_DISABLED) return res.json({ suggestions: [], bills: [], scanned: 0 });
  try {
    const today = new Date().toLocaleDateString('en-CA');
    const scan = await fetchInbox(req, buildBillQuery());
    if (scan.error) return res.status(scan.status || 502).json({ error: scan.error });
    if (!scan.messages.length) return res.json({ suggestions: [], scanned: 0 });
    let parsed: any;
    try { parsed = await callGeminiJSON(buildBillParsePrompt(scan.messages), BILL_SYSTEM, BILL_SCHEMA, '{"bills":[]}', undefined, SCAN_GENCONFIG, SCAN_LOCAL_OPTS); }
    catch (e: any) {
      console.warn('scan-bills parse failed:', e?.message || e);
      return res.status(503).json({ error: 'The AI is busy — try the scan again in a moment.', retryable: true });
    }
    const bills: ParsedBill[] = confidentRows(Array.isArray(parsed?.bills) ? parsed.bills : []);
    const suggestions = dedupeSuggestions(bills.map(b => billToSuggestion(b, today)));
    return res.json({ suggestions, bills, scanned: scan.messages.length });
  } catch (err: any) {
    console.error('scan-bills error:', err?.message || err);
    return res.status(500).json({ error: 'Bill scan failed.' });
  }
});

const NEWSLETTER_SYSTEM = 'You filter bulk/newsletter emails for a family knowledge library, keeping only genuinely useful LOCAL/community content. Output strict JSON; never invent details.';
const NEWSLETTER_CLASSIFY_SCHEMA = {
  type: Type.OBJECT,
  properties: { items: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
    index: { type: Type.NUMBER }, keep: { type: Type.BOOLEAN }, title: { type: Type.STRING }, summary: { type: Type.STRING },
  }, required: ['index', 'keep'] } } },
  required: ['items'],
};

emailScanRouter.post('/scan-newsletters', requireAuth, aiRateLimit, async (req, res) => {
  if (EMAIL_SCAN_DISABLED) return res.json({ newsletters: [], scanned: 0 });
  try {
    const scan = await fetchInbox(req, buildNewsletterQuery(), 30);
    if (scan.error) return res.status(scan.status || 502).json({ error: scan.error });
    if (!scan.messages.length) return res.json({ newsletters: [], scanned: 0 });
    const byIndex = new Map<number, { keep?: boolean; title?: string; summary?: string }>();
    let ran = false;
    try {
      const parsed = await callGeminiJSON(buildNewsletterClassifyPrompt(scan.messages), NEWSLETTER_SYSTEM, NEWSLETTER_CLASSIFY_SCHEMA, '{"items":[]}', undefined, SCAN_GENCONFIG, SCAN_LOCAL_OPTS);
      ran = true;
      for (const v of (Array.isArray(parsed?.items) ? parsed.items : [])) {
        if (typeof v?.index === 'number') byIndex.set(v.index, v);
      }
    } catch (e: any) {
      console.warn('scan-newsletters classify failed — keeping raw scan:', e?.message || e);
    }
    const newsletters = scan.messages
      .map((m, i) => ({ m, v: byIndex.get(i + 1) }))
      .filter(({ v }) => (ran ? v?.keep === true : true))
      .map(({ m, v }) => ({ ...m, subject: v?.title?.trim() || m.subject, snippet: v?.summary?.trim() || m.snippet }));
    return res.json({ newsletters, scanned: scan.messages.length });
  } catch (err: any) {
    console.error('scan-newsletters error:', err?.message || err);
    return res.status(500).json({ error: 'Newsletter scan failed.' });
  }
});

const PACKAGE_SYSTEM = 'You extract incoming package / delivery info from emails into strict JSON. Never invent dates; omit any field you cannot read.';
const PACKAGE_SCHEMA = {
  type: Type.OBJECT,
  properties: { packages: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
    carrier: { type: Type.STRING }, item: { type: Type.STRING }, eta: { type: Type.STRING }, trackingNumber: { type: Type.STRING },
    confidence: { type: Type.NUMBER, description: 'Your 0-1 confidence this is a REAL incoming delivery with correctly-read fields. Use below 0.5 when unsure — such rows are discarded.' },
  } } } },
  required: ['packages'],
};

emailScanRouter.post('/scan-packages', requireAuth, aiRateLimit, async (req, res) => {
  if (EMAIL_SCAN_DISABLED) return res.json({ suggestions: [], scanned: 0 });
  try {
    const today = new Date().toLocaleDateString('en-CA');
    const scan = await fetchInbox(req, buildPackageQuery());
    if (scan.error) return res.status(scan.status || 502).json({ error: scan.error });
    if (!scan.messages.length) return res.json({ suggestions: [], scanned: 0 });
    let parsed: any;
    try { parsed = await callGeminiJSON(buildPackageParsePrompt(scan.messages), PACKAGE_SYSTEM, PACKAGE_SCHEMA, '{"packages":[]}', undefined, SCAN_GENCONFIG, SCAN_LOCAL_OPTS); }
    catch (e: any) {
      console.warn('scan-packages parse failed:', e?.message || e);
      return res.status(503).json({ error: 'The AI is busy — try the scan again in a moment.', retryable: true });
    }
    const pkgs: ParsedPackage[] = confidentRows(Array.isArray(parsed?.packages) ? parsed.packages : []);
    const suggestions = dedupeSuggestions(pkgs.map(p => packageToSuggestion(p, today)));
    return res.json({ suggestions, scanned: scan.messages.length });
  } catch (err: any) {
    console.error('scan-packages error:', err?.message || err);
    return res.status(500).json({ error: 'Package scan failed.' });
  }
});

const KIDS_SYSTEM = "You extract kids' scheduled activities/events from emails into strict JSON. Never invent dates; omit any field you cannot read.";
const KIDS_SCHEMA = {
  type: Type.OBJECT,
  properties: { activities: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
    title: { type: Type.STRING }, date: { type: Type.STRING }, time: { type: Type.STRING }, location: { type: Type.STRING }, category: { type: Type.STRING },
    confidence: { type: Type.NUMBER, description: 'Your 0-1 confidence this is a REAL scheduled kids activity with correctly-read fields. Use below 0.5 when unsure — such rows are discarded.' },
  }, required: ['title'] } } },
  required: ['activities'],
};

emailScanRouter.post('/scan-kids', requireAuth, aiRateLimit, async (req, res) => {
  if (EMAIL_SCAN_DISABLED) return res.json({ suggestions: [], scanned: 0 });
  try {
    const today = new Date().toLocaleDateString('en-CA');
    const scan = await fetchInbox(req, buildKidsActivityQuery());
    if (scan.error) return res.status(scan.status || 502).json({ error: scan.error });
    if (!scan.messages.length) return res.json({ suggestions: [], scanned: 0 });
    let parsed: any;
    try { parsed = await callGeminiJSON(buildKidsActivityParsePrompt(scan.messages), KIDS_SYSTEM, KIDS_SCHEMA, '{"activities":[]}', undefined, SCAN_GENCONFIG, SCAN_LOCAL_OPTS); }
    catch (e: any) {
      console.warn('scan-kids parse failed:', e?.message || e);
      return res.status(503).json({ error: 'The AI is busy — try the scan again in a moment.', retryable: true });
    }
    const acts: ParsedActivity[] = confidentRows(Array.isArray(parsed?.activities) ? parsed.activities : []);
    const suggestions = dedupeSuggestions(acts.map(a => activityToSuggestion(a, today)));
    return res.json({ suggestions, scanned: scan.messages.length });
  } catch (err: any) {
    console.error('scan-kids error:', err?.message || err);
    return res.status(500).json({ error: "Kids' activity scan failed." });
  }
});
