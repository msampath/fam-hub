// AI "Generate a starter chore plan" (docs/ai-chore-plan-generator.md) — the PURE half, shared by the
// server endpoint (sanitization) and the client preview (grouping). No browser/Node deps.

import type { FamilyMember } from '../types';

// The curated plan embedded as a STYLE/COVERAGE exemplar only. The prompt frames it explicitly:
// tone + breadth + notes-style are the example; the model must NOT copy names or items verbatim —
// it assigns to the REAL kids by their given ages (this sidesteps the Child_8/Child_4 placeholder
// mapping problem: placeholders never reach the output path, kid names come from the request).
export const CHORE_PLAN_STYLE_EXEMPLAR = JSON.stringify([
  { title: 'Make your bed', assignedTo: 'Child_8', points: 10, timesPerDay: 1, repeatType: 'daily', scheduleTimeOfDay: 'Morning', notes: 'Pull the blanket flat and set the pillow at the top — a 2-minute win that starts the day tidy.' },
  { title: 'Reading time (20 min)', assignedTo: 'Child_8', points: 15, timesPerDay: 1, repeatType: 'daily', scheduleTimeOfDay: 'Evening', notes: 'Any book you like. Twenty quiet minutes builds the habit — set a timer.' },
  { title: 'Water the plants', assignedTo: 'Child_8', points: 10, timesPerDay: 1, repeatType: 'weekly', scheduleTimeOfDay: 'Afternoon', notes: 'Small cup per pot; stop when water reaches the tray. Plants droop when thirsty — check the soil with a finger.' },
  { title: 'Put toys back in the bin', assignedTo: 'Child_4', points: 5, timesPerDay: 1, repeatType: 'daily', scheduleTimeOfDay: 'Evening', notes: 'Everything with wheels in the red bin, blocks in the blue one. Make it a race!' },
  { title: 'Feed the pet', assignedTo: 'Both', points: 10, timesPerDay: 2, repeatType: 'daily', scheduleTimeOfDay: 'Morning', notes: 'One scoop, fresh water. Animals depend on us every single day.' },
]);

export interface GeneratedChore {
  title: string;
  assignedTo: string;
  points?: number;
  timesPerDay?: number;
  repeatType?: 'daily' | 'weekly';
  scheduleTimeOfDay?: string;
  notes?: string;
}

const SLOT_NAMES = ['Morning', 'Afternoon', 'Evening', 'Anytime'];

// Server-side sanitizer: the model's raw JSON → validated GeneratedChore[]. Tolerates either a root
// array or { chores: [...] } (weak local models drift on the wrapper). Drops titleless rows and rows
// assigned to anyone who is not a REAL kid from the request (an injected/placeholder name never
// reaches the board); clamps every numeric/enum/notes field; caps the batch. Garbage in → [].
export function sanitizeGeneratedChores(raw: any, kidNames: string[], max = 40): GeneratedChore[] {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.chores) ? raw.chores : null;
  if (!arr) return [];
  const byLower = new Map(kidNames.map(n => [n.trim().toLowerCase(), n]));
  const out: GeneratedChore[] = [];
  for (const row of arr) {
    if (out.length >= max) break;
    const title = String(row?.title ?? '').trim().slice(0, 200);
    if (!title) continue;
    const kid = byLower.get(String(row?.assignedTo ?? '').trim().toLowerCase());
    if (!kid) continue; // unresolvable assignee → drop (never guess a kid)
    const points = Math.min(20, Math.max(5, Math.round(Number(row?.points)) || 10));
    const timesPerDay = Math.min(3, Math.max(1, Math.round(Number(row?.timesPerDay)) || 1));
    const slotRaw = String(row?.scheduleTimeOfDay ?? '').trim().toLowerCase();
    const slot = SLOT_NAMES.find(s => s.toLowerCase() === slotRaw);
    const notes = String(row?.notes ?? '').trim().slice(0, 500);
    out.push({
      title,
      assignedTo: kid,
      points,
      timesPerDay,
      repeatType: row?.repeatType === 'weekly' ? 'weekly' : 'daily',
      ...(slot ? { scheduleTimeOfDay: slot } : {}),
      ...(notes ? { notes } : {}),
    });
  }
  return out;
}

// Group a generated plan per kid for the preview, in ROSTER order (the family's own ordering, not the
// model's emission order). Kids with no generated chores are omitted.
export function groupGeneratedByKid(
  chores: GeneratedChore[], familyMembers: FamilyMember[],
): { kid: string; chores: GeneratedChore[] }[] {
  const roster = (Array.isArray(familyMembers) ? familyMembers : []).filter(m => m.role === 'Kid').map(m => m.name);
  return roster
    .map(kid => ({ kid, chores: (Array.isArray(chores) ? chores : []).filter(c => c.assignedTo === kid) }))
    .filter(g => g.chores.length > 0);
}
