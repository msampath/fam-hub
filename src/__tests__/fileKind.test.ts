import { describe, it, expect } from 'vitest';
import { fileKind, EXTRACT_ENDPOINT, UPLOAD_ACCEPT } from '../utils/fileKind';

describe('fileKind', () => {
  it('classifies by extension', () => {
    expect(fileKind('lease.pdf')).toBe('pdf');
    expect(fileKind('letter.docx')).toBe('docx');
    expect(fileKind('budget.xlsx')).toBe('xlsx');
    expect(fileKind('notes.txt')).toBe('text');
    expect(fileKind('readme.md')).toBe('text');
    expect(fileKind('data.csv')).toBe('text');
  });

  it('falls back to MIME type when the name has no useful extension', () => {
    expect(fileKind('blob', 'application/pdf')).toBe('pdf');
    expect(fileKind('blob', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('xlsx');
    expect(fileKind('blob', 'text/plain')).toBe('text');
  });

  it('is case-insensitive on the extension', () => {
    expect(fileKind('LEASE.PDF')).toBe('pdf');
    expect(fileKind('Letter.DOCX')).toBe('docx');
  });

  it('returns unknown for unsupported types', () => {
    expect(fileKind('photo.png')).toBe('unknown');
    expect(fileKind('archive.zip')).toBe('unknown');
    expect(fileKind('noextension')).toBe('unknown');
  });
});

describe('EXTRACT_ENDPOINT', () => {
  it('maps each binary kind to its server endpoint + base64 body field', () => {
    expect(EXTRACT_ENDPOINT.pdf).toEqual({ path: '/api/extract-pdf-text', field: 'pdfBase64' });
    expect(EXTRACT_ENDPOINT.docx).toEqual({ path: '/api/extract-docx-text', field: 'docxBase64' });
    expect(EXTRACT_ENDPOINT.xlsx).toEqual({ path: '/api/extract-xlsx-text', field: 'xlsxBase64' });
  });
});

describe('UPLOAD_ACCEPT', () => {
  it('accepts the five supported document kinds', () => {
    for (const ext of ['.pdf', '.docx', '.xlsx', '.txt', '.md']) expect(UPLOAD_ACCEPT).toContain(ext);
  });
});
