import { useMemo, useState, type FormEvent, type ChangeEvent } from 'react';
import { useApp } from '../../../AppContext';
import { useCalendar } from '../../../CalendarContext';
import { uuid } from '../../../utils/uuid';
import { clampDocText } from '../../../utils/docView';
import { extractFileText } from '../../../utils/fileExtract';
import { UPLOAD_ACCEPT } from '../../../utils/fileKind';
import type { LibraryDoc } from '../../../types';
import { NEWSLETTER_FOLDER } from '../../../utils/newsletters';
import { C, brutShadow } from '../theme';

// Docs Library (spec §6): the copilot's readable memory. Real folder/file CRUD + search over docs
// persisted in the household's `documents` collection; the copilot grounds answers on the text
// (LOCAL KNOWLEDGE FACTS, server-side). Binary file storage + vector RAG are a deferred upgrade.
export default function LibraryPage() {
  const { authorStamp } = useApp();
  const { libraryDocs, setLibraryDocs } = useCalendar();

  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [openDoc, setOpenDoc] = useState<LibraryDoc | null>(null);
  // Folders collapsed in the grid.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleFolder = (f: string) => setCollapsed(prev => { const n = new Set(prev); n.has(f) ? n.delete(f) : n.add(f); return n; });
  // Per-row actions menu (✕ → Delete · Rename · Move) and the inline rename/move editor.
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editDoc, setEditDoc] = useState<{ id: string; mode: 'rename' | 'move'; value: string } | null>(null);

  // Newsletters are auto-ingested for the agent's searchable knowledge (search_local_knowledge) but are NOT
  // the parent's filed documents — keep them out of the visible Library while leaving them in `documents`
  // so RAG still grounds on them (capstone #6 + the "feed RAG silently" decision).
  const visibleDocs = useMemo(() => libraryDocs.filter(d => d.folder !== NEWSLETTER_FOLDER), [libraryDocs]);
  // Add-form fields
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [text, setText] = useState('');

  // Distinct folder names (for the datalist) — derived from the docs themselves.
  const folderNames = useMemo(
    () => Array.from(new Set(visibleDocs.map(d => d.folder).filter(Boolean))).sort(),
    [visibleDocs],
  );

  // Search filters across name/folder/text; otherwise group every doc by folder.
  const q = search.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? visibleDocs.filter(d => `${d.name} ${d.folder} ${d.text}`.toLowerCase().includes(q)) : visibleDocs),
    [visibleDocs, q],
  );
  const grouped = useMemo(() => {
    const by: Record<string, LibraryDoc[]> = {};
    for (const d of matches) (by[d.folder || 'Unfiled'] ||= []).push(d);
    return Object.entries(by).sort(([a], [b]) => a.localeCompare(b));
  }, [matches]);

  const resetForm = () => { setFolder(''); setName(''); setText(''); setShowAdd(false); setUploadMsg(null); };

  const [extracting, setExtracting] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const onPickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadMsg(null);
    if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, ''));
    // Shared extractor: text read locally; PDF/Word/Excel via the local-first server endpoints. Keeps this
    // upload path in lockstep with the paperclip ImportDrawer (same accepted kinds).
    setExtracting(true);
    try {
      setText(await extractFileText(file));
    } catch (err: any) {
      setUploadMsg(err?.message || 'Couldn’t read that file — try again or paste the text.');
    } finally {
      setExtracting(false);
    }
  };

  const saveDoc = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !text.trim()) return;
    const doc: LibraryDoc = {
      id: 'doc-' + uuid(),
      folder: folder.trim() || 'Unfiled',
      name: name.trim(),
      text: text.trim(),
      ...authorStamp(),
    };
    setLibraryDocs(prev => [doc, ...prev].slice(0, 200)); // cap total docs — the row is one JSONB blob
    resetForm();
  };

  const deleteDoc = (id: string) => {
    setLibraryDocs(prev => prev.filter(d => d.id !== id));
    setOpenDoc(cur => (cur?.id === id ? null : cur));
    setMenuId(null);
  };

  // Rename / Move (capstone #7): edit the doc's name or folder in place; both reflect into the open viewer.
  const applyEdit = () => {
    if (!editDoc) return;
    const value = editDoc.value.trim();
    setLibraryDocs(prev => prev.map(d => {
      if (d.id !== editDoc.id) return d;
      return editDoc.mode === 'rename'
        ? { ...d, name: value || d.name }
        : { ...d, folder: value || 'Unfiled' };
    }));
    setOpenDoc(cur => (cur && cur.id === editDoc.id
      ? (editDoc.mode === 'rename' ? { ...cur, name: value || cur.name } : { ...cur, folder: value || 'Unfiled' })
      : cur));
    setEditDoc(null);
  };

  // Download the doc's text as a .txt file (capstone #6) — no server round-trip.
  const downloadDoc = (doc: LibraryDoc) => {
    const blob = new Blob([doc.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${doc.name.replace(/[^\w.-]+/g, '_') || 'document'}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const btnGhost = { border: `2px solid ${C.elevated}`, background: C.card, color: C.primary } as const;
  const field = { background: C.card, border: `2px solid ${C.elevated}`, color: C.primary } as const;

  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-16 md:py-7">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-5">

        <div className="flex items-center justify-between gap-2">
          <div className="text-2xl font-extrabold md:text-[28px]" style={{ color: C.primary }}>Docs Library</div>
          <button
            type="button"
            onClick={() => setShowAdd(v => !v)}
            className="rounded-[12px] px-4 py-2 text-[13px] font-extrabold"
            style={{ border: `2px solid ${C.indigo}`, boxShadow: brutShadow(C.indigoShadow, 4), background: `${C.indigo}12`, color: C.indigo }}
          >
            ＋ Add document
          </button>
        </div>

        <div className="rounded-[14px] px-4 py-3 text-sm font-medium leading-relaxed" style={{ background: `${C.indigo}10`, border: `2px solid ${C.indigo}29`, color: C.muted }}>
          🧠 The copilot's memory — paste a note or upload a file (PDF, Word, Excel, text), then ask the copilot anything from it. <span style={{ color: C.ink }}>(Text is extracted automatically.)</span>
        </div>

        {/* Folder suggestions — shared by the add-form and the per-row Move editor (always available). */}
        <datalist id="library-folders">{folderNames.map(f => <option key={f} value={f} />)}</datalist>

        {/* Add-document form */}
        {showAdd && (
          <form onSubmit={saveDoc} className="rounded-[18px] p-4" style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}0a` }}>
            <div className="mb-2 flex flex-wrap gap-2">
              <input
                value={folder} onChange={e => setFolder(e.target.value)} list="library-folders"
                placeholder="Folder (e.g. School)" aria-label="Folder"
                className="min-w-0 flex-1 rounded-[10px] px-3 py-2 text-sm font-semibold outline-none" style={field}
              />
              <input
                value={name} onChange={e => setName(e.target.value)}
                placeholder="Document name" aria-label="Document name"
                className="min-w-0 flex-[2] rounded-[10px] px-3 py-2 text-sm font-semibold outline-none" style={field}
              />
            </div>
            <textarea
              value={text} onChange={e => setText(e.target.value)} rows={5}
              placeholder="Paste the document text here — the copilot reads this." aria-label="Document text"
              className="w-full resize-none rounded-[10px] px-3 py-2 text-sm outline-none" style={field}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className={`rounded-[10px] px-3 py-2 text-[13px] font-bold ${extracting ? 'cursor-wait' : 'cursor-pointer'}`} style={{ ...btnGhost, opacity: extracting ? 0.6 : 1 }}>
                {extracting ? 'Extracting…' : '⬆ Upload a file'}
                <input type="file" accept={UPLOAD_ACCEPT} onChange={onPickFile} disabled={extracting} className="hidden" />
              </label>
              {uploadMsg && <span className="text-[12px] font-semibold" style={{ color: C.red }}>{uploadMsg}</span>}
              <div className="ml-auto flex gap-2">
                <button type="button" onClick={resetForm} className="rounded-[10px] px-3.5 py-2 text-[13px] font-bold" style={btnGhost}>Cancel</button>
                <button type="submit" disabled={!name.trim() || !text.trim()} className="rounded-[10px] px-3.5 py-2 text-[13px] font-extrabold" style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo, opacity: !name.trim() || !text.trim() ? 0.5 : 1 }}>Save</button>
              </div>
            </div>
          </form>
        )}

        {/* Search */}
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search documents…" aria-label="Search documents"
          className="w-full rounded-[12px] px-3.5 py-2.5 text-sm outline-none" style={field}
        />

        {/* Empty state */}
        {visibleDocs.length === 0 ? (
          <div className="rounded-[20px] p-8 text-center text-sm font-semibold" style={{ border: `2px dashed ${C.elevated}`, color: C.muted }}>
            No documents yet. Tap <span style={{ color: C.indigo }}>＋ Add document</span> to paste a note or upload a text file the copilot can read.
          </div>
        ) : grouped.length === 0 ? (
          <div className="text-sm font-semibold" style={{ color: C.muted }}>No documents match “{search}”.</div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {grouped.map(([folderName, docs]) => {
              // When searching, always expand so matches aren't hidden; otherwise honor the collapse state.
              const isCollapsed = !q && collapsed.has(folderName);
              return (
              <div key={folderName} className="rounded-[20px] p-5" style={{ border: `2px solid ${C.elevated}`, boxShadow: brutShadow(C.elevated, 5), background: C.card }}>
                <button type="button" onClick={() => toggleFolder(folderName)} className="mb-3 flex w-full items-center gap-2.5 text-left text-sm font-extrabold" style={{ color: C.primary }} aria-expanded={!isCollapsed}>
                  <span>{isCollapsed ? '▸' : '▾'}</span><span>📁</span>{folderName}
                  <span className="ml-auto text-[11px] font-semibold" style={{ color: C.muted }}>{docs.length} file{docs.length === 1 ? '' : 's'}</span>
                </button>
                {!isCollapsed && (
                  <div className="flex flex-col gap-1.5">
                    {docs.map(doc => (
                      editDoc?.id === doc.id ? (
                        <form key={doc.id} onSubmit={e => { e.preventDefault(); applyEdit(); }} className="flex items-center gap-2">
                          <input
                            autoFocus value={editDoc.value} onChange={e => setEditDoc({ ...editDoc, value: e.target.value })}
                            {...(editDoc.mode === 'move' ? { list: 'library-folders' } : {})}
                            aria-label={editDoc.mode === 'rename' ? `New name for ${doc.name}` : `Move ${doc.name} to folder`}
                            className="min-w-0 flex-1 rounded-[10px] px-3 py-2 text-[13px] font-semibold outline-none" style={field}
                          />
                          <button type="submit" className="flex-shrink-0 rounded-[10px] px-3 py-2 text-[12px] font-extrabold" style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo }}>Save</button>
                          <button type="button" onClick={() => setEditDoc(null)} className="flex-shrink-0 rounded-[10px] px-3 py-2 text-[12px] font-bold" style={btnGhost}>Cancel</button>
                        </form>
                      ) : (
                      <div key={doc.id} className="relative flex items-center gap-2.5">
                        <button type="button" onClick={() => setOpenDoc(doc)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-[13px] font-semibold" style={{ color: C.indigo }}>
                          <span>📄</span><span className="truncate">{doc.name}</span>
                        </button>
                        <button type="button" onClick={() => setMenuId(cur => (cur === doc.id ? null : doc.id))} aria-label={`Actions for ${doc.name}`} aria-haspopup="menu" aria-expanded={menuId === doc.id} className="flex h-9 w-9 flex-shrink-0 items-center justify-center text-[15px] font-bold" style={{ color: C.ink }}>⋯</button>
                        {menuId === doc.id && (
                          <div role="menu" className="absolute right-0 top-10 z-10 flex w-32 flex-col overflow-hidden rounded-[12px]" style={{ border: `2px solid ${C.elevated}`, boxShadow: brutShadow(C.elevated, 5), background: C.card }}>
                            <button type="button" role="menuitem" onClick={() => { setEditDoc({ id: doc.id, mode: 'rename', value: doc.name }); setMenuId(null); }} className="px-3 py-2 text-left text-[13px] font-semibold" style={{ color: C.primary }}>✏️ Rename</button>
                            <button type="button" role="menuitem" onClick={() => { setEditDoc({ id: doc.id, mode: 'move', value: doc.folder }); setMenuId(null); }} className="px-3 py-2 text-left text-[13px] font-semibold" style={{ color: C.primary }}>📁 Move</button>
                            <button type="button" role="menuitem" onClick={() => deleteDoc(doc.id)} className="px-3 py-2 text-left text-[13px] font-semibold" style={{ color: C.red }}>🗑 Delete</button>
                          </div>
                        )}
                      </div>
                      )
                    ))}
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Document viewer */}
      {openDoc && (
        <div className="fixed inset-0 z-[150] flex items-start justify-center overflow-y-auto p-4" style={{ background: 'rgba(3,6,8,0.85)' }} role="dialog" aria-modal="true" aria-label={openDoc.name}>
          <div className="mt-6 w-full max-w-[680px] rounded-[22px] p-5 md:p-6" style={{ border: `2px solid ${C.brut}`, boxShadow: `6px 6px 0 0 ${C.brut}`, background: C.card }}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-lg font-extrabold" style={{ color: C.primary }}>{openDoc.name}</div>
                <div className="text-[11px] font-semibold" style={{ color: C.muted }}>📁 {openDoc.folder}</div>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => downloadDoc(openDoc)} className="rounded-[10px] px-3 py-1.5 text-[12px] font-bold" style={btnGhost}>⬇ Download</button>
                <button type="button" onClick={() => deleteDoc(openDoc.id)} className="rounded-[10px] px-3 py-1.5 text-[12px] font-bold" style={{ background: `${C.red}18`, color: C.red, border: `2px solid ${C.red}33` }}>Delete</button>
                <button type="button" onClick={() => setOpenDoc(null)} aria-label="Close" className="rounded-[10px] px-3 py-1.5 text-[12px] font-bold" style={btnGhost}>Close</button>
              </div>
            </div>
            <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded-[12px] p-3 text-[13px] leading-relaxed" style={{ background: C.app, color: C.primary, fontFamily: 'inherit' }}>{clampDocText(openDoc.text)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
