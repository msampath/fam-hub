// Shared shape for the `family_data` blob store: one row per (household_id, data_key), `data` = the
// whole collection as a JSONB array. Both writers — the browser client (src/supabase.ts) and the Node
// MCP server (src/mcp/persistence.ts) — build the upsert row + conflict target through here so the row
// shape can't drift between them (e.g. if a column is added/renamed). Pure; no browser/Node deps.
export const FAMILY_DATA_CONFLICT = 'household_id,data_key';

export function familyDataRow(householdId: string, dataKey: string, data: any[]) {
  return { household_id: householdId, data_key: dataKey, data, updated_at: new Date().toISOString() };
}
