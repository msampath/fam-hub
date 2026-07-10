// Shared file → text extraction for the upload surfaces (the universal ImportDrawer + the Library add-form),
// so both accept the same kinds and don't drift. Text files are read locally; pdf/docx/xlsx go to the
// matching local-first server extractor. Throws a user-facing Error on unsupported kinds or failure.
import { apiFetch } from '../supabase';
import { fileKind, EXTRACT_ENDPOINT } from './fileKind';

const read = (file: File, how: 'dataURL' | 'text') => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result || ''));
  r.onerror = () => reject(r.error);
  if (how === 'dataURL') r.readAsDataURL(file); else r.readAsText(file);
});
const readAsDataUrl = (file: File) => read(file, 'dataURL');

export async function extractFileText(file: File): Promise<string> {
  const kind = fileKind(file.name, file.type);
  if (kind === 'text') return (await read(file, 'text')).trim();
  if (kind === 'unknown') throw new Error('Unsupported file — use PDF, Word (.docx), Excel (.xlsx) or a text file.');
  if (file.size > 7 * 1024 * 1024) throw new Error('That file is too large (max ~7 MB). Try a shorter document or paste the text instead.');
  const ep = EXTRACT_ENDPOINT[kind];
  const dataUrl = await readAsDataUrl(file);
  const res = await apiFetch(ep.path, { method: 'POST', body: JSON.stringify({ [ep.field]: dataUrl }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Could not read that file.');
  const text = String(data?.text || '').trim();
  if (!text) throw new Error('No readable text found (it may be a scan or empty) — try pasting the text.');
  return text;
}
