// Resolve a Library doc the user/LLM referred to (by id or by name) for the delete_document / move_document
// chat tools. The LLM rarely knows the internal id, so name matching (exact first, then substring) is the
// practical interface; the client/server resolves it to the real doc. Pure → unit-tested.
import type { LibraryDoc } from '../types';

// `fuzzy` enables the substring fallback (convenient for the non-destructive move_document). DESTRUCTIVE
// delete_document passes fuzzy=false so it only ever matches an exact id or exact name — never silently
// deleting the wrong doc on a loose partial ("the school doc" when two contain "school").
export function resolveDoc(docs: LibraryDoc[], ref: { id?: string; name?: string }, fuzzy = true): LibraryDoc | null {
  if (!Array.isArray(docs)) return null;
  if (ref.id) {
    const byId = docs.find(d => d.id === ref.id);
    if (byId) return byId;
  }
  const name = String(ref.name || '').trim().toLowerCase();
  if (name) {
    const exact = docs.find(d => d.name.toLowerCase() === name);
    if (exact) return exact;
    if (fuzzy) return docs.find(d => d.name.toLowerCase().includes(name)) ?? null;
  }
  return null;
}

export function normalizeFolder(folder: string | undefined): string {
  return String(folder || '').trim() || 'Uncategorized';
}
