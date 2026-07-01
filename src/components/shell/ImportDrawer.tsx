import { useState, useMemo, type FormEvent } from 'react';
import { Link as LinkIcon, ClipboardList, FileText, Upload, Trash2, Sparkles, X } from 'lucide-react';
import { useApp } from '../../AppContext';
import { useCalendar } from '../../CalendarContext';
import { CATEGORIES } from '../../constants';
import { uuid } from '../../utils/uuid';
import { apiFetch } from '../../supabase';
import { fileKind, UPLOAD_ACCEPT } from '../../utils/fileKind';
import { extractFileText } from '../../utils/fileExtract';
import type { Category, LibraryDoc } from '../../types';
import { C, brutShadow } from './theme';

const CATS = Object.keys(CATEGORIES) as Category[];
const field = { background: C.card, border: `2px solid ${C.elevated}`, color: C.primary } as const;

interface ImportDrawerProps {
  onClose: () => void;
}

// Universal uploader (spec §8). One surface for getting outside content IN: a web URL, pasted text, or a file
// (.txt/.md/.pdf/.docx/.xlsx). By default everything is saved to the Docs Library (the copilot's memory);
// ticking "this is a calendar" instead routes the same input through the existing calendar-import pipeline.
export default function ImportDrawer({ onClose }: ImportDrawerProps) {
  const { authorStamp } = useApp();
  const {
    libraryDocs, setLibraryDocs,
    syncMode, setSyncMode, errorStatus, setErrorStatus,
    handleAddSource, newUrl, setNewUrl, newSourceName, setNewSourceName, newUrlCategory, setNewUrlCategory,
    syncAssignee, setSyncAssignee, familyMembers, isParsing,
    handleTextSubmit, pastedText, setPastedText, textSourceName, setTextSourceName, textCategory, setTextCategory,
    pdfCategory, setPdfCategory, dragActive, setDragActive, handlePdfUpload, parserStep,
    sources, handleDeleteSource,
  } = useCalendar();

  // Docs-path local state (the calendar path keeps using CalendarContext state untouched).
  const [asCalendar, setAsCalendar] = useState(false);
  const [folder, setFolder] = useState('Uncategorized');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgErr, setMsgErr] = useState(false);
  const flash = (text: string | null, isError = false) => { setMsg(text); setMsgErr(isError); };

  const folderNames = useMemo(
    () => Array.from(new Set(libraryDocs.map(d => d.folder).filter(Boolean))).sort(),
    [libraryDocs],
  );

  // 'google' lives in Manage; this drawer only does url/text/file ('pdf' is the internal key for the Files tab).
  const mode = syncMode === 'google' ? 'url' : syncMode;
  const working = isParsing || busy;

  const saveDoc = (name: string, text: string) => {
    const clean = text.trim();
    if (!clean) { flash('Nothing readable to save.', true); return false; }
    const doc: LibraryDoc = {
      id: 'doc-' + uuid(),
      folder: folder.trim() || 'Uncategorized',
      name: name.trim() || 'Untitled',
      text: clean,
      ...authorStamp(),
    };
    setLibraryDocs(prev => [doc, ...prev].slice(0, 200)); // cap — the collection is one JSONB blob
    return true;
  };

  // --- Submit handlers: delegate to the calendar pipeline when ticked, else save to Docs ---
  const onUrlSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (asCalendar) { handleAddSource(e); return; }
    const url = newUrl.trim();
    if (!url) return;
    setBusy(true); flash(null); setErrorStatus(null);
    try {
      const res = await apiFetch('/api/extract-url-text', { method: 'POST', body: JSON.stringify({ url }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Could not save that page.');
      if (saveDoc(newSourceName.trim() || url, `Source: ${url}\n\n${data.text}`)) {
        setNewUrl(''); setNewSourceName(''); flash('Saved page to Docs ✓');
      }
    } catch (err: any) { flash(err?.message || 'Could not save that page.', true); }
    finally { setBusy(false); }
  };

  const onTextSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (asCalendar) { handleTextSubmit(e); return; }
    if (!pastedText.trim()) return;
    if (saveDoc(textSourceName.trim() || 'Pasted note', pastedText)) {
      setPastedText(''); setTextSourceName(''); flash('Saved to Docs ✓');
    }
  };

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    if (asCalendar) {
      // Calendar event extraction only handles PDFs (Gemini multimodal). Drag-drop bypasses the input's
      // accept filter, so guard non-PDFs here with a clear message instead of failing opaquely.
      if (fileKind(file.name, file.type) !== 'pdf') {
        flash('The calendar reader only handles PDFs — untick “this is a calendar” to save this as a doc, or upload a PDF.', true);
        return;
      }
      handlePdfUpload(file);
      return;
    }
    setBusy(true); flash(null);
    try {
      if (saveDoc(file.name.replace(/\.[^.]+$/, ''), await extractFileText(file))) flash(`Saved “${file.name}” to Docs ✓`);
    } catch (err: any) { flash(err?.message || 'Could not read that file.', true); }
    finally { setBusy(false); }
  };

  const tab = (key: 'url' | 'text' | 'pdf', label: string, Icon: typeof LinkIcon) => (
    <button
      type="button"
      onClick={() => { setSyncMode(key); setErrorStatus(null); flash(null); }}
      className="flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-xs font-bold"
      style={mode === key
        ? { border: `2px solid ${C.indigo}`, background: `${C.indigo}1a`, color: C.indigo }
        : { border: `2px solid ${C.elevated}`, background: 'transparent', color: C.muted }}
    >
      <Icon size={13} />{label}
    </button>
  );

  const assignee = (
    <select value={syncAssignee} onChange={e => setSyncAssignee(e.target.value)} className="rounded-[10px] px-2.5 py-2 text-sm font-semibold outline-none" style={field}>
      <option value="Family" style={{ background: C.card }}>🟢 Family (everyone)</option>
      {familyMembers.map(m => <option key={m.name} value={m.name} style={{ background: C.card }}>{m.name} ({m.role})</option>)}
    </select>
  );
  const catSelect = (value: Category, onChange: (c: Category) => void) => (
    <select value={value} onChange={e => onChange(e.target.value as Category)} className="rounded-[10px] px-2.5 py-2 text-sm font-semibold outline-none" style={field}>
      {CATS.map(c => <option key={c} value={c} style={{ background: C.card }}>{c}</option>)}
    </select>
  );
  // The per-tab secondary controls differ by destination: a Folder for Docs, category + assignee for Calendar.
  const folderField = (
    <>
      <input value={folder} onChange={e => setFolder(e.target.value)} list="import-folders" placeholder="Folder" aria-label="Folder" className="min-w-[120px] rounded-[10px] px-2.5 py-2 text-sm font-semibold outline-none" style={field} />
      <datalist id="import-folders">{folderNames.map(f => <option key={f} value={f} />)}</datalist>
    </>
  );
  const submitBtn = (calendarLabel: string, docsLabel: string) => (
    <button type="submit" disabled={working} className="flex items-center justify-center gap-1.5 rounded-[10px] px-4 py-2 text-sm font-extrabold" style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo, opacity: working ? 0.5 : 1 }}>
      <Sparkles size={14} />{working ? 'Working…' : (asCalendar ? calendarLabel : docsLabel)}
    </button>
  );

  return (
    <div className="mx-auto mt-2.5 max-w-[1200px] rounded-[14px] p-3.5" style={{ border: `2px solid ${C.indigo}`, boxShadow: brutShadow(C.indigoShadow, 3), background: C.pill }}>
      <div className="mb-2.5 flex items-center justify-between">
        <div className="text-[10px] font-extrabold uppercase tracking-[0.12em]" style={{ color: C.indigo }}>
          {asCalendar ? 'Import → the copilot reads it into your calendar' : 'Upload → saved to your Docs library'}
        </div>
        <button type="button" onClick={onClose} aria-label="Close import" style={{ color: C.ink }}><X size={16} /></button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {tab('url', 'Web URL', LinkIcon)}
        {tab('text', 'Paste text', ClipboardList)}
        {tab('pdf', 'Files', FileText)}
      </div>

      {/* The router: where this input lands. Default = Docs; ticked = the calendar pipeline. */}
      <label className="mb-3 flex min-h-[40px] cursor-pointer items-center gap-2.5 text-xs font-bold" style={{ color: asCalendar ? C.indigo : C.muted }}>
        <input type="checkbox" checked={asCalendar} onChange={e => { setAsCalendar(e.target.checked); flash(null); setErrorStatus(null); }} aria-label="This is a calendar" className="h-5 w-5 flex-shrink-0" style={{ accentColor: C.indigo }} />
        📅 This is a calendar — extract events instead of saving as a doc
      </label>

      {errorStatus && (
        <div className="mb-3 rounded-[10px] px-3 py-2 text-xs font-semibold" style={{ background: `${C.red}14`, border: `2px solid ${C.red}38`, color: C.red }}>
          {errorStatus}
        </div>
      )}

      {mode === 'url' && (
        <form onSubmit={onUrlSubmit} className="flex flex-col gap-2">
          <input type="url" required value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder={asCalendar ? 'Calendar/school/events URL (.ics, portal, newsletter link)' : 'Web page URL to save (article, schedule, info page)'} className="rounded-[10px] px-3 py-2 text-sm outline-none" style={field} />
          <div className="flex flex-wrap gap-2">
            <input value={newSourceName} onChange={e => setNewSourceName(e.target.value)} placeholder="Name (optional)" className="min-w-0 flex-1 rounded-[10px] px-3 py-2 text-sm outline-none" style={field} />
            {asCalendar ? <>{catSelect(newUrlCategory, setNewUrlCategory)}{assignee}</> : folderField}
          </div>
          {submitBtn('Import from URL', 'Save page to Docs')}
        </form>
      )}

      {mode === 'text' && (
        <form onSubmit={onTextSubmit} className="flex flex-col gap-2">
          <textarea required rows={3} value={pastedText} onChange={e => setPastedText(e.target.value)} placeholder={asCalendar ? 'Paste dates, a newsletter, an email — the copilot extracts the events.' : 'Paste a note, an email, anything — saved as a doc the copilot can read.'} className="resize-none rounded-[10px] px-3 py-2 text-sm outline-none" style={field} />
          <div className="flex flex-wrap gap-2">
            <input value={textSourceName} onChange={e => setTextSourceName(e.target.value)} placeholder={asCalendar ? 'Source name (optional)' : 'Document name (optional)'} className="min-w-0 flex-1 rounded-[10px] px-3 py-2 text-sm outline-none" style={field} />
            {asCalendar ? <>{catSelect(textCategory, setTextCategory)}{assignee}</> : folderField}
          </div>
          {submitBtn('Extract events', 'Save to Docs')}
        </form>
      )}

      {mode === 'pdf' && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {asCalendar ? <>{catSelect(pdfCategory, setPdfCategory)}{assignee}</> : folderField}
          </div>
          <div
            onDragOver={e => { e.preventDefault(); setDragActive(true); }}
            onDragLeave={e => { e.preventDefault(); setDragActive(false); }}
            onDrop={e => { e.preventDefault(); setDragActive(false); onPickFile(e.dataTransfer.files?.[0]); }}
            onClick={() => !working && document.getElementById('shell-file-selector')?.click()}
            className={`flex flex-col items-center justify-center rounded-[12px] border-2 border-dashed p-5 text-center ${working ? 'cursor-wait' : 'cursor-pointer'}`}
            style={{ borderColor: dragActive ? C.indigo : C.elevated, background: dragActive ? `${C.indigo}10` : 'transparent', opacity: working ? 0.6 : 1 }}
          >
            <input id="shell-file-selector" type="file" accept={asCalendar ? 'application/pdf' : UPLOAD_ACCEPT} className="hidden" disabled={working} onChange={e => onPickFile(e.target.files?.[0])} />
            <Upload size={20} style={{ color: C.indigo }} />
            <span className="mt-2 text-sm font-bold" style={{ color: C.primary }}>{asCalendar ? 'Drop a PDF calendar or flyer' : 'Drop a file — PDF, Word, Excel or text'}</span>
            <span className="mt-0.5 text-xs" style={{ color: C.ink }}>or click to browse</span>
          </div>
        </div>
      )}

      {msg && (
        <div className="mt-3 rounded-[10px] px-3 py-2 text-xs font-semibold" style={msgErr
          ? { background: `${C.red}14`, border: `2px solid ${C.red}38`, color: C.red }
          : { background: `${C.emerald}12`, border: `2px solid ${C.emerald}33`, color: C.emerald }}>
          {msg}
        </div>
      )}

      {isParsing && (
        <div className="mt-3 rounded-[10px] px-3 py-2 text-xs font-semibold" style={{ background: `${C.indigo}12`, border: `2px solid ${C.indigo}29`, color: C.indigo }}>
          AI coordinator active: <span className="font-mono">{parserStep}</span>
        </div>
      )}

      {sources.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider" style={{ color: C.muted }}>Imported calendar sources</div>
          <div className="flex flex-col gap-1.5">
            {sources.map(src => (
              <div key={src.id} className="flex items-center justify-between gap-2 rounded-[10px] px-3 py-2" style={{ border: `2px solid ${C.elevated}`, background: C.card }}>
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-bold" style={{ color: C.primary }}>{src.name}</div>
                  <div className="text-[11px] font-semibold" style={{ color: C.emerald }}>✨ {src.eventCount} imported</div>
                </div>
                <button type="button" onClick={() => handleDeleteSource(src.id)} aria-label={`Delete ${src.name}`} style={{ color: C.ink }}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-2 text-[11px] font-semibold" style={{ color: C.ink }}>Google Calendar sync lives in <span style={{ color: C.muted }}>Manage</span>.</div>
    </div>
  );
}
