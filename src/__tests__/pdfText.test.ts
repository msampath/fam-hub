import { describe, it, expect } from 'vitest';
import { hasUsableText } from '../utils/pdfText';

describe('hasUsableText (PDF text-layer vs OCR-fallback decision)', () => {
  it('is true when a real text layer was extracted (→ skip the cloud LLM)', () => {
    expect(hasUsableText('Early release is every Wednesday at 1:30pm for the whole school.')).toBe(true);
  });

  it('is false for empty / whitespace / a too-short scrap (→ OCR fallback)', () => {
    expect(hasUsableText('')).toBe(false);
    expect(hasUsableText('   \n\t  ')).toBe(false);
    expect(hasUsableText('p. 1')).toBe(false); // scanned PDF often yields just page furniture
  });

  it('counts non-whitespace characters against the threshold', () => {
    expect(hasUsableText('ab cd', 10)).toBe(false); // 4 non-ws chars < 10
    expect(hasUsableText('abcdefghij', 10)).toBe(true);
  });
});
