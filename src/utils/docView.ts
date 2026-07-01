// Clamp a document's text for the in-app viewer. Rendering a full 20k-char doc (or a pasted email body with
// control chars / pathologically long lines) in one <pre> can lock up the page — so strip control chars and
// cap the displayed length with a "showing first N of M" note. Pure → unit-tested. (The full text is still
// stored/searchable; this only bounds what the modal paints.)

// Strip ASCII control chars EXCEPT tab (0x09), newline (0x0A), carriage return (0x0D). Built from an escaped
// string so no literal control bytes live in this source file.
const CONTROL_CHARS = new RegExp('[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]', 'g');

export function clampDocText(text: string, max = 6000): string {
  const cleaned = String(text || '').replace(CONTROL_CHARS, '');
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}\n\n— showing the first ${max.toLocaleString()} of ${cleaned.length.toLocaleString()} characters —`;
}
