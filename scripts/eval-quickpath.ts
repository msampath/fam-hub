// Quick-path eval runner (KAGGLE_EVAL: eval harness). Replays the golden prompts through the REAL
// /api/copilot pipeline — live model calls, real FACTS harness, real critic + sanitizers — and scores
// each response with the pure scorers in src/utils/evalScorers.ts.
//
//   npx tsx scripts/eval-quickpath.ts            # Gemini baseline (validates the harness itself)
//   npx tsx scripts/eval-quickpath.ts --local    # gpt-oss:20b first via Ollama (Decision A numbers)
//   npm run eval / npm run eval:local
//
// Self-contained: spawns its OWN server in appliance mode (STORAGE=sqlite, throwaway DB, box
// passphrase) on an eval-only port, so no Supabase and no interference with a dev server. The
// spawned server inherits .env (Gemini + Maps keys) via the repo's dotenv load. Results land in
// eval-results/ (git-ignored by the allow-list .gitignore) and a summary table prints to stdout.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { QUICKPATH_GOLDENS, scoreGolden, summarize, decisionA, type GoldenScore, type EvalSummary } from '../src/utils/evalScorers';

const LOCAL = process.argv.includes('--local');
const MODE = LOCAL ? 'local(gpt-oss:20b)' : 'gemini-baseline';
const PORT = 4899;
const BASE = `http://localhost:${PORT}`;
const DB = 'eval-results/eval-tmp.db';
const PASS = 'eval-harness-passphrase';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const todayISO = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
};

async function waitForServer(timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`${BASE}/api/config`); if (r.status < 500) return; } catch { /* not up yet */ }
    await sleep(750);
  }
  throw new Error(`server did not come up on :${PORT} within ${timeoutMs}ms`);
}

