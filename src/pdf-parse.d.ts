// pdfjs-dist ships types at its root (types/src/pdf.d.ts) but not for the Node-safe legacy sub-path.
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export { getDocument } from 'pdfjs-dist';
}
