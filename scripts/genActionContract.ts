// Regenerate the Python-side mirror of the action contract: agent/concierge/action_contract.json.
//
// The TS module src/mcp/actionContract.ts is the single source of truth; the Python agent runtime image
// ships `agent/` but NOT `src/`, so Python reads this committed JSON derivation instead of the .ts. Run
// `npm run gen:contract` after editing the contract; the freshness test (actionContract.test.ts) fails CI
// if the committed JSON drifts from CONTRACT_JSON.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CONTRACT_JSON } from '../src/mcp/actionContract';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'agent', 'concierge', 'action_contract.json');
writeFileSync(out, CONTRACT_JSON, 'utf-8');
console.log(`wrote ${out} (${CONTRACT_JSON.length} bytes)`);
