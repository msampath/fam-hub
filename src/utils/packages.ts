// Packages / deliveries ingestion (capability B2). Provider-agnostic: consumes a NormalizedMessage
// from the shared email adapter (src/utils/email.ts). Same privacy contract as bills: tight filter,
// parse in-memory, store ONLY parsed fields — never the email body. Pure → unit-testable.
import type { CopilotSuggestion } from '../types';
import { type NormalizedMessage, emailBlocks } from './email';

// A parsed shipment — the ONLY thing kept (never the email body).
export interface ParsedPackage {
  carrier?: string;        // UPS / FedEx / USPS / Amazon …
  item?: string;           // what's arriving, if stated
  eta?: string;            // YYYY-MM-DD expected delivery
  trackingNumber?: string; // shown only in the reminder note; not used as a key
  confidence?: number;     // model's 0-1 self-report; the server drops rows < 0.5 (weak-model gate)
}

// Tight Gmail search filter: shipment/carrier mail in a recent window only.
export function buildPackageQuery(days = 30): string {
  return `newer_than:${days}d (subject:("out for delivery" OR shipped OR "on its way" OR "arriving" OR "your order" OR "tracking number" OR "has shipped") OR from:(ups OR fedex OR usps OR dhl OR shipment OR "auto-confirm" OR tracking))`;
}

// Build the package-extraction prompt. Email fields are sanitized via the shared emailBlocks() helper.
export function buildPackageParsePrompt(messages: NormalizedMessage[]): string {
  return `You are extracting INCOMING PACKAGE / delivery info from the emails below. Return JSON {"packages":[...]}.\n`
    + `For each email that is clearly a shipment notification with an upcoming delivery, output one package: `
    + `carrier (UPS/FedEx/USPS/DHL/Amazon/etc.), item (what's arriving, if stated), eta (YYYY-MM-DD expected delivery date; omit if not stated), trackingNumber (if shown). `
    + `Ignore marketing, order-placed confirmations with no shipping/ETA, and already-delivered notices. If none, return {"packages":[]}. `
    + `Include a confidence (0-1) on every package: how sure you are it's a real upcoming delivery with correctly-read fields — use below 0.5 when unsure.\n\n`
    + emailBlocks(messages);
}

// Map a parsed package → a tap-to-add delivery reminder (a dated event the parent approves). Returns
// null unless there's a real, today-or-future ETA (a reminder needs a date).
export function packageToSuggestion(p: ParsedPackage, todayStr: string): CopilotSuggestion | null {
  const eta = String(p?.eta || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eta) || eta < todayStr) return null;
  const carrier = String(p?.carrier || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const item = String(p?.item || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const what = item || carrier || 'Package';
  const track = p?.trackingNumber ? ` · ${String(p.trackingNumber).slice(0, 40)}` : '';
  const via = carrier && item ? ` (${carrier})` : '';
  return {
    start: eta,
    title: `Delivery: ${what}`.slice(0, 80),
    category: 'Other',
    note: `${what}${via} arriving ${eta}${track}`.slice(0, 200),
  };
}
