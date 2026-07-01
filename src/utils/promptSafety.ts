// Sanitize a user-controlled string before it's injected into an LLM prompt block (DATE FACTS,
// AVAILABILITY, HISTORY FACTS, the member roster, etc.). These blocks are line-structured and the
// model is told to treat them as authoritative, so the real risk is a value carrying a NEWLINE (or
// control chars) that breaks the block apart and lets injected text masquerade as a new fact/rule.
// We collapse all whitespace to single spaces, strip control characters, and cap the length. Pure.

// ASCII control characters (0x00-0x1F incl. CR/LF/TAB, plus DEL 0x7F). Built via the RegExp string
// constructor with \u escapes so there are no literal control bytes in this source file.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]+', 'g');

export function sanitizeForPrompt(input: any, maxLen = 100): string {
  return String(input ?? '')
    .replace(CONTROL_CHARS, ' ') // newlines, tabs, other control chars → space (can't break the block)
    .replace(/\s+/g, ' ')        // collapse runs of whitespace
    .trim()
    .slice(0, Math.max(0, maxLen));
}
