import { describe, it, expect } from 'vitest';
import {
  buildEventFromPayload,
  buildChoresFromPayload,
  normalizeShoppingItems,
} from '../utils/aiActions';
import type { Authored, FamilyMember, ShoppingItem } from '../types';

// The AI create-paths in src/App.tsx — `appendShoppingItems` (App.tsx:1792), `addEventFromPayload`
// (App.tsx:1876), `addChoresFromPayload` (App.tsx:1890), and `applyCopilotActions`'s
// create_event/add_chore/add_shopping_item branches (App.tsx:1968) — are App() closures that
// capture setEvents/setChoresList/familyMembers, so they can't be imported in isolation (no clean
// unit seam without rendering the whole App). What each one DOES, though, is identical and seam-able:
// run its pure trust-boundary builder, then spread `authorStamp()` onto every built record:
//   appendShoppingItems  → normalizeShoppingItems(...).map(i => ({ ...i, ...stamp }))   (App.tsx:1794)
//   addEventFromPayload  → { ...buildEventFromPayload(...), ...authorStamp() }          (App.tsx:1879)
//   addChoresFromPayload → buildChoresFromPayload(...).map(c => ({ ...c, ...stamp }))   (App.tsx:1892)
//   applyCopilotActions  → reuses the same composition inline: create_event (App.tsx:1987),
//                          add_chore (App.tsx:2003), add_shopping_item via appendShoppingItems (:2008)
// These tests pin that composition against the real (exported) builders: the stamp survives
// alongside the built fields and never clobbers them, and a signed-out `{}` stamp adds no keys.
// (The live state-setter wiring is covered by the ShoppingTab/ChoresTab component tests.)

const FAM: FamilyMember[] = [{ name: 'Leo', role: 'Kid', color: 'amber' }];
const STORES = ['Grocery Store', 'Other'] as const as readonly ShoppingItem['store'][];
const STAMP: Authored = { createdAt: '2026-06-18T00:00:00Z', createdByUserId: 'u1', createdByEmail: 'a@b.c' };

describe('AI-path authorship stamps (App.tsx build+stamp composition)', () => {
  it('appendShoppingItems stamps every normalized item without clobbering built fields', () => {
    const stamped = normalizeShoppingItems([{ text: 'Milk' }, { text: 'Eggs' }], STORES)
      .map(i => ({ ...i, ...STAMP }));
    expect(stamped).toHaveLength(2);
    expect(stamped[0]).toMatchObject({ text: 'Milk', createdByEmail: 'a@b.c', createdByUserId: 'u1', createdAt: STAMP.createdAt });
    expect(stamped[1]).toMatchObject({ text: 'Eggs', createdByEmail: 'a@b.c' });
  });

  it('addEventFromPayload stamps the built event without clobbering its fields', () => {
    const built = buildEventFromPayload({ title: 'Recital', start: '2026-06-20' }, 'cop', FAM, '2026-06-19');
    const evt = { ...built, ...STAMP };
    expect(evt).toMatchObject({
      title: 'Recital', start: '2026-06-20',
      createdByEmail: 'a@b.c', createdByUserId: 'u1', createdAt: STAMP.createdAt,
    });
  });

  it('addChoresFromPayload stamps every expanded chore', () => {
    const stamped = buildChoresFromPayload({ title: 'Brush teeth', assignedTo: 'Leo' }, FAM)
      .map(c => ({ ...c, ...STAMP }));
    expect(stamped.length).toBeGreaterThan(0);
    for (const c of stamped) {
      expect(c).toMatchObject({ title: 'Brush teeth', assignedTo: 'Leo', createdByEmail: 'a@b.c', createdByUserId: 'u1' });
    }
  });

  it('applyCopilotActions stamps both a create_event and an add_chore in one batch', () => {
    // Mirrors the inline composition in applyCopilotActions (App.tsx:1987 + :2003).
    const today = '2026-06-19';
    const actions = [
      { type: 'create_event', payload: { title: 'Game', start: '2026-06-21' } },
      { type: 'add_chore', payload: { title: 'Mow lawn', assignedTo: 'Leo' } },
    ];
    const events: Record<string, unknown>[] = [];
    const chores: Record<string, unknown>[] = [];
    for (const a of actions) {
      if (a.type === 'create_event') {
        const built = buildEventFromPayload(a.payload, 'cop', FAM, today);
        if (built) events.push({ ...built, ...STAMP });
      } else if (a.type === 'add_chore') {
        for (const c of buildChoresFromPayload(a.payload, FAM)) chores.push({ ...c, ...STAMP });
      }
    }
    expect(events[0]).toMatchObject({ title: 'Game', createdByEmail: 'a@b.c', createdByUserId: 'u1' });
    expect(chores[0]).toMatchObject({ title: 'Mow lawn', createdByEmail: 'a@b.c', createdByUserId: 'u1' });
  });

  it('a signed-out stamp ({}) leaves built records with no authorship keys', () => {
    // authorStamp() returns {} when googleUser is null (App.tsx:192-196) — best-effort, never gates creation.
    const empty: Partial<Authored> = {};
    const evt = { ...buildEventFromPayload({ title: 'X', start: '2026-06-20' }, 'cop', FAM, '2026-06-19'), ...empty };
    expect(evt).not.toHaveProperty('createdByEmail');
    expect(evt).not.toHaveProperty('createdByUserId');
    expect(evt).not.toHaveProperty('createdAt');

    const shopItem = { ...normalizeShoppingItems([{ text: 'Milk' }], STORES)[0], ...empty };
    expect(shopItem).not.toHaveProperty('createdByEmail');

    const chore = { ...buildChoresFromPayload({ title: 'Sweep', assignedTo: 'Leo' }, FAM)[0], ...empty };
    expect(chore).not.toHaveProperty('createdByUserId');
  });
});
