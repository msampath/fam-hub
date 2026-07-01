// pdf-parse ships no types; we import the inner module path to avoid its index.js debug-file side effect.
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult { text: string; numpages?: number; info?: unknown }
  function pdfParse(data: Buffer | Uint8Array): Promise<PdfParseResult>;
  export default pdfParse;
}
