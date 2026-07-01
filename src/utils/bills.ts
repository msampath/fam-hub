// Bills ingestion (capability B1). Provider-agnostic: consumes a NormalizedMessage from the shared
// email adapter (src/utils/email.ts — GmailAdapter now, Microsoft Graph later). Privacy contract
// (owner-consented): tight filter, parse in-memory, store ONLY parsed fields — never the email body.
// Pure → unit-testable; the server does the fetch + the AI parse call.
import type { CopilotSuggestion } from '../types';
import { type NormalizedMessage, emailBlocks } from './email';

// A parsed bill — the ONLY thing kept (never the email body).
export interface ParsedBill {
  payee: string;
  amount?: string;   // display string ("$84.20") — don't coerce currency
  dueDate?: string;  // YYYY-MM-DD
  account?: string;
}

// Tight Gmail search filter: bill-shaped mail in a recent window only. Minimal read (privacy) + cheap
// parse. `days` bounds recency.
export function buildBillQuery(days = 45): string {
  return `newer_than:${days}d (subject:(invoice OR statement OR "amount due" OR "payment due" OR "your bill" OR receipt) OR from:(billing OR no-reply OR noreply OR statements OR invoices))`;
}

// Build the bill-extraction prompt. Email fields are sanitized via the shared emailBlocks() helper
// (prompt-injection defense).
export function buildBillParsePrompt(messages: NormalizedMessage[]): string {
  return `You are extracting BILLS / payment-due items from the emails below. Return JSON {"bills":[...]}.\n`
    + `For each email that is clearly a bill/invoice/statement with money owed, output one bill: `
    + `payee (the company), amount (as written, e.g. "$84.20", omit if unknown), dueDate (YYYY-MM-DD; omit if not stated), account (last 4 / account label if shown). `
    + `Ignore marketing, receipts for already-paid one-off purchases, and anything with no amount owed. If none are bills, return {"bills":[]}.\n\n`
    + emailBlocks(messages);
}

// Map a parsed bill → a tap-to-add reminder suggestion (a dated event the parent approves). Returns
// null unless there's a real, today-or-future due date (a reminder for a past due date is useless).
export function billToSuggestion(b: ParsedBill, todayStr: string): CopilotSuggestion | null {
  const due = String(b?.dueDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || due < todayStr) return null;
  const payee = String(b?.payee || 'Bill').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Bill';
  const amt = b?.amount ? ` (${String(b.amount).slice(0, 20)})` : '';
  const acct = b?.account ? ` · acct ${String(b.account).slice(0, 24)}` : '';
  return {
    start: due,
    title: `Bill due: ${payee}`.slice(0, 80),
    category: 'Other',
    note: `${payee}${amt} due ${due}${acct}`.slice(0, 200),
  };
}
