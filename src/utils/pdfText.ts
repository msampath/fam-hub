// Decide whether a PDF's embedded text-layer extraction yielded enough real text, or whether the PDF is
// scanned/image-only and needs OCR. Drives the cost-saving path: extract the text layer locally first
// (free, offline, deterministic via pdfjs-dist) and only fall back to the cloud LLM for true OCR. Pure.
export function hasUsableText(text: string, minChars = 40): boolean {
  return (text || '').replace(/\s+/g, '').length >= minChars;
}
