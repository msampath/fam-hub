// Sanitize a user-controlled string before it's injected into an LLM prompt block (DATE FACTS,
// AVAILABILITY, HISTORY FACTS, the member roster, etc.). These blocks are line-structured and the
// model is told to treat them as authoritative, so the real risk is a value carrying a NEWLINE (or
// control chars) that breaks the block apart and lets injected text masquerade as a new fact/rule.
// We collapse all whitespace to single spaces, strip control characters, and cap the length. Pure.

// Control characters: C0 (0x00-0x1F incl. CR/LF/TAB), DEL, the C1 block (0x80-0x9F — NEL U+0085 and
// friends are NOT JS \s, so they'd survive the whitespace collapse below), and the Unicode line/para
// separators U+2028/U+2029. Built via the RegExp string constructor with \u escapes so there are no
// literal control bytes in this source file.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]+', 'g');

export function sanitizeForPrompt(input: any, maxLen = 100): string {
  return String(input ?? '')
    .replace(CONTROL_CHARS, ' ') // newlines, tabs, other control chars → space (can't break the block)
    .replace(/\s+/g, ' ')        // collapse runs of whitespace
    .trim()
    .slice(0, Math.max(0, maxLen));
}

// One clamp for the household's home LABEL wherever it's interpolated into a facts block (weather /
// places / events builders) — previously maintained in triplicate; tightening it now lands everywhere.
export function safeHomeLabel(label: unknown): string {
  return (String(label || '').replace(/[\r\n]+/g, ' ').trim() || 'home').slice(0, 80);
}
