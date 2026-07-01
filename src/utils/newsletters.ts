// Newsletter ingestion → the Docs Library corpus (the copilot/agent's editorial grounding). Unlike bills
// (parsed fields only), newsletters are bulk/marketing content the household OPTED to ingest, so we keep
// the text as the RAG corpus. The autonomous auto-scan calls these — no manual import. Pure → unit-tested.
import type { LibraryDoc } from '../types';
import { type NormalizedMessage, emailBlocks } from './email';

export const NEWSLETTER_FOLDER = 'Newsletters';

// CLASSIFICATION (fixes "15 random emails dumped into Docs"): before ingesting, an AI pass decides which
// scanned emails are genuinely useful LOCAL/community content vs. generic marketing, and gives a clean
// title + summary for the keepers. Pure prompt builder; the server runs the Gemini call + applies the verdicts.
export function buildNewsletterClassifyPrompt(messages: NormalizedMessage[]): string {
  return `You are filtering bulk/newsletter emails for a FAMILY's knowledge library. For EACH "Email N" block
below, decide "keep": true ONLY if it carries genuinely useful LOCAL information for a family — upcoming local
events, community/neighborhood activities, kids' programs, classes, festivals, library/parks events, or local
news. Set "keep": false for generic marketing/sales/discount promos, shipping or order/transactional mail,
political fundraising, account notices, or anything with no local-activity value. For kept emails, give a
short clean "title" and a 1–2 sentence "summary" of the useful specifics (what, when, where). Return JSON
{"items":[{"index":number,"keep":boolean,"title":string,"summary":string}, ...]} with ONE entry per email,
where "index" is that email's number N (1-based) so it can be matched back exactly — never reorder or merge.

${emailBlocks(messages)}`;
}

// Tight Gmail filter: bulk/list/promotional mail with an unsubscribe link in a recent window — so it
// surfaces newsletters (EverOut, ParentMap, city updates) without vacuuming personal correspondence.
export function buildNewsletterQuery(days = 14): string {
  return `newer_than:${days}d (category:promotions OR category:updates OR list:(*)) unsubscribe`;
}

// One newsletter email → a Library document. `stamp` supplies id + author/createdAt (injected, keeps pure).
export function newsletterToDoc(m: NormalizedMessage, stamp: () => { id: string } & Partial<LibraryDoc>): LibraryDoc | null {
  const name = (m?.subject || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) return null;
  const from = (m?.from || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const body = (m?.snippet || '').slice(0, 4000);
  return { folder: NEWSLETTER_FOLDER, name, text: `From: ${from}\n${body}`.trim(), ...stamp() } as LibraryDoc;
}

// Merge scanned newsletters into the documents collection: dedup by subject within the Newsletters folder
// (re-scans don't pile up), leave the user's own docs untouched, and cap the newsletter subset (newest kept).
export function mergeNewsletterDocs(
  existing: LibraryDoc[],
  incoming: NormalizedMessage[],
  stamp: () => { id: string } & Partial<LibraryDoc>,
  cap = 50,
): LibraryDoc[] {
  const isNews = (d: LibraryDoc) => d.folder === NEWSLETTER_FOLDER;
  const seen = new Set(existing.filter(isNews).map(d => d.name.toLowerCase()));
  const fresh: LibraryDoc[] = [];
  for (const m of Array.isArray(incoming) ? incoming : []) {
    const doc = newsletterToDoc(m, stamp);
    if (!doc || seen.has(doc.name.toLowerCase())) continue;
    seen.add(doc.name.toLowerCase());
    fresh.push(doc);
  }
  if (!fresh.length) return existing;
  const others = existing.filter(d => !isNews(d));
  const news = [...existing.filter(isNews), ...fresh].slice(-cap);
  return [...others, ...news];
}
