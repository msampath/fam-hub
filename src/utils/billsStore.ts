// Merge autonomously-scanned bills into the persisted `bills` collection. The auto-scan runs on its own
// (opt-in, every 30 min) and calls this — no human action — so the agent's get_bills always reflects the
// latest inbox. Dedup by payee|dueDate so re-scans don't pile up duplicates; cap the collection; keep
// parsed fields only (the email body is never stored). Pure → unit-tested.
import type { Bill } from '../types';

export interface ParsedBillLike { payee?: string; amount?: string; dueDate?: string; account?: string }

const KEY = (b: { payee?: string; dueDate?: string }) =>
  `${(b.payee || '').trim().toLowerCase()}|${(b.dueDate || '').slice(0, 10)}`;

// Returns the merged list (existing first, then genuinely-new bills), capped. `stamp` supplies id +
// author/createdAt for each new bill (so callers inject uuid()/authorStamp() — keeps this pure/testable).
export function mergeBills(
  existing: Bill[],
  incoming: ParsedBillLike[],
  stamp: () => { id: string } & Partial<Bill>,
  cap = 100,
): Bill[] {
  const seen = new Set(existing.map(KEY));
  const fresh: Bill[] = [];
  for (const b of Array.isArray(incoming) ? incoming : []) {
    const payee = String(b?.payee || '').replace(/\s+/g, ' ').trim();
    if (!payee) continue;
    const k = KEY({ payee, dueDate: b.dueDate });
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push({
      payee: payee.slice(0, 80),
      amount: b.amount ? String(b.amount).slice(0, 20) : undefined,
      dueDate: /^\d{4}-\d{2}-\d{2}/.test(String(b.dueDate || '')) ? String(b.dueDate).slice(0, 10) : undefined,
      account: b.account ? String(b.account).slice(0, 24) : undefined,
      ...stamp(),
    });
  }
  return [...existing, ...fresh].slice(-cap);
}
