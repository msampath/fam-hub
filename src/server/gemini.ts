import { GoogleGenAI, Type } from '@google/genai';
import type { Response } from 'express';
import { geminiSchemaToJsonSchema } from '../utils/llmSchema';
import {
  parseGeminiJSON, repairTruncatedJson, isTextOnlyContents, contentsToText,
  isTransientError, isRecoverableError, orderFallbackModels, isLikelyTextModel,
  resolveFallbackChain, isLocalToken, buildAttemptChain,
} from './llmHelpers';

// Initialize GoogleGenAI SDK in accordance with system skills
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

/**
 * Clean up HTML to extract readable text while shrinking token counts.
 */
export function cleanHTML(html: string): string {
  let clean = html;
  clean = clean.replace(/<head[\s\S]*?<\/head>/gi, '');
  clean = clean.replace(/<script[\s\S]*?<\/script>/gi, '');
  clean = clean.replace(/<style[\s\S]*?<\/style>/gi, '');
  clean = clean.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  clean = clean.replace(/<path[\s\S]*?<\/path>/gi, '');
  clean = clean.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');

  // Format list items and rows nicely as lines
  clean = clean.replace(/<\/div>/gi, '\n');
  clean = clean.replace(/<\/tr>/gi, '\n');
  clean = clean.replace(/<\/p>/gi, '\n');
  clean = clean.replace(/<li>/gi, '\n - ');
  clean = clean.replace(/<br\s*\/?>/gi, '\n');

  // Wipe out all other HTML elements
  clean = clean.replace(/<[^>]+>/g, ' ');

  // Collapse whitespace
  clean = clean.replace(/[ \t]+/g, ' ');
  clean = clean.replace(/\n\s*\n/g, '\n');

  // Limit to avoid excessive prompt lengths
  if (clean.length > 40000) {
    clean = clean.substring(0, 40000) + '\n... [Content Truncated for token optimization]';
  }
  return clean.trim();
}

// Single source for the PRIMARY model id. ONE knob `COPILOT_MODEL` powers BOTH engine tiers (this Express
// quick-path + the ADK agent); `GEMINI_MODEL` is kept only as a legacy per-tier override. Default is the
// settled serving model (off the 503-prone gemini-3.5-flash).
const GEMINI_MODEL = process.env.COPILOT_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Optional PINNED fallback chain (comma-separated model ids). When set, it is used VERBATIM
// instead of API auto-discovery — auto-discovery (ai.models.list) can surface image/TTS/music
// models that advertise generateContent, so a pinned chain of known-good text models is safer.
// `node scripts/list-models.mjs` lists models the key can reach.
const GEMINI_FALLBACKS = (process.env.GEMINI_FALLBACKS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ── Local model (Ollama) — optional PRIMARY, no quota wall ──────────────────────
// When LOCAL_LLM_ENABLED, callGeminiJSON tries the local model FIRST for text-only prompts and
// falls back to the existing Gemini chain on any failure. This removes the free-tier-quota
// limiter at the source. Multimodal prompts (e.g. /api/parse-pdf image
// parts) stay on Gemini — the local models are text-only. One flag → trivial rollback.
const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v || '');
const LOCAL_LLM_ENABLED = truthy(process.env.LOCAL_LLM_ENABLED);
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || 'http://localhost:11434';
const LOCAL_LLM_MODEL = process.env.LOCAL_LLM_MODEL || 'gpt-oss:20b'; // default local Ollama model; override via LOCAL_LLM_MODEL
// `think`: omit when unset (passing it to a non-thinking model errors); a BOOLEAN for thinking
// models (qwen3.x); or a reasoning-effort LEVEL "low"|"medium"|"high" for gpt-oss:20b.
const LOCAL_LLM_THINK: boolean | string | undefined = (() => {
  const raw = process.env.LOCAL_LLM_THINK;
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  return /^(low|medium|high)$/.test(v) ? v : truthy(v);
})();
const LOCAL_LLM_NUM_CTX = Number(process.env.LOCAL_LLM_NUM_CTX) || undefined;
const LOCAL_LLM_TIMEOUT_MS = Number(process.env.LOCAL_LLM_TIMEOUT_MS) || 120000;
// How long Ollama keeps the model resident after a request (e.g. "30m", "-1" = forever). Avoids a
// slow COLD reload of a big model on every idle gap (the default is 5m). Omitted → Ollama default.
const LOCAL_LLM_KEEP_ALIVE = process.env.LOCAL_LLM_KEEP_ALIVE || '';
// Optional bearer auth for the Ollama endpoint — unused by a plain local server (it ignores the
// header), but lets the same code talk to an authenticated/hosted Ollama (e.g. ollama.com) by
// setting LOCAL_LLM_API_KEY or reusing an existing OLLAMA_API_KEY.
const LOCAL_LLM_API_KEY = process.env.LOCAL_LLM_API_KEY || process.env.OLLAMA_API_KEY || '';