async function main() {
  mkdirSync('eval-results', { recursive: true });
  try { rmSync(DB); } catch { /* fresh db per run */ }
  try { rmSync(DB + '-journal'); } catch { /* ditto */ }

  // Refuse to run against a stale server: a previous run's child that outlived its parent (Windows
  // kills the npx shim, not the node child) would silently serve the WRONG env/model.
  try {
    await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(1500) });
    throw new Error(`port :${PORT} already serving — kill the stale eval server first (taskkill the node process on :${PORT})`);
  } catch (e: any) {
    if (String(e?.message || '').includes('already serving')) throw e; // real conflict → abort
    /* connection refused = port free, proceed */
  }

  console.log(`[eval] mode=${MODE} — spawning appliance-mode server on :${PORT}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(PORT),
    STORAGE: 'sqlite',
    SQLITE_PATH: DB,
    EMAIL_SCAN_DISABLED: 'true',
    AI_RATE_LIMIT_PER_MIN: '120',            // the eval is a burst of sequential calls
    COPILOT_HARNESS_ENABLED: 'true',
    COPILOT_MODEL: process.env.EVAL_COPILOT_MODEL || 'gemini-2.5-flash', // pin to the prod serving model for comparability
    LOCAL_LLM_ENABLED: LOCAL ? 'true' : 'false',
    ...(LOCAL ? { LOCAL_LLM_MODEL: process.env.LOCAL_LLM_MODEL || 'gpt-oss:20b', LOCAL_LLM_THINK: process.env.LOCAL_LLM_THINK || 'low', LOCAL_LLM_KEEP_ALIVE: '30m' } : {}),
  };
  // Force legacy AUTO mode (local-first when enabled → Gemini rescue). Must be an EMPTY STRING, not
  // deleted: the server's dotenv load restores a deleted var from .env (override=false only protects
  // vars that are PRESENT), which silently flipped us into explicit-chain mode where local is never
  // auto-prepended — found live as "0% served-by-local".
  env.GEMINI_FALLBACKS = '';

  const server: ChildProcess = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'server.ts'], {
    env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
  });
  server.stdout?.on('data', d => { const s = String(d); if (/booted|error/i.test(s)) process.stdout.write(`[server] ${s}`); });
  server.stderr?.on('data', d => process.stderr.write(`[server:err] ${String(d).slice(0, 400)}`));

  try {
    await waitForServer(60000);

    // Mint a box session (first-run setup; falls back to login when the DB already has the passphrase).
    let auth = await fetch(`${BASE}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: PASS }) });
    if (!auth.ok) auth = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: PASS }) });
    if (!auth.ok) throw new Error(`auth failed: ${auth.status} ${await auth.text()}`);
    const { token } = await auth.json() as { token: string };

    const today = todayISO();
    // A small, stable household context — same shape the client posts (Sammamish home = grounded FACTS).
    const body = {
      events: [
        { id: 'ev-1', title: 'Ava soccer practice', start: today, startTime: '16:00', endTime: '17:00', category: 'Sports', ageGroup: 'All ages', members: ['Ava'] },
        { id: 'ev-2', title: 'Dentist — Max', start: today, category: 'Other', ageGroup: 'All ages', members: ['Max'] },
      ],
      familyMembers: [{ name: 'You' }, { name: 'Ava', age: 8 }, { name: 'Max', age: 5 }],
      home: { homeLat: 47.6163, homeLng: -122.0356, homeLabel: 'Sammamish, WA' },
    };

    const scores: GoldenScore[] = [];
    for (const g of QUICKPATH_GOLDENS) {
      const t0 = Date.now();
      try {
        const r = await fetch(`${BASE}/api/copilot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ ...body, prompt: g.prompt }),
        });
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (!r.ok) {
          scores.push({ id: g.id, ok: false, servedBy: `http-${r.status}`, usedFallback: false, failures: [`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`] });
          console.log(`  ✗ ${g.id} — HTTP ${r.status} (${secs}s)`);
          continue;
        }
        const res = await r.json();
        const s = scoreGolden(g, res, today);
        scores.push(s);
        console.log(`  ${s.ok ? '✓' : '✗'} ${g.id} — ${s.servedBy}${s.usedFallback ? ' (fallback)' : ''} (${secs}s)${s.ok ? '' : ' — ' + s.failures.join('; ')}`);
      } catch (e: any) {
        scores.push({ id: g.id, ok: false, servedBy: 'error', usedFallback: false, failures: [String(e?.message || e).slice(0, 160)] });
        console.log(`  ✗ ${g.id} — ${String(e?.message || e).slice(0, 120)}`);
      }
    }

    const summary = summarize(MODE, scores);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = `eval-results/quickpath-${LOCAL ? 'local' : 'gemini'}-${stamp}.json`;
    writeFileSync(outPath, JSON.stringify(summary, null, 2));

    const cats = Object.entries(summary.byCategory).map(([c, v]) => `${c} ${v.passed}/${v.total}`).join(' · ');
    console.log(`\n[eval] ${MODE}: ${summary.passed}/${summary.total} passed (${(summary.passRate * 100).toFixed(0)}%) — ${cats}`
      + (LOCAL ? ` · served-by-local ${(summary.localServeRate * 100).toFixed(0)}%` : '')
      + `\n[eval] report: ${outPath}`);
    if (LOCAL) {
      // Compare against the most recent Gemini baseline report on disk (same golden set).
      let baseline: EvalSummary | null = null;
      const base = readdirSync('eval-results').filter(f => f.startsWith('quickpath-gemini-')).sort().pop();
      if (base) baseline = JSON.parse(readFileSync(`eval-results/${base}`, 'utf8'));
      const gate = decisionA(summary, baseline);
      console.log(`[eval] baseline: ${base || 'none found'}${baseline ? ` (${(baseline.passRate * 100).toFixed(0)}%)` : ''}`);
      console.log(`[eval] DECISION A (scope+safety perfect · overall within 10pts of baseline · ≥90% local-served): ${gate.pass ? 'PASS' : 'FAIL'}`);
      for (const r of gate.reasons) console.log(`        - ${r}`);
      process.exitCode = gate.pass ? 0 : 1;
    } else {
      process.exitCode = summary.passRate >= 0.6 ? 0 : 1; // baseline run: harness sanity, not a quality gate
    }
  } finally {
    // Windows: server.kill() only kills the npx shim; taskkill /T fells the whole tree (found live —
    // a surviving child served the next run with stale env).
    if (process.platform === 'win32' && server.pid) spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    else server.kill();
    await sleep(500);
  }
}

main().catch(e => { console.error('[eval] fatal:', e); process.exitCode = 2; });
