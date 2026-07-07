import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ACTION_CONTRACT, COPILOT_ACTIONS, MUTATING_TOOLS, selectorSatisfied, CONTRACT_JSON,
} from '../mcp/actionContract';
import { TOOL_REGISTRY, ALLOWED_COPILOT_ACTIONS } from '../utils/toolRegistry';

// The shared ACTION_CONTRACT is the single source of truth for the allowlist, risk tiers, the mutating
// set, and the server-side selector gate. These tests pin every derivation + the Python mirror's freshness.

describe('action contract ↔ Tool Registry parity', () => {
  it('TOOL_REGISTRY registers EXACTLY the client-applied actions in the contract', () => {
    expect(Object.keys(TOOL_REGISTRY).sort()).toEqual([...COPILOT_ACTIONS].sort());
    // and ALLOWED_COPILOT_ACTIONS is the same derived list
    expect([...ALLOWED_COPILOT_ACTIONS].sort()).toEqual([...COPILOT_ACTIONS].sort());
  });
  it('each registered tool inherits its risk tier + apply mode from the contract (no drift)', () => {
    for (const [name, tool] of Object.entries(TOOL_REGISTRY)) {
      const tier = ACTION_CONTRACT[name as keyof typeof ACTION_CONTRACT].tier;
      expect(tool.riskTier).toBe(tier);
      expect(tool.applyMode).toBe(tier === 'auto' ? 'auto' : 'confirm');
    }
  });
  it('MUTATING_TOOLS covers the agent-only writers and excludes the honest IoT stub', () => {
    expect(MUTATING_TOOLS).toContain('prepare_handoff'); // MCP-only, still a bar action
    expect(MUTATING_TOOLS).toContain('suggest_event');   // MCP-only tap-to-add chip
    expect(MUTATING_TOOLS).not.toContain('home_control'); // unavailable stub, never mutates
  });
  it('MCP-only tools are NOT in the client allowlist', () => {
    for (const t of ['prepare_handoff', 'suggest_event', 'home_control']) {
      expect(COPILOT_ACTIONS).not.toContain(t);
    }
  });
});

describe('selectorSatisfied — the server-side required-reference gate', () => {
  it('no-selector actions always pass', () => {
    for (const t of ['create_event', 'add_chore', 'add_shopping_item', 'clear_chores']) {
      expect(selectorSatisfied(t, {})).toBe(true);
    }
  });
  it('id-or-title actions need a reference', () => {
    expect(selectorSatisfied('delete_event', { title: 'Zoo' })).toBe(true);
    expect(selectorSatisfied('delete_event', { id: 'e1' })).toBe(true);
    expect(selectorSatisfied('delete_event', {})).toBe(false);
    expect(selectorSatisfied('delete_chore', { title: '  ' })).toBe(false); // blank title doesn't count
  });
  it('id-or-matchTitle actions (update_event / update_chore)', () => {
    expect(selectorSatisfied('update_event', { matchTitle: 'Soccer' })).toBe(true);
    expect(selectorSatisfied('update_event', {})).toBe(false);
    expect(selectorSatisfied('update_chore', { id: 'c1' })).toBe(true);
  });
  it('set_goal needs text; delete_goal needs id or all:true', () => {
    expect(selectorSatisfied('set_goal', { text: 'Plan a trip' })).toBe(true);
    expect(selectorSatisfied('set_goal', { text: '   ' })).toBe(false);
    expect(selectorSatisfied('delete_goal', { id: 'g1' })).toBe(true);
    expect(selectorSatisfied('delete_goal', { all: true })).toBe(true);
    expect(selectorSatisfied('delete_goal', { all: false })).toBe(false);
    expect(selectorSatisfied('delete_goal', {})).toBe(false);
  });
  it('set_meal_plan needs a non-empty days[]; delete_meal_plan needs meal/weekStart/all', () => {
    expect(selectorSatisfied('set_meal_plan', { days: [{ date: '2026-06-22', dish: 'Dal' }] })).toBe(true);
    expect(selectorSatisfied('set_meal_plan', { days: [] })).toBe(false);
    expect(selectorSatisfied('set_meal_plan', {})).toBe(false);
    expect(selectorSatisfied('delete_meal_plan', { meal: 'lunch' })).toBe(true);
    expect(selectorSatisfied('delete_meal_plan', { weekStart: '2026-06-22' })).toBe(true);
    expect(selectorSatisfied('delete_meal_plan', { all: true })).toBe(true);
    expect(selectorSatisfied('delete_meal_plan', {})).toBe(false);
  });
  it('pantry: add takes anything (none), delete needs id or text', () => {
    expect(selectorSatisfied('add_pantry_item', {})).toBe(true);
    expect(selectorSatisfied('delete_pantry_item', { text: 'rice' })).toBe(true);
    expect(selectorSatisfied('delete_pantry_item', { id: 'pantry-1' })).toBe(true);
    expect(selectorSatisfied('delete_pantry_item', {})).toBe(false);
  });
  it('reserve/add_to_cart/doc tools', () => {
    expect(selectorSatisfied('reserve', { title: 'Cafe Flora' })).toBe(true);
    expect(selectorSatisfied('reserve', {})).toBe(false);
    expect(selectorSatisfied('add_to_cart', { text: 'AA batteries' })).toBe(true);
    expect(selectorSatisfied('add_to_cart', { title: 'AA batteries' })).toBe(true);
    expect(selectorSatisfied('add_to_cart', {})).toBe(false);
    expect(selectorSatisfied('move_document', { name: 'Lease' })).toBe(true);
    expect(selectorSatisfied('delete_document', { id: 'd1' })).toBe(true);
    expect(selectorSatisfied('delete_document', {})).toBe(false);
  });
  it('unknown types fail closed', () => {
    expect(selectorSatisfied('drop_database', { id: 'x' })).toBe(false);
  });
});

describe('Python mirror (agent/concierge/action_contract.json) is in lockstep', () => {
  it('the committed JSON byte-matches CONTRACT_JSON — run `npm run gen:contract` if this fails', () => {
    const path = fileURLToPath(new URL('../../agent/concierge/action_contract.json', import.meta.url));
    const committed = readFileSync(path, 'utf-8');
    expect(committed).toBe(CONTRACT_JSON);
  });
  it('the mirror derives the SAME mutating set the TS side computes', () => {
    const path = fileURLToPath(new URL('../../agent/concierge/action_contract.json', import.meta.url));
    const mirror = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, { mutating: boolean }>;
    const mirrorMutating = Object.entries(mirror).filter(([, s]) => s.mutating).map(([n]) => n).sort();
    expect(mirrorMutating).toEqual([...MUTATING_TOOLS].sort());
  });
});