// Call the local Ollama model via its /api/chat endpoint with constrained JSON output. The
// canonical @google/genai response schema is converted to plain JSON Schema for Ollama's `format`.
// Reuses parseGeminiJSON so a truncated/garbage local response is tagged malformedResponse, the
// same as Gemini. Bounded by an AbortController timeout so a hung local box can't stall the request.
// localOpts: per-CALL overrides for the LOCAL slot only (Phase-3 weak-model treatments) — a scan can
// cap the local budget + force THINK=low without touching the cloud call's genConfig or the global env.
type LocalSlotOpts = { maxOutputTokens?: number; think?: boolean | string };

async function callOllamaJSON(
  contents: any,
  systemInstruction: string,
  responseSchema: any,
  emptyFallback: string,
  genConfig: Record<string, any>,
  localOpts?: LocalSlotOpts,
): Promise<any> {
  const options: Record<string, any> = { num_predict: localOpts?.maxOutputTokens ?? 8192 };
  if (typeof genConfig.temperature === 'number') options.temperature = genConfig.temperature;
  if (LOCAL_LLM_NUM_CTX) options.num_ctx = LOCAL_LLM_NUM_CTX;

  const body: any = {
    model: LOCAL_LLM_MODEL,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: contentsToText(contents) },
    ],
    format: geminiSchemaToJsonSchema(responseSchema),
    stream: false,
    options,
  };
  // Only send `think` when explicitly configured — passing it to a non-thinking model errors.
  const think = localOpts?.think !== undefined ? localOpts.think : LOCAL_LLM_THINK;
  if (think !== undefined) body.think = think;
  // Keep the model warm so an idle gap doesn't trigger a slow cold reload (→ latency/abort → "all busy").
  if (LOCAL_LLM_KEEP_ALIVE) body.keep_alive = LOCAL_LLM_KEEP_ALIVE;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LOCAL_LLM_TIMEOUT_MS);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (LOCAL_LLM_API_KEY) headers['Authorization'] = `Bearer ${LOCAL_LLM_API_KEY}`;
  try {
    const res = await fetch(`${LOCAL_LLM_URL}/api/chat`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const e: any = new Error(`Ollama HTTP ${res.status}: ${t.slice(0, 200)}`);
      e.status = res.status;
      throw e;
    }
    const data: any = await res.json();
    return parseGeminiJSON(data?.message?.content || emptyFallback);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Discover generateContent-capable models from the API (cached) — used ONLY as a fallback
// when the primary is transiently unavailable, so we never hardcode/guess fallback model ids.
let cachedFallbackModels: string[] | null = null;
async function discoverFallbackModels(): Promise<string[]> {
  if (cachedFallbackModels) return cachedFallbackModels;
  const found: string[] = [];
  try {
    const pager = await ai.models.list({ config: { queryBase: true } });
    for await (const m of pager) {
      const name = (m.name || '').replace(/^models\//, '');
      // Capability check AND a name filter — a model can list generateContent yet be an
      // image/TTS/etc. family that would garble a JSON prompt.
      if ((m.supportedActions || []).includes('generateContent') && isLikelyTextModel(name)) {
        found.push(name);
      }
    }
  } catch (err: any) {
    console.error('Could not list Gemini models for fallback:', err?.message || err);
  }
  // Cache ONLY a successful, non-empty discovery. A transient list() failure (the catch above) leaves
  // found=[]; caching that would permanently disable the fallback chain for the process lifetime — so
  // return [] WITHOUT caching, and the next outage re-attempts discovery.
  if (found.length) { cachedFallbackModels = orderFallbackModels(found); return cachedFallbackModels; }
  return [];
}

// Shared response schema for the three calendar-extraction endpoints (URL/PDF/text),
// which previously duplicated it verbatim.
export const CALENDAR_EVENT_SCHEMA = {
  type: Type.ARRAY,
  description: "List of extracted calendar events",
  items: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "Display title of the activity or school event." },
      start: { type: Type.STRING, description: "Start date or date-time in standard YYYY-MM-DD format (or YYYY-MM-DDTHH:mm:00)" },
      end: { type: Type.STRING, description: "End date or date-time in standard YYYY-MM-DD format (optional)" },
      description: { type: Type.STRING, description: "Detailed summary, cost, eligibility, or registration details." },
      location: { type: Type.STRING, description: "School building, park address, online, or location name." },
      category: { type: Type.STRING, description: "Category of activity: School, Camp, Sports, Arts, Holiday, or Other" },
      ageGroup: { type: Type.STRING, description: "Age or grade range if available. Otherwise use 'All ages'." }
    },
    required: ["title", "start"]
  }
};

