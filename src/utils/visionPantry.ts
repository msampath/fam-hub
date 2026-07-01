// Vision intake (Pattern #2): the model returns the grocery items it SAW in a fridge/receipt photo, each
// flagged inPantry or not. This pure helper diffs that against the household's current pantry so we only
// stage the genuinely NEW items (and never the same item twice). Unit-tested; the UI confirms before adding.

export interface DetectedItem { text: string; inPantry?: boolean; store?: string }
export interface PantryDiff { newItems: DetectedItem[]; known: DetectedItem[] }

// Normalize for comparison: lowercase, strip punctuation, collapse whitespace ("2% Milk!" ~ "milk" stays
// distinct from "almond milk" — we compare on the whole normalized string, not substrings, to avoid false
// "already have it" matches).
export function normalizeItem(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function diffDetectedVsPantry(detected: DetectedItem[], pantry: { text: string }[]): PantryDiff {
  const have = new Set((Array.isArray(pantry) ? pantry : []).map(p => normalizeItem(p?.text)).filter(Boolean));
  const newItems: DetectedItem[] = [];
  const known: DetectedItem[] = [];
  const seen = new Set<string>();
  for (const d of Array.isArray(detected) ? detected : []) {
    const text = String(d?.text || '').trim();
    const key = normalizeItem(text);
    if (!text || !key || seen.has(key)) continue; // drop blanks + de-dupe the model's own repeats
    seen.add(key);
    const item: DetectedItem = { text, ...(d?.store ? { store: String(d.store) } : {}) };
    // "Already have it" if the model flagged it OR it matches a current pantry entry exactly (normalized).
    (d?.inPantry === true || have.has(key) ? known : newItems).push(item);
  }
  return { newItems, known };
}
