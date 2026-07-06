// Voice-bridge PoC — the smallest possible "voice assistant" client for the LAN appliance: prove an
// utterance can drive the REAL concierge path (Express proxy → ADK agent → MCP tools → tier-gated
// actions) with nothing but the box's own passphrase login. This is step 1 of docs/voice-assistants.md —
// any real bridge (a Home Assistant integration, an Alexa skill backend) makes exactly these two calls:
//   POST /api/auth/login  { passphrase }            → { token }   (box-signed session, server.ts)
//   POST /api/agent/chat  { message } + Bearer token → { reply, sessionId, actions[] }
//
//   node scripts/voice-bridge-poc.mjs "add milk to the shopping list"
//   BRIDGE_BASE=http://192.168.1.50:4894 BRIDGE_PASSPHRASE='our family phrase' node scripts/voice-bridge-poc.mjs
//
// Dependency-free (global fetch — Node ≥ 18; the appliance already requires ≥ 22.5). Needs a LIVE
// appliance-mode server (STORAGE=sqlite, passphrase set, agent up) — so it's a manual smoke test, not CI.

const HELP = `voice-bridge-poc — send one utterance through Family-Hub's real agent path.

Usage: node scripts/voice-bridge-poc.mjs [options] [utterance...]

  utterance             What "the voice assistant heard" (unquoted words are joined).
                        Default: "add milk to the shopping list"
Options:
  --base <url>          Appliance base URL   (or BRIDGE_BASE;       default http://localhost:4894)
  --passphrase <text>   Household passphrase (or BRIDGE_PASSPHRASE; required)
  --help                This text.

Auto-tier tools (add_shopping_item…) apply immediately; confirm/stepup results are STAGED —
they appear in the app's Approvals queue for a parent. Both show up in actions[] below.`;

function fail(msg) { console.error(`\nERROR: ${msg}`); process.exit(1); }

// Tiny argv parser: flags + every remaining token joins into the utterance, so quoting is optional.
function parseArgs(argv) {
  const out = { base: process.env.BRIDGE_BASE || 'http://localhost:4894', passphrase: process.env.BRIDGE_PASSPHRASE || '', words: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') { console.log(HELP); process.exit(0); }
    else if (argv[i] === '--base') out.base = argv[++i] || out.base;
    else if (argv[i] === '--passphrase') out.passphrase = argv[++i] || '';
    else out.words.push(argv[i]);
  }
  out.base = out.base.replace(/\/+$/, '');
  out.utterance = out.words.join(' ') || 'add milk to the shopping list';
  return out;
}

// POST JSON, parse defensively — the proxy passes upstream bodies through verbatim, so an unhappy
// path can hand back non-JSON text; never crash on the error path we're trying to report.
async function postJson(url, body, token) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch (err) {
    fail(`Could not reach ${url} — is the appliance up? (${err?.cause?.code || err?.message || err})`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body — report status + raw text below */ }
  return { status: res.status, json, text };
}

async function main() {
  const { base, passphrase, utterance } = parseArgs(process.argv.slice(2));
  if (!passphrase) fail('No passphrase. Pass --passphrase or set BRIDGE_PASSPHRASE. (--help for usage)');

  // 1) Passphrase → box-signed session token. This is the whole auth story a bridge needs: hold the
  //    token (30-day TTL); a passphrase change rotates the box secret and kills it → just log in again.
  console.log(`→ POST ${base}/api/auth/login`);
  const login = await postJson(`${base}/api/auth/login`, { passphrase });
  if (login.status === 401) fail('Incorrect passphrase.');
  if (login.status === 429) fail('Login rate-limited (8/min/IP) — wait a minute and retry.');
  if (login.status === 400) fail(`Server is not in appliance mode (STORAGE=sqlite): ${login.json?.error || login.text}`);
  if (login.status !== 200 || !login.json?.token) fail(`Login failed (HTTP ${login.status}): ${login.json?.error || login.text}`);
  console.log('✓ logged in (box session token)');

  // 2) Utterance → the same-origin agent proxy. First turn omits sessionId (matches src/utils/agentClient.ts);
  //    the reply carries one, which a persistent bridge would echo back for a multi-turn conversation.
  console.log(`→ POST ${base}/api/agent/chat  "${utterance}"`);
  const chat = await postJson(`${base}/api/agent/chat`, { message: utterance }, login.json.token);
  if (chat.status === 401) fail('Token rejected — the box secret may have rotated (passphrase change). Log in again.');
  if (chat.status === 429) fail(`AI rate limit: ${chat.json?.error || chat.text}`);
  if (chat.status >= 500) fail(`Agent unavailable (HTTP ${chat.status}): ${chat.json?.error || chat.text}\n`
    + 'Is the ADK agent running and AGENT_BASE_URL pointing at it?');
  if (chat.status !== 200) fail(`Chat failed (HTTP ${chat.status}): ${chat.json?.error || chat.text}`);

  const { reply, sessionId, actions } = chat.json || {};
  console.log(`\nreply${sessionId ? `  (sessionId ${sessionId})` : ''}:\n  ${String(reply || '(empty)').replace(/\n/g, '\n  ')}`);
  const acts = Array.isArray(actions) ? actions : [];
  console.log(`\nactions (${acts.length}):`);
  for (const [i, a] of acts.entries()) {
    // Bar-shaped action: { tool, status, tier, artifact, message } — status 'applied' = done (auto tier);
    // 'requires_confirmation' / 'requires_stepup' = staged in the Approvals queue for a parent.
    console.log(`  ${i + 1}. ${a.tool}  [${a.tier ?? '?'}/${a.status ?? '?'}]  ${a.message || ''}`);
    if (a.artifact !== undefined) console.log(`     artifact: ${JSON.stringify(a.artifact, null, 2).replace(/\n/g, '\n     ')}`);
  }
  if (!acts.length) console.log('  (none — a read-only turn, or the agent answered without tools)');
}

main();