/**
 * Shared Gemini JSON call with resilience to transient overload (the Gemini 503/UNAVAILABLE
 * "high demand" error). It (1) retries the primary model with exponential backoff, then
 * (2) if the primary stays unavailable, discovers other available models from the API and
 * tries them (any that answers wins). `meta` (optional) reports which model answered and
 * whether a fallback was used, so a caller can tell the user. Safe to retry: every caller is
 * a pure read/generate — none mutate Google/Supabase (those writes happen client-side after).
 * `emptyFallback` matches each caller's prior default ('[]' for arrays, '{}' for objects).
 */
export async function callGeminiJSON(
  contents: any,
  systemInstruction: string,
  responseSchema: any,
  emptyFallback: string = '[]',
  meta?: { model?: string; usedFallback?: boolean },
  genConfig: Record<string, any> = {},
  // Weak-model routing knobs (Phase-3): requireCloud skips the local slot entirely (OCR/revise-draft
  // accept-risk surfaces); local overrides the local slot's output budget / think level (email scans).
  opts: { requireCloud?: boolean; local?: LocalSlotOpts } = {},
): Promise<any> {
  const run = async (model: string) => {
    // `config: any` so caller-supplied genConfig (temperature / frequency+presence penalties)
    // merges cleanly past the SDK's strict type. maxOutputTokens caps a repetition-loop runaway
    // (truncates → parse-fails → treated as RECOVERABLE → retry/fallback); genConfig is where a
    // caller adds anti-repetition sampling for free-text-heavy prompts (e.g. the copilot).
    const config: any = { systemInstruction, responseMimeType: 'application/json', responseSchema, maxOutputTokens: 8192, ...genConfig };
    // On a malformed/looped JSON response (the model IS available — it answered), recover WITHOUT demoting,
    // cheapest step first:
    //   1. REPAIR the raw (FREE — no API call): salvages the complete `reply` + good fields, dropping only a
    //      runaway field that downstream validation would drop anyway.
    //   2. If repair can't salvage it, RETRY the SAME model once (fresh sampling) — then repair THAT too.
    //   3. Only if both attempts are malformed AND unrepairable do we throw → the chain advances to the next
    //      model. A 503/429/network error is NEVER retried here — it propagates immediately so the chain
    //      advances (respects the owner's rate budget / single-attempt-per-entry discipline below).
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await ai.models.generateContent({ model, contents, config });
      const raw = response.text || emptyFallback;
      try {
        return parseGeminiJSON(raw);
      } catch (err: any) {
        if (!err?.malformedResponse) throw err;     // genuine API/transport error → let the chain advance
        const repaired = repairTruncatedJson(raw);  // (1) free repair FIRST, before spending another call
        if (repaired != null) return repaired;
        if (attempt === 1) throw err;               // (3) retry already spent + still unrepairable → advance
        // (2) else: loop → retry the SAME model once, then repair that response too
      }
    }
    throw new Error('unreachable');                 // TS terminal (the loop always returns or throws)
  };

  // ── EXPLICIT CHAIN MODE (GEMINI_FALLBACKS set) ──────────────────────────────────
  // Fully deterministic: try [GEMINI_MODEL, ...GEMINI_FALLBACKS] in EXACT order, no
  // auto-discovery. A `local`/`ollama` entry runs the local Ollama model AT THAT POSITION
  // (skipped for PDF/non-text prompts or when LOCAL_LLM_ENABLED is off — it is NOT auto-prepended
  // in this mode, so the chain is exactly what's configured). A 503/429/network failure does NOT
  // retry the same entry — it advances to the next (rate-budget-friendly; that's what the chain is
  // for). The ONE exception is a MALFORMED-but-unrepairable JSON response, where run() re-rolls the
  // SAME model once (after a free repair attempt) before advancing — see run() above. usedFallback
  // is true whenever the answer didn't come from the first entry.
  if (GEMINI_FALLBACKS.length) {
    const chain = buildAttemptChain(GEMINI_MODEL, GEMINI_FALLBACKS);
    let lastErr: any;
    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i];
      if (isLocalToken(entry)) {
        if (opts.requireCloud || !LOCAL_LLM_ENABLED || !isTextOnlyContents(contents)) continue; // cloud-only / local off / multimodal → skip this slot
        try {
          const data = await callOllamaJSON(contents, systemInstruction, responseSchema, emptyFallback, genConfig, opts.local);
          if (meta) { meta.model = `ollama:${LOCAL_LLM_MODEL}`; meta.usedFallback = i > 0; }
          return data;
        } catch (err: any) {
          lastErr = err;
          console.warn(`Local model "${LOCAL_LLM_MODEL}" unavailable (${err?.message || err}); continuing chain.`);
          continue;
        }
      }
      try {
        const data = await run(entry); // advances on 503/429; retries the SAME model only on malformed JSON (run())
        if (meta) { meta.model = entry; meta.usedFallback = i > 0; }
        if (i > 0) console.warn(`Gemini "${GEMINI_MODEL}" unavailable; answered with chain model "${entry}".`);
        return data;
      } catch (err) {
        lastErr = err; // any failure → advance to the next chain entry
      }
    }
    throw lastErr; // whole explicit chain exhausted
  }

  // ── LEGACY AUTO MODE (no GEMINI_FALLBACKS) ──────────────────────────────────────
  // 0) Local model FIRST (no quota wall), for text-only prompts — auto-tried first so the default
  // config bypasses the quota wall with zero chain config. ANY failure falls through to Gemini.
  if (!opts.requireCloud && LOCAL_LLM_ENABLED && isTextOnlyContents(contents)) {
    try {
      const data = await callOllamaJSON(contents, systemInstruction, responseSchema, emptyFallback, genConfig, opts.local);
      if (meta) { meta.model = `ollama:${LOCAL_LLM_MODEL}`; meta.usedFallback = false; }
      return data;
    } catch (err: any) {
      console.warn(`Local model "${LOCAL_LLM_MODEL}" unavailable (${err?.message || err}); falling back to Gemini.`);
    }
  }

  let lastErr: any;
  // 1) Primary model — up to 3 attempts with exponential backoff + jitter.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await run(GEMINI_MODEL);
      if (meta) { meta.model = GEMINI_MODEL; meta.usedFallback = false; }
      return data;
    } catch (err) {
      lastErr = err;
      if (!isRecoverableError(err)) throw err; // truly fatal (bad request/auth/schema) → don't burn retries/fallbacks
      if (attempt < 2) await sleep(400 * 2 ** attempt + Math.floor(Math.random() * 250));
    }
  }

  // 2) Primary still unavailable → API-discovered models (name-filtered + ordered); first wins.
  const discovered = await discoverFallbackModels();
  const fallbacks = resolveFallbackChain([], discovered, GEMINI_MODEL);
  for (const model of fallbacks) {
    try {
      const data = await run(model);
      if (meta) { meta.model = model; meta.usedFallback = true; }
      console.warn(`Gemini primary "${GEMINI_MODEL}" unavailable; answered with fallback "${model}".`);
      return data;
    } catch (err) {
      lastErr = err; // try the next available model
    }
  }
  throw lastErr; // primary + all fallbacks exhausted
}

// Uniform error response for the AI endpoints. A total AI outage (every model overloaded /
// network down — i.e. a TRANSIENT error survived all retries + fallbacks) is reported as a
// 503 with `retryable: true` so the client can degrade clearly-but-non-blocking ("AI is busy —
// add it manually") instead of treating it like a hard 500. Fatal errors stay 500. Calendar,
// chores and shopping all work without AI, so a 503 never blocks the app — it just steers to
// manual entry / Paste-Text. (Graceful degradation when AI is down.)
export function aiErrorResponse(res: Response, err: any, fallbackMsg: string) {
  if (isTransientError(err)) {
    return res.status(503).json({
      error: 'The AI service is busy right now — try again in a moment, or add it manually.',
      retryable: true,
    });
  }
  // F-06: don't leak the raw exception/upstream text to the client — return the generic fallback. Every
  // caller already console.error's the detail with context (and we log here too, so it can't be lost).
  console.error('AI endpoint error (returned generic to client):', err?.message || err);
  return res.status(500).json({ error: fallbackMsg });
}
