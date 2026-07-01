// Classify an uploaded file so the universal uploader picks the right text extractor. Pure → unit-tested.
export type FileKind = 'pdf' | 'docx' | 'xlsx' | 'text' | 'unknown';

export function fileKind(name: string, mime = ''): FileKind {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === 'docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (ext === 'xlsx' || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (['txt', 'md', 'markdown', 'csv', 'note'].includes(ext) || mime.startsWith('text/')) return 'text';
  return 'unknown';
}

// Server endpoint + base64 body field for each binary kind. (Text files are read client-side, no endpoint.)
export const EXTRACT_ENDPOINT: Record<'pdf' | 'docx' | 'xlsx', { path: string; field: string }> = {
  pdf: { path: '/api/extract-pdf-text', field: 'pdfBase64' },
  docx: { path: '/api/extract-docx-text', field: 'docxBase64' },
  xlsx: { path: '/api/extract-xlsx-text', field: 'xlsxBase64' },
};

// The accept attribute for the uploader's file input — the kinds we can turn into Docs text.
export const UPLOAD_ACCEPT = '.txt,.md,.markdown,.note,.csv,.pdf,.docx,.xlsx,text/*,application/pdf';
