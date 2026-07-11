import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import compression from 'compression';
import helmet from 'helmet';
import path from 'path';
import { readFileSync, existsSync, promises as fsp } from 'node:fs';
import dotenv from 'dotenv';
import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'crypto';
import { Type } from '@google/genai';
import { createClient, type User } from '@supabase/supabase-js';
// NOTE: `vite` is imported DYNAMICALLY in the dev branch below (not here) so it can be a devDependency and
// stay out of the production runtime image — the dev middleware never loads in production.
import { buildCopilotPrompt, COPILOT_SYSTEM, COPILOT_HARNESS_SYSTEM, COPILOT_SCHEMA } from './src/utils/copilotPrompt';
import { buildHarnessUserPrompt, buildConversationBlock, buildMealsFacts, addDaysISO } from './src/utils/copilotHarness';
import { buildLocalKnowledgeFactsAsync } from './src/utils/localKnowledge';
import { verifyActions, buildCriticNote, verifyActionClaims, unbackedClaimCorrection } from './src/utils/copilotCritic';
import { verifyQuickAdd, buildQuickAddCriticNote, coerceQuickAdd } from './src/utils/quickAddCritic';
import {
  buildKrogerAuthUrl, authCodeTokenBody, refreshTokenBody, clientCredentialsBody,
  shapeLocations, shapeProductCandidates, buildMatchPrompt, validateMatchSelections, mergeMatchRetry,
  buildCartAddBody, KROGER_MATCH_SCHEMA, krogerSearchTerm, krogerFallbackTerm, type ProductCandidate,
} from './src/utils/krogerApi';
import { buildRevisePrompt } from './src/utils/reviseDraft';
import { validateExtractedEvents } from './src/utils/extractedEvents';
import { filterUnrequestedHolidayDeletes } from './src/utils/holidayGuard';
import { buildBriefing } from './src/utils/briefing';
import { MORNING_PLANNER_SYSTEM, buildMorningPlannerSchema, MORNING_GENCONFIG, buildMorningFacts, validateMorningProposals } from './src/utils/morningAgent';
import { sanitizeStoreList } from './src/constants';

// Household store routing for the shopping-AI prompts (Phase-5): name the family's exact lists, and
// keep the specialty/bulk hints ONLY when the default store names they refer to are actually present.
const storeRoutingLine = (stores: string[]): string => {
  const quoted = stores.map(s => `"${s}"`).join(', ');
  const hints = [
    stores.includes('Indian Store') ? 'Use "Indian Store" for Indian/South-Asian spices and specialty items.' : '',
    stores.includes('Costco') ? 'Use "Costco" for bulk staples.' : '',
    stores.includes('Grocery Store') ? 'Otherwise use "Grocery Store".' : '',
  ].filter(Boolean).join(' ');
  return `Assign each to the most likely store from exactly: ${quoted}.${hints ? ' ' + hints : ''}`;
};
import { CHORE_PLAN_STYLE_EXEMPLAR, sanitizeGeneratedChores } from './src/utils/chorePlan';
import { buildAvailabilityBlock } from './src/utils/availability';
import { buildLongWeekendBlock } from './src/utils/longWeekend';
import { buildWeatherFacts, isPlanningQuery } from './src/utils/weatherFacts';
import { buildHistoryFacts } from './src/utils/historyFacts';
import { buildPlacesFacts, indexedPlaces, parseDistanceConstraint, detectPlacesIntent, isPlacesQuery, flagHiddenGems, filterRecentlyVisited } from './src/utils/placesFacts';
import { buildEventsFacts, indexedEvents } from './src/utils/eventsFacts';
import { cleanHTML, callGeminiJSON, CALENDAR_EVENT_SCHEMA, aiErrorResponse } from './src/server/gemini';
import { fetchWithTimeout } from './src/server/fetchUtils';
import { LOCAL_MODE, STORAGE_MODE, IS_PRODUCTION, PORT } from './src/server/config';
import { requireAuth, aiRateLimit } from './src/server/middleware';
import { withinDataFetchQuota, fetchWeatherDaily, fetchAirQualityDaily, fetchPollenDaily, fetchNearbyPlaces, attachTravelTimes, fetchLocalEvents, parseUsZip } from './src/server/grounding';
import { runDailyDigest, startDigestScheduler, briefingToText, composeBriefingViaAgent } from './src/server/digest';
import { normalizeGmail, normalizeGraph, type NormalizedMessage } from './src/utils/email';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { hasUsableText } from './src/utils/pdfText';
import { buildBillQuery, billToSuggestion, buildBillParsePrompt, type ParsedBill } from './src/utils/bills';
import { buildNewsletterQuery, buildNewsletterClassifyPrompt } from './src/utils/newsletters';
import { buildPackageQuery, packageToSuggestion, buildPackageParsePrompt, type ParsedPackage } from './src/utils/packages';
import { buildKidsActivityQuery, activityToSuggestion, buildKidsActivityParsePrompt, type ParsedActivity } from './src/utils/kidsActivities';
// Single-click LAN appliance: local SQLite storage + local household auth (no Supabase). See src/storage/.
import { storageMode, getSqliteAdapter } from './src/storage';
import { handleDataGet, handleDataSave, handleDataLoadAll } from './src/storage/dataApi';
import { verifySession, signSession, newSession, isValidPassphrase } from './src/storage/localAuth';
import { getOrCreateHouseholdId, getSessionSecret, isHouseholdConfigured, setHouseholdPassphrase, checkHouseholdPassphrase, changeHouseholdPassphrase } from './src/storage/boxConfig';
// Async agent jobs (roadmap): the queued-turn rows behind /api/agent/chat-async + /api/agent/job/:id.
import { SqliteAgentJobStore, SupabaseAgentJobStore, lookupHouseholdId, type AgentJobStore } from './src/storage/agentJobs';
// Pure helpers extracted to src/server/ — imported for internal use, re-exported for test consumers.
import { checkRateWindow, pruneExpired } from './src/server/rateLimit';
import { parseGeminiJSON, repairTruncatedJson, isTextOnlyContents, contentsToText, isTransientError, isRecoverableError, orderFallbackModels, isLikelyTextModel, resolveFallbackChain, isLocalToken, buildAttemptChain } from './src/server/llmHelpers';
import { shiftIsoDate, filterUpcomingEvents, dedupeActions, ALLOWED_COPILOT_ACTIONS, sanitizeCopilotActions, sanitizeSuggestions, parseICS } from './src/server/copilotHelpers';
import type { GroundingFact } from './src/server/copilotHelpers';
import { hashStepUpPin, verifyStepUpPin, isValidPin, nextPinLockEntry } from './src/server/stepUpPin';
export { checkRateWindow, pruneExpired } from './src/server/rateLimit';
export { parseGeminiJSON, repairTruncatedJson, isTextOnlyContents, contentsToText, isTransientError, isRecoverableError, orderFallbackModels, isLikelyTextModel, resolveFallbackChain, isLocalToken, buildAttemptChain } from './src/server/llmHelpers';
export { shiftIsoDate, filterUpcomingEvents, dedupeActions, ALLOWED_COPILOT_ACTIONS, sanitizeCopilotActions, sanitizeSuggestions, parseICS } from './src/server/copilotHelpers';
export type { GroundingFact } from './src/server/copilotHelpers';
export { hashStepUpPin, verifyStepUpPin, isValidPin, nextPinLockEntry } from './src/server/stepUpPin';
export { parseUsZip } from './src/server/grounding';

dotenv.config();

// Type req.user (set by requireAuth) via Express declaration merging, so call sites use a typed
// `req.user` instead of `req.user`.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: User; householdId?: string } // householdId set by requireAuth (local mode → session; cloud → Supabase)
  }
}

export const app = express(); // exported so the auth/data routes are testable via supertest (startServer is VITEST-gated)
// Config (LOCAL_MODE, STORAGE_MODE, IS_PRODUCTION, PORT) → src/server/config.ts

// gzip responses (the static bundle + JSON). Without this the ~580 kB bundle ships uncompressed
// over the LAN — the "160 kB gzip" only happens if the server actually gzips. Big win for the
// always-on tablet / phones over Wi-Fi.
app.use(compression());

if (!LOCAL_MODE) app.set('trust proxy', 1);

// Security headers (CSO F-05). helmet adds X-Content-Type-Options, Referrer-Policy, HSTS (https only),
// frame protection, etc. The CSP (prod only) caps XSS blast radius: scripts/styles/connections are
// pinned to self + Supabase; no inline/eval scripts (the Vite build emits none — verified in
// dist/index.html); images allow Google avatars + data URIs.
const supaUrl = process.env.VITE_SUPABASE_URL || '';
const supaConnect = supaUrl ? [supaUrl, supaUrl.replace(/^http/, 'ws')] : []; // https→wss for realtime
// The prod static serve injects ONE inline script — the runtime web config (see the static-serve block:
// "build once, deploy anywhere"). Allow exactly that script by CSP hash; everything else stays inline-free.
// The content is env-derived and fixed for the process lifetime, and the injection site uses this SAME
// constant, so the hash can never drift from what's served. Without this, script-src 'self' blocks the
// injection and a prebuilt image (no baked VITE_*) can't reach Supabase at all.
const APP_CONFIG_SCRIPT = `window.__APP_CONFIG__=${JSON.stringify({
  supabaseUrl: process.env.VITE_SUPABASE_URL || '',
  supabaseAnonKey: process.env.VITE_SUPABASE_ANON_KEY || '',
}).replace(/</g, '\\u003c')}`;
const APP_CONFIG_SCRIPT_SHA256 = `'sha256-${createHash('sha256').update(APP_CONFIG_SCRIPT).digest('base64')}'`;
app.use(helmet({
  contentSecurityPolicy: IS_PRODUCTION ? {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", APP_CONFIG_SCRIPT_SHA256],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], // + Google Fonts (Space Grotesk) stylesheet
      imgSrc: ["'self'", 'data:', 'https:'],              // Google avatars + data URIs
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],              // + Google Fonts (Space Grotesk) files
      // The client calls Supabase (REST + realtime), Google Calendar directly (App.tsx fetches
      // googleapis.com with the OAuth token for list/pull/push), and Open-Meteo (keyless weather +
      // air-quality for the Today card / screensaver) — omitting any of these silently breaks them.
      connectSrc: ["'self'", 'https://*.supabase.co', 'wss://*.supabase.co', 'https://www.googleapis.com', 'https://api.open-meteo.com', 'https://air-quality-api.open-meteo.com', ...supaConnect],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      // upgrade-insecure-requests is intentionally OMITTED: the prod serve ALSO runs over plain http on
      // the LAN (npm run start), where forcing https on same-origin assets would break the app. (When the
      // decoupled Cloud Run demo lands, add its API base origin to connectSrc.)
    },
  } : false,
  crossOriginEmbedderPolicy: false,                        // would block cross-origin avatar/image loads
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // keep an OAuth popup's opener working
}));

app.use(express.json({ limit: '10mb' }));

// Auth middleware (requireAuth, aiRateLimit) → src/server/middleware.ts

// ── LAN appliance (LOCAL_MODE): household passphrase auth + SQLite data API ──────
// On the single-click box there's no Supabase: the browser does first-run setup (set a household passphrase),
// logs in (passphrase → a box-signed session), and reads/writes its data through /api/data, backed by the
// SQLite StorageAdapter (household-scoped). In cloud (Supabase) mode the browser talks to Supabase directly,
// so these endpoints are local-only and return 400 otherwise.
const loginHits = new Map<string, { count: number; resetAt: number }>();
const LOGIN_PER_MIN = Number(process.env.LOGIN_PER_MIN) || 8;

// Does the client need to render first-run setup, a login, or (cloud) skip straight in?
app.get('/api/auth/status', (_req: Request, res: Response) => {
  res.json({ mode: STORAGE_MODE, configured: LOCAL_MODE ? isHouseholdConfigured(getSqliteAdapter()) : true });
});

// First-run: set the household passphrase (only when the box isn't configured yet) → returns a session.
app.post('/api/auth/setup', (req: Request, res: Response) => {
  if (!LOCAL_MODE) return res.status(400).json({ error: 'Setup is only for the local appliance.' });
  const db = getSqliteAdapter();
  if (isHouseholdConfigured(db)) return res.status(409).json({ error: 'This box is already set up — log in instead.' });
  const passphrase = req.body?.passphrase;
  if (!isValidPassphrase(passphrase)) return res.status(400).json({ error: 'Passphrase must be 6–128 characters.' });
  setHouseholdPassphrase(db, passphrase);
  res.json({ token: signSession(newSession(getOrCreateHouseholdId(db), Date.now()), getSessionSecret(db)) });
});

// Log in with the household passphrase (rate-limited per IP to blunt brute force) → returns a session.
app.post('/api/auth/login', (req: Request, res: Response) => {
  if (!LOCAL_MODE) return res.status(400).json({ error: 'Login is only for the local appliance.' });
  const now = Date.now();
  const ipKey = req.ip || 'anon';
  pruneExpired(loginHits, now);
  const { allowed, entry } = checkRateWindow(loginHits.get(ipKey), now, LOGIN_PER_MIN, 60_000);
  loginHits.set(ipKey, entry);
  if (!allowed) return res.status(429).json({ error: 'Too many attempts — wait a minute.', retryable: true });
  const db = getSqliteAdapter();
  if (!checkHouseholdPassphrase(db, String(req.body?.passphrase || ''))) {
    return res.status(401).json({ error: 'Incorrect passphrase.' });
  }
  res.json({ token: signSession(newSession(getOrCreateHouseholdId(db), now), getSessionSecret(db)) });
});

// Change the household passphrase (LOCAL_MODE) — requires a valid current session + the old passphrase. Rotates
// the box's session secret so EVERY outstanding token is invalidated (the revocation path); returns a fresh token
// so the caller stays signed in, while any other device must log in again with the new passphrase.
app.post('/api/auth/change-passphrase', requireAuth, (req: Request, res: Response) => {
  if (!LOCAL_MODE) return res.status(400).json({ error: 'Passphrase change is only for the local appliance.' });
  const db = getSqliteAdapter();
  const newPassphrase = req.body?.newPassphrase;
  if (!isValidPassphrase(newPassphrase)) return res.status(400).json({ error: 'New passphrase must be 6–128 characters.' });
  if (!changeHouseholdPassphrase(db, String(req.body?.oldPassphrase || ''), String(newPassphrase))) {
    return res.status(401).json({ error: 'Current passphrase is incorrect.' });
  }
  res.json({ token: signSession(newSession(getOrCreateHouseholdId(db), Date.now()), getSessionSecret(db)) });
});

// Household data API (LOCAL_MODE only — cloud uses Supabase directly). requireAuth set req.householdId.
app.get('/api/data/:key', requireAuth, async (req: Request, res: Response) => {
  if (!LOCAL_MODE) return res.status(400).json({ error: 'The data API is local-mode only.' });
  try {
    const r = await handleDataGet(getSqliteAdapter(), req.householdId!, req.params.key);
    res.status(r.status).json(r.body);
  } catch { res.status(500).json({ error: 'Storage read failed.' }); }
});

app.post('/api/data/:key', requireAuth, async (req: Request, res: Response) => {
  if (!LOCAL_MODE) return res.status(400).json({ error: 'The data API is local-mode only.' });
  try {
    const r = await handleDataSave(getSqliteAdapter(), req.householdId!, req.params.key, req.body);
    res.status(r.status).json(r.body);
  } catch { res.status(500).json({ error: 'Storage write failed.' }); }
});

app.get('/api/data', requireAuth, async (req: Request, res: Response) => {
  if (!LOCAL_MODE) return res.status(400).json({ error: 'The data API is local-mode only.' });
  try {
    const r = await handleDataLoadAll(getSqliteAdapter(), req.householdId!); // bulk: { collections, versions }
    res.status(r.status).json(r.body);
  } catch { res.status(500).json({ error: 'Storage load failed.' }); }
});

// ── SSRF guard: ONE shared implementation (src/utils/ssrfGuard.ts). Imported for local use here AND
// re-exported so the SSRF tests + callers keep importing from server.ts, while webResearch.ts imports the
// SAME module — no more hand-duplicated drift (a NAT64/IPv4-compat fix once landed in only one copy). ──────
import { isBlockedIp, assertSafeUrl, safeFetch } from './src/utils/ssrfGuard';
export { isBlockedIp, assertSafeUrl, safeFetch };

// Gemini/LLM engine (SDK init, callGeminiJSON, cleanHTML, aiErrorResponse, Ollama, fallback chain) → src/server/gemini.ts

// Copilot helpers (ICS parser, action sanitization, suggestion resolver) → src/server/copilotHelpers.ts

// Ensure server is live and running
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

/**
 * Endpoint to parse a given URL calendar feed (ICS or HTML).
 * Uses Gemini AI in case of HTML structures to parse unstructured listings.
 */
app.post('/api/parse-calendar', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const { url, category = 'School' } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required.' });
    }

    console.log(`Fetching calendar URL: ${url}`);
    
    // SSRF guard: safeFetch validates the target (and every redirect hop) against the
    // private/loopback/link-local blocklist before connecting.
    let response;
    try {
      response = await safeFetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml,text/plain,application/ics'
        }
      });
    } catch (fetchErr: any) {
      // Surface SSRF/validation rejections with their specific message; only wrap genuine network failures.
      if (/allowed|private or local|valid URL|Too many redirects/i.test(fetchErr?.message || '')) {
        throw fetchErr;
      }
      throw new Error(`Connection failed when reaching "${url}". Fastest fix: copy the events text from the page and paste it into the "Paste Text" tab, or save the page as a PDF and use the "Upload PDF Calendar" tab.`);
    }

    if (!response.ok) {
      if (response.status === 403 || response.status === 401 || response.status === 503 || response.status === 429) {
        throw new Error(`Access restricted (HTTP ${response.status}). The website at "${url}" blocks automated crawlers or uses Cloudflare security. Fastest fix: select the events text on the page, copy it, and paste into the "Paste Text" tab. Or save the page as a PDF and use the "Upload PDF Calendar" tab.`);
      }
      throw new Error(`Unable to read calendar page from "${url}" (status ${response.status}). Fastest fix: copy the events text from the page and paste it into the "Paste Text" tab. Or save the page as a PDF and use the "Upload PDF Calendar" tab.`);
    }

    if (Number(response.headers.get('content-length') || 0) > MAX_EXTRACT_BYTES) {
      throw new Error(`That page is too large to read (max 8 MB). Paste the events text or upload a PDF instead.`);
    }
    // content-length is only the DECLARED size — a chunked response omits it, so enforce the cap on real bytes.
    let rawText: string;
    try { rawText = await readTextCapped(response, MAX_EXTRACT_BYTES); }
    catch (e: any) {
      if (e?.message === 'BODY_TOO_LARGE') throw new Error(`That page is too large to read (max 8 MB). Paste the events text or upload a PDF instead.`);
      throw e;
    }

    // Check if it's an iCalendar feed
    if (rawText.includes('BEGIN:VCALENDAR') || rawText.includes('BEGIN:VEVENT')) {
      console.log('Detected iCalendar format, parsing directly.');
      const parsed = parseICS(rawText, category);
      return res.json({ events: parsed, format: 'ics' });
    }

    // It's likely HTML, scrape using Gemini AI
    console.log('Detected HTML page, cleaning and querying Gemini AI to extract events.');
    const cleanedText = cleanHTML(rawText);

    if (cleanedText.length < 50) {
      throw new Error('Retrieved webpage text seems too short or empty.');
    }

    const prompt = `You are a calendar scraper. Extract all calendar events, school holidays, upcoming summer camps, parent educational events, or school schedules from the following website text. Format dates in standard ISO string format YYYY-MM-DD. Categorize each event into one of these types: "School", "Camp", "Sports", "Arts", "Holiday", or "Other".
Identify description, location, age group (if present, e.g. "Grades K-5", "Pre-K", "Age 8-12", "All Ages") and approximate times if listed.

Webpage content to extract from:
---
${cleanedText}
---`;

    const parsedEvents = await callGeminiJSON(
      prompt,
      "You are a precise parsing model. Extract school schedules, summer programs, and parent resource/ParentMap calendar listings into accurate JSON. Ensure exact dates. If years are not explicitly declared, assume 2026. Return a schema-compliant array.",
      CALENDAR_EVENT_SCHEMA,
    );
    // Add unique string IDs. Validator (Phase-3): real ISO dates within ±1yr only — a weak model's
    // "next Tuesday" / invented-year events get dropped here, not imported.
    const eventsWithIds = validateExtractedEvents(Array.isArray(parsedEvents) ? parsedEvents : [], new Date().toLocaleDateString('en-CA')).map((evt: any) => ({
      ...evt,
      id: 'ai-' + randomUUID(),
      category: evt.category || category
    }));

    return res.json({ events: eventsWithIds, format: 'html-scraped' });

  } catch (error: any) {
    console.error('Error parsing calendar: ', error);
    // Surface the specific, user-actionable guidance the inner throws build (blocked-crawler / too-large /
    // connection-failed messages) as a 400 instead of letting aiErrorResponse flatten them to a generic 500. [15]
    if (typeof error?.message === 'string' && /Fastest fix:|too large to read|Access restricted/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    return aiErrorResponse(res, error, 'An error occurred while processing the URL');
  }
});

/**
 * Endpoint to parse a given PDF file payload.
 * Passes the PDF as inlineData directly into Gemini 3.5 for high-fidelity native document extraction.
 */
app.post('/api/parse-pdf', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const { pdfBase64, category = 'School' } = req.body;
    if (!pdfBase64) {
      return res.status(400).json({ error: 'PDF data (base64) is required.' });
    }

    // Strip inline MIME prefixes if present
    const cleanBase64 = pdfBase64.replace(/^data:application\/pdf;base64,/, '');
    
    console.log(`Sending uploaded PDF of size ${cleanBase64.length} chars to Gemini 3.5-flash`);

    const pdfPart = {
      inlineData: {
        mimeType: 'application/pdf',
        data: cleanBase64
      }
    };

    const textPart = {
      text: "Extract all calendar events, school holidays, upcoming summer camps, parent educational events, or school schedules from the attached document. Format dates in standard ISO string format YYYY-MM-DD. Categorize each event into one of these types: \"School\", \"Camp\", \"Sports\", \"Arts\", \"Holiday\", or \"Other\".\nIdentify description, location, age group (if present, e.g. \"Grades K-5\", \"Pre-K\", \"Age 8-12\", \"All Ages\") and approximate times if listed."
    };

    const parsedEvents = await callGeminiJSON(
      { parts: [pdfPart, textPart] },
      "You are a precise parsing model. Extract school schedules, summer programs, and calendar listings from the attached file into accurate JSON. Ensure exact dates. If years are not explicitly declared, assume 2026. Return a schema-compliant array.",
      CALENDAR_EVENT_SCHEMA,
    );
    const eventsWithIds = validateExtractedEvents(Array.isArray(parsedEvents) ? parsedEvents : [], new Date().toLocaleDateString('en-CA')).map((evt: any) => ({
      ...evt,
      id: 'pdf-' + randomUUID(),
      category: evt.category || category
    }));

    return res.json({ events: eventsWithIds, format: 'pdf-scraped' });

  } catch (error: any) {
    console.error('Error parsing PDF content: ', error);
    return aiErrorResponse(res, error, 'An error occurred while processing the PDF file');
  }
});

// Extract the PLAIN TEXT of a PDF (for the Docs Library corpus, so the copilot/agent can read it). Distinct
// from /api/parse-pdf (which pulls calendar EVENTS) — this returns the document's readable text verbatim.
// COST DISCIPLINE: most PDFs carry an embedded text layer, so extract that LOCALLY first (pdf-parse — free,
// offline, deterministic) and only fall back to the cloud LLM for OCR on scanned/image-only PDFs.
app.post('/api/extract-pdf-text', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const { pdfBase64 } = req.body;
    if (!pdfBase64) return res.status(400).json({ error: 'PDF data (base64) is required.' });
    const cleanBase64 = String(pdfBase64).replace(/^data:application\/pdf;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');

    // 1) Local text-layer extraction (no AI, no quota). Covers the common case (digital PDFs).
    let layerText = '';
    try {
      const parsed = await pdfParse(buffer);
      layerText = String(parsed?.text || '').trim();
    } catch (e: any) {
      console.warn('pdf text-layer extraction failed (will try OCR):', e?.message || e);
    }
    if (hasUsableText(layerText)) {
      return res.json({ text: layerText.slice(0, 20000), method: 'text-layer' });
    }

    // 2) OCR fallback — scanned/image-only PDF with no text layer. ONLY here do we spend a cloud LLM call.
    const pdfPart = { inlineData: { mimeType: 'application/pdf', data: cleanBase64 } };
    const textPart = { text: 'This PDF has no extractable text layer (it is scanned). OCR it: return the full readable text as plain text. Return JSON {"text":"..."}.' };
    const ocr: any = await callGeminiJSON(
      { parts: [pdfPart, textPart] },
      'You transcribe a scanned document\'s text accurately. Return ONLY what is written — never summarize or invent.',
      { type: Type.OBJECT, properties: { text: { type: Type.STRING } }, required: ['text'] },
      // OCR is an accept-risk surface for the local model (Phase-3): cloud only, always.
      '[]', undefined, {}, { requireCloud: true },
    );
    const text = typeof ocr?.text === 'string' ? ocr.text.slice(0, 20000) : '';
    return res.json({ text, method: 'ocr' });
  } catch (error: any) {
    console.error('extract-pdf-text error:', error?.message || error);
    return aiErrorResponse(res, error, 'Could not extract text from the PDF.');
  }
});

// Cap decoded upload size before handing OOXML (a ZIP) to mammoth/sheetjs — defense-in-depth against a
// decompression bomb OOMing the single-instance server (the patched sheetjs/mammoth + aiRateLimit do the rest).
const MAX_EXTRACT_BYTES = 8 * 1024 * 1024;

// Read a fetch Response body as UTF-8 text but ABORT once cumulative bytes exceed `max`. The content-length
// header check alone is bypassable by a chunked (no-length) response, which would otherwise let `response.text()`
// buffer the entire body into memory and OOM the single-instance server. Throws 'BODY_TOO_LARGE' past the cap.
async function readTextCapped(response: any, max: number): Promise<string> {
  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') return String(await response.text()).slice(0, max);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > max) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error('BODY_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Shared base64-upload decode for the doc endpoints: presence (400) → strip data-URI → decode → size cap (413).
// Returns the Buffer, or null AFTER writing the error response (the caller just `return`s).
function decodeUpload(b64: unknown, res: import('express').Response): Buffer | null {
  if (!b64) { res.status(400).json({ error: 'File data (base64) is required.' }); return null; }
  const buffer = Buffer.from(String(b64).replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (buffer.length > MAX_EXTRACT_BYTES) { res.status(413).json({ error: 'That file is too large to read (max 8 MB).' }); return null; }
  return buffer;
}

// Extract the readable text of a .docx (Word) file for the Docs Library corpus. Local + deterministic
// (mammoth, no AI/quota) — the universal uploader sends the file base64; we return its plain text.
app.post('/api/extract-docx-text', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const buffer = decodeUpload(req.body.docxBase64, res);
    if (!buffer) return;
    const result = await mammoth.extractRawText({ buffer });
    const text = String(result?.value || '').trim().slice(0, 20000);
    return res.json({ text });
  } catch (error: any) {
    console.error('extract-docx-text error:', error?.message || error);
    return res.status(422).json({ error: 'Could not read that Word document.' });
  }
});

// Extract the readable text of a .xlsx (Excel) file for the Docs Library corpus. Local + deterministic
// (sheetjs, no AI/quota): every sheet → CSV so the copilot/agent can read the rows.
app.post('/api/extract-xlsx-text', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const buffer = decodeUpload(req.body.xlsxBase64, res);
    if (!buffer) return;
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const text = wb.SheetNames
      .map(name => `# ${name}\n${XLSX.utils.sheet_to_csv(wb.Sheets[name])}`.trim())
      .join('\n\n')
      .trim()
      .slice(0, 20000);
    return res.json({ text });
  } catch (error: any) {
    console.error('extract-xlsx-text error:', error?.message || error);
    return res.status(422).json({ error: 'Could not read that spreadsheet.' });
  }
});

// Fetch a web page and return its readable text for the Docs Library corpus (the "save this page" path of the
// universal uploader). SSRF-guarded via safeFetch; HTML stripped with the same cleaner the calendar scraper
// uses. No AI — we store the page text verbatim as grounding material.
app.post('/api/extract-url-text', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'A URL is required.' });
    let response: Awaited<ReturnType<typeof safeFetch>>;
    try {
      response = await safeFetch(String(url), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml,text/plain',
        },
      });
    } catch (fetchErr: any) {
      // safeFetch throws plain Errors, so we distinguish an SSRF/validation rejection (→ 400, surface the
      // specific reason) from a genuine network failure (→ 502) by message. NOTE: these substrings must track
      // the messages thrown in safeFetch/assertSafeUrl — mirrors the same guard in /api/parse-calendar.
      if (/allowed|private or local|valid URL|Too many redirects/i.test(fetchErr?.message || '')) {
        return res.status(400).json({ error: fetchErr.message });
      }
      return res.status(502).json({ error: `Could not reach "${url}".` });
    }
    if (!response.ok) return res.status(502).json({ error: `Could not read "${url}" (status ${response.status}).` });
    // Cap by declared size BEFORE buffering the whole body — a length-declared multi-GB page would otherwise
    // OOM the single-instance server (mirrors the 8 MB cap the doc-upload endpoints enforce).
    if (Number(response.headers.get('content-length') || 0) > MAX_EXTRACT_BYTES) {
      return res.status(413).json({ error: 'That page is too large to read (max 8 MB).' });
    }
    // content-length is only the DECLARED size — a chunked response omits it, so enforce the cap on real bytes.
    let raw: string;
    try { raw = await readTextCapped(response, MAX_EXTRACT_BYTES); }
    catch (e: any) {
      if (e?.message === 'BODY_TOO_LARGE') return res.status(413).json({ error: 'That page is too large to read (max 8 MB).' });
      throw e;
    }
    const text = cleanHTML(raw).slice(0, 20000);
    if (text.length < 20) return res.status(422).json({ error: 'That page had no readable text to save.' });
    return res.json({ text });
  } catch (error: any) {
    console.error('extract-url-text error:', error?.message || error);
    return res.status(500).json({ error: 'Could not save that page.' });
  }
});

/**
 * Endpoint to parse raw text copied from emails, newsletters, or webpages.
 * Directly queries Gemini 3.5-flash to extract events.
 */
app.post('/api/parse-text', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const { calendarText, category = 'School' } = req.body;
    if (!calendarText || calendarText.trim().length === 0) {
      return res.status(400).json({ error: 'Calendar text content is required.' });
    }

    console.log(`Sending pasted calendar text of size ${calendarText.length} to Gemini 3.5-flash`);

    const prompt = `You are a calendar scraper. Extract all calendar events, school holidays, upcoming summer camps, parent educational events, or school schedules from the following copied text. Format dates in standard ISO string format YYYY-MM-DD. Categorize each event into one of these types: "School", "Camp", "Sports", "Arts", "Holiday", or "Other".
Identify description, location, age group (if present, e.g. "Grades K-5", "Pre-K", "Age 8-12", "All Ages") and approximate times if listed.

Copied text to extract from:
---
${calendarText}
---`;

    const parsedEvents = await callGeminiJSON(
      prompt,
      "You are a precise parsing model. Extract school schedules, summer programs, and calendar listings from raw text into accurate JSON. Ensure exact dates. If years are not explicitly declared, assume 2026. Return a schema-compliant array.",
      CALENDAR_EVENT_SCHEMA,
    );
    const eventsWithIds = validateExtractedEvents(Array.isArray(parsedEvents) ? parsedEvents : [], new Date().toLocaleDateString('en-CA')).map((evt: any) => ({
      ...evt,
      id: 'text-' + randomUUID(),
      category: evt.category || category
    }));

    return res.json({ events: eventsWithIds, format: 'text-scraped' });

  } catch (error: any) {
    console.error('Error parsing pasted text content: ', error);
    return aiErrorResponse(res, error, 'An error occurred while processing the pasted text');
  }
});

/**
 * Recipe / dish name → grocery shopping list. Gemini extracts ingredients and assigns
 * each to the most likely store. Returns { items: [{ text, store }] }.
 */
app.post('/api/parse-recipe', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'A dish name or recipe text is required.' });
    }
    // Household-defined store lists (Phase-5): the client sends its live list; junk/absent → defaults.
    const stores = sanitizeStoreList(req.body?.stores);
    const storeLine = storeRoutingLine(stores);

    const prompt = `Extract the grocery ingredients needed for the following dish or recipe. Return each ingredient as a concise shopping-list item. Quantities must be BUY units a store actually sells — package sizes ("400 g pack", "small bag", "1 lb", "a dozen", "1 bunch", "small jar", "500 ml carton") — NEVER cook-measure units like cups/tbsp/tsp (a recipe's "2 tbsp coriander seeds" becomes "Coriander seeds (small bag)"; "1/2 cup heavy cream" becomes "Heavy cream (small carton)"). ${storeLine}

Dish or recipe:
---
${text}
---`;

    const items = await callGeminiJSON(
      prompt,
      "You convert a recipe or dish name into a clean grocery shopping list. Return a schema-compliant JSON array of { text, store }.",
      {
        type: Type.ARRAY,
        description: "Ingredients to buy",
        items: {
          type: Type.OBJECT,
          properties: {
            text: { type: Type.STRING, description: "Ingredient as a shopping-list item." },
            store: { type: Type.STRING, description: `One of: ${stores.join(', ')}` }
          },
          required: ["text"]
        }
      },
    );
    return res.json({ items, format: 'recipe' });
  } catch (error: any) {
    console.error('Error parsing recipe: ', error);
    return aiErrorResponse(res, error, 'An error occurred while extracting ingredients');
  }
});

/**
 * Pantry inventory → restock suggestions. Gemini compares the freeform pantry state
 * (and optionally what's already on the list) and proposes items to refill.
 * Returns { items: [{ text, store }] }.
 */
app.post('/api/pantry-restock', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const { pantry = [], recipes = [] } = req.body;
    if (!Array.isArray(pantry) || pantry.length === 0) {
      return res.status(400).json({ error: 'Pantry contents are required.' });
    }

    const stores = sanitizeStoreList(req.body?.stores);
    const alreadyListed = Array.isArray(recipes) && recipes.length > 0;
    const prompt = `A family tracks their pantry inventory as freeform notes (what they have and roughly how much). Based on the pantry state below${alreadyListed ? ' and the items already on their shopping list' : ''}, suggest what they should RESTOCK — items that are low, depleted, or commonly needed staples that appear to be missing. Do NOT suggest items they clearly already have in good supply. ${storeRoutingLine(stores)}

Pantry state:
---
${(pantry as string[]).join('\n')}
---
${alreadyListed ? `Already on the shopping list (don't duplicate these):\n---\n${(recipes as string[]).join('\n')}\n---\n` : ''}`;

    const items = await callGeminiJSON(
      prompt,
      "You suggest practical grocery restock items from a pantry inventory. Avoid suggesting items already in good supply or already on the list. Return a schema-compliant JSON array of { text, store }.",
      {
        type: Type.ARRAY,
        description: "Items to restock",
        items: {
          type: Type.OBJECT,
          properties: {
            text: { type: Type.STRING, description: "Restock item as a shopping-list entry." },
            store: { type: Type.STRING, description: `One of: ${stores.join(', ')}` }
          },
          required: ["text"]
        }
      },
    );
    return res.json({ items, format: 'restock' });
  } catch (error: any) {
    console.error('Error suggesting restock: ', error);
    return aiErrorResponse(res, error, 'An error occurred while suggesting a restock list');
  }
});

/**
 * Pantry → meal plan (agentic A8 — a multi-step showcase). One structured pass: propose 3 simple dinners
 * the family can MOSTLY make from the pantry, then DIFF against the pantry to return only the extra
 * groceries to buy. Returns { meals: [name], items: [{ text, store }] } — the client stages the items.
 */
app.post('/api/meal-plan', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const { pantry = [] } = req.body;
    if (!Array.isArray(pantry) || pantry.length === 0) {
      return res.status(400).json({ error: 'Pantry contents are required.' });
    }
    const stores = sanitizeStoreList(req.body?.stores);
    const prompt = `A family tracks their pantry as freeform notes. Plan 3 simple, varied DINNERS they can mostly cook from what they already have. Then, comparing each meal's ingredients against the pantry, list ONLY the ADDITIONAL grocery items they still need to buy (the gap — skip anything the pantry already covers). ${storeRoutingLine(stores)}

Pantry state:
---
${(pantry as string[]).join('\n')}
---`;
    const data = await callGeminiJSON(
      prompt,
      "You plan a few dinners from a pantry inventory and return the missing groceries to buy. Return schema-compliant JSON { meals: [string], items: [{ text, store }] }.",
      {
        type: Type.OBJECT,
        properties: {
          meals: { type: Type.ARRAY, description: 'The 3 dinner names.', items: { type: Type.STRING } },
          items: {
            type: Type.ARRAY,
            description: 'Additional groceries to buy (the diff vs pantry).',
            items: {
              type: Type.OBJECT,
              properties: {
                text: { type: Type.STRING, description: 'Item as a shopping-list entry.' },
                store: { type: Type.STRING, description: `One of: ${stores.join(', ')}` },
              },
              required: ['text'],
            },
          },
        },
        required: ['meals', 'items'],
      },
    );
    return res.json({ meals: data?.meals || [], items: data?.items || [], format: 'meal-plan' });
  } catch (error: any) {
    console.error('Error planning meals: ', error);
    return aiErrorResponse(res, error, 'An error occurred while planning meals');
  }
});

/**
 * Vision intake (Pattern #2): a fridge/receipt PHOTO → the grocery items the model SEES, each flagged
 * whether it's already in the family's pantry. Reuses the multimodal pattern from /api/parse-pdf
 * (inlineData image part + a text instruction). The client diffs + confirms before adding — never silent.
 * Returns { detected: [{ text, inPantry, store }] }.
 */
app.post('/api/vision-scan-pantry', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const { imageBase64, mimeType, pantry = [] } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'An image is required.' });
    const cleanBase64 = String(imageBase64).replace(/^data:[^;]+;base64,/, '');
    const mt = typeof mimeType === 'string' && /^image\//.test(mimeType) ? mimeType : 'image/jpeg';
    const have = (Array.isArray(pantry) ? pantry : []).map((p: any) => String(p)).filter(Boolean).join(', ');
    const stores = sanitizeStoreList(req.body?.stores);
    const imagePart = { inlineData: { mimeType: mt, data: cleanBase64 } };
    const textPart = {
      text: `This photo shows either the inside of a fridge/cupboard or a grocery receipt. List the distinct GROCERY items you can identify. For each, set "inPantry": true if it already appears in the family's current pantry list below (else false). ${storeRoutingLine(stores)} Ignore non-grocery clutter. Do not invent items you cannot see.\n\nCurrent pantry: ${have || '(empty)'}`,
    };
    const data = await callGeminiJSON(
      { parts: [imagePart, textPart] },
      'You are a precise grocery-vision model. Identify only items actually visible in the photo and return schema-compliant JSON { detected: [{ text, inPantry, store }] }.',
      {
        type: Type.OBJECT,
        properties: {
          detected: {
            type: Type.ARRAY,
            description: 'Grocery items visible in the photo.',
            items: {
              type: Type.OBJECT,
              properties: {
                text: { type: Type.STRING, description: 'The item as a short grocery name.' },
                inPantry: { type: Type.BOOLEAN, description: 'True if already in the pantry list.' },
                store: { type: Type.STRING, description: `One of: ${stores.join(', ')}` },
              },
              required: ['text'],
            },
          },
        },
        required: ['detected'],
      },
    );
    return res.json({ detected: data?.detected || [], format: 'vision-pantry' });
  } catch (error: any) {
    console.error('Error scanning pantry photo: ', error);
    return aiErrorResponse(res, error, 'An error occurred while scanning the photo');
  }
});

// ── Photos screensaver corpus (W6) ── a watched LOCAL folder (PHOTOS_DIR, default ./data/photos —
// beside the appliance's SQLite file): the family drops photos in by USB/network share, or the
// (post-OAuth-verification) Google-Photos Picker import uploads here. createTime = a `<name>.json`
// sidecar's {createTime} when present (the Picker path writes real capture times), else file mtime —
// the screensaver's date-window weighting works off whichever it gets. Bytes never leave the box.
const PHOTOS_DIR = path.resolve(process.env.PHOTOS_DIR || './data/photos');
const PHOTO_EXT = /\.(jpe?g|png|webp|gif)$/i;
const photoPathFor = (name: string): string | null => {
  const raw = String(name || '');
  // Reject both separators explicitly: on POSIX a backslash is a legal filename character, so
  // path.basename('..\\x.jpg') round-trips unchanged and the basename check alone passed it through
  // (Linux CI answered 404-not-found where Windows answered 400-rejected for the same input).
  if (/[\\/]/.test(raw)) return null;
  const base = path.basename(raw);
  if (base !== raw || !PHOTO_EXT.test(base)) return null; // traversal-proof: a bare basename only
  return path.join(PHOTOS_DIR, base);
};

// Disk-photos are a LAN-APPLIANCE feature only. In cloud the PHOTOS_DIR is one flat directory keyed by
// filename with no household segment — a multi-tenant deploy would leak/clobber photos across households
// (and Cloud Run's disk is ephemeral anyway). Gate all three routes to LOCAL_MODE (matching the data API);
// the cloud screensaver falls back to the plain clock or the live Google Photos path.
app.get('/api/photos/list', requireAuth, async (_req, res) => {
  if (!LOCAL_MODE) return res.json({ photos: [] });
  try {
    const entries = await fsp.readdir(PHOTOS_DIR).catch(() => [] as string[]);
    const photos: { name: string; createTime: string }[] = [];
    for (const name of entries.slice(0, 1000)) {
      if (!PHOTO_EXT.test(name)) continue;
      try {
        const st = await fsp.stat(path.join(PHOTOS_DIR, name));
        let createTime = st.mtime.toISOString();
        try {
          const sidecar = JSON.parse(await fsp.readFile(path.join(PHOTOS_DIR, `${name}.json`), 'utf8'));
          if (typeof sidecar?.createTime === 'string' && !Number.isNaN(Date.parse(sidecar.createTime))) createTime = sidecar.createTime;
        } catch { /* no sidecar → mtime */ }
        photos.push({ name, createTime });
        if (photos.length >= 500) break; // sane corpus cap for a wall tablet
      } catch { /* unreadable entry → skip */ }
    }
    return res.json({ photos });
  } catch (e: any) {
    console.error('photos/list error:', e?.message || e);
    return res.json({ photos: [] }); // best-effort: the screensaver falls back to the plain clock
  }
});

app.get('/api/photos/file/:name', requireAuth, (req, res) => {
  if (!LOCAL_MODE) return res.status(400).json({ error: 'Photos are a local-appliance feature.' });
  const p = photoPathFor(req.params.name);
  if (!p) return res.status(400).json({ error: 'Invalid photo name.' });
  return res.sendFile(p, err => { if (err && !res.headersSent) res.status(404).json({ error: 'Photo not found.' }); });
});

// Import landing endpoint (the browser-side Picker flow downloads each picked photo within Google's
// 60-minute baseUrl window and uploads it here with its REAL createTime; also usable by any authed
// uploader). Size-capped; name is traversal-proofed by photoPathFor.
app.post('/api/photos/upload', requireAuth, async (req, res) => {
  if (!LOCAL_MODE) return res.status(400).json({ error: 'Photos are a local-appliance feature.' });
  try {
    const { name, imageBase64, createTime } = req.body || {};
    const p = photoPathFor(String(name || ''));
    if (!p || !imageBase64) return res.status(400).json({ error: 'A valid image name and data are required.' });
    const buf = Buffer.from(String(imageBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length || buf.length > 15 * 1024 * 1024) return res.status(400).json({ error: 'Image must be under 15 MB.' });
    await fsp.mkdir(PHOTOS_DIR, { recursive: true });
    await fsp.writeFile(p, buf);
    if (typeof createTime === 'string' && !Number.isNaN(Date.parse(createTime))) {
      await fsp.writeFile(`${p}.json`, JSON.stringify({ createTime }));
    }
    return res.json({ ok: true, name: path.basename(p) });
  } catch (e: any) {
    console.error('photos/upload error:', e?.message || e);
    return res.status(500).json({ error: 'Upload failed.' });
  }
});

/**
 * HITL "Modify" (Pattern #4): revise a STAGED Approvals draft from the parent's plain-language feedback
 * ("make it vegetarian", "Tuesday instead"). Re-prompts the model with the draft + feedback and returns the
 * raw revised JSON; the client shapes/sanitizes it (shapeRevisedDraft) and restages the entry IN PLACE,
 * still pending. NEVER books or pays — a revision stays a draft. Returns { revised }.
 */
app.post('/api/revise-draft', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const { tool, summary, before, changes, payload, link, feedback } = req.body || {};
    if (!tool || typeof tool !== 'string' || !feedback || String(feedback).trim().length === 0) {
      return res.status(400).json({ error: 'A draft tool and your requested change are required.' });
    }
    const prompt = buildRevisePrompt(tool, { summary, before, changes, payload, link }, String(feedback).trim());
    const revised = await callGeminiJSON(
      prompt,
      'You revise a staged household-assistant DRAFT per the parent\'s feedback, keeping it the same kind of action and never booking/buying/paying. Return schema-compliant JSON.',
      {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING, description: 'New one-line description of the revised draft.' },
          changes: {
            type: Type.OBJECT,
            description: 'For a calendar change: only the fields that change.',
            properties: {
              title: { type: Type.STRING }, start: { type: Type.STRING }, end: { type: Type.STRING },
              startTime: { type: Type.STRING }, endTime: { type: Type.STRING }, category: { type: Type.STRING },
              description: { type: Type.STRING },
            },
          },
          link: { type: Type.STRING, description: 'Optional refreshed http(s) link.' },
          text: { type: Type.STRING, description: 'Optional refreshed item text (cart/shopping draft).' },
        },
        required: ['summary'],
      },
      // Revising a staged DRAFT is an accept-risk surface for the local model (Phase-3): cloud only.
      '[]', undefined, {}, { requireCloud: true },
    );
    return res.json({ revised });
  } catch (error: any) {
    console.error('Error revising draft: ', error);
    return aiErrorResponse(res, error, 'An error occurred while revising the draft');
  }
});

/**
 * Natural-language quick-add: classify one short note into a calendar event, shopping
 * items, or a chore, and return a single structured object the client dispatches to
 * its existing add handlers. Returns { result: { kind, event?, items?, chore? } }.
 */
// Quick-add response schema — module-level so the critic retry reuses the exact same contract.
const QUICKADD_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    kind: { type: Type.STRING, description: 'One of: event, shopping, chore' },
    event: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        start: { type: Type.STRING, description: 'YYYY-MM-DD' },
        end: { type: Type.STRING, description: 'YYYY-MM-DD (optional)' },
        startTime: { type: Type.STRING, description: "Start time as 24h 'HH:MM' if a time is given (e.g. '4pm' -> '16:00'); omit for all-day." },
        endTime: { type: Type.STRING, description: "End time as 24h 'HH:MM' (optional)." },
        category: { type: Type.STRING },
        members: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
    },
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { text: { type: Type.STRING }, store: { type: Type.STRING } },
        required: ['text'],
      },
    },
    chore: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        assignedTo: { type: Type.STRING, description: "Who does it. For multi-kid intent keep the phrase VERBATIM — 'both kids', 'all kids', or 'everyone' (do NOT pick a single name); the app expands it to one chore per kid." },
        points: { type: Type.NUMBER },
        timesPerDay: { type: Type.NUMBER },
        repeatType: { type: Type.STRING },
        scheduleTimeOfDay: { type: Type.STRING },
      },
    },
  },
  required: ['kind'],
};

app.post('/api/parse-quickadd', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const { text, members = [] } = req.body;
    const stores = sanitizeStoreList(req.body?.stores); // household lists; junk/absent → defaults
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Some text is required.' });
    }
    const today = new Date().toISOString().slice(0, 10);
    const prompt = `Classify the family note below into exactly ONE of: a calendar "event", "shopping" items, or a "chore".
Known family members: ${(members as string[]).join(', ') || 'none'}.
Valid shopping stores: ${(stores as string[]).join(', ')}.
Today is ${today}; resolve relative dates ("tomorrow", "next monday") to YYYY-MM-DD.

Field rules:
- event: title; start (YYYY-MM-DD); end (optional); category one of School|Camp|Sports|Arts|Holiday|Other; members = array of known member names (or ["Everyone"]).
- shopping: items = array of { text, store } with store from the valid list (default "Grocery Store").
- chore: title; assignedTo = a known member name; points (number, default 10); timesPerDay (default 1); repeatType "daily"|"weekly" (default "daily"); scheduleTimeOfDay Morning|Afternoon|Evening|Anytime (optional).
If ambiguous, prefer "shopping" for grocery-like items, otherwise an "event" dated today.

Note: "${text}"`;

    const result = await callGeminiJSON(
      prompt,
      'You convert a single family note into one structured object. Return schema-compliant JSON with the relevant sub-object populated for the chosen kind.',
      QUICKADD_SCHEMA,
      '{}',
    );
    // Critic loop (weak-model hardening): a near-miss parse (unknown member, past date, bad store)
    // used to return RAW and fail silently client-side. Validate deterministically; on issues,
    // ONE corrective re-prompt at low temperature (adopted only if it strictly improves), then
    // coerce whatever remains fixable. Mirrors the /api/copilot critic (bounded, honest).
    const qaCtx = { members: (members as string[]).filter(Boolean), stores: (stores as string[]).filter(Boolean), today };
    let parsedQA = result as any;
    let qaIssues = verifyQuickAdd(parsedQA, qaCtx);
    if (qaIssues.length) {
      const retry: any = await callGeminiJSON(
        `${prompt}\n\n${buildQuickAddCriticNote(qaIssues)}`,
        'You convert a single family note into one structured object. Return schema-compliant JSON with the relevant sub-object populated for the chosen kind.',
        QUICKADD_SCHEMA, '{}', undefined, { temperature: 0.3 },
      ).catch(() => null);
      const retryIssues = retry ? verifyQuickAdd(retry, qaCtx) : qaIssues;
      if (retry && retryIssues.length < qaIssues.length) { parsedQA = retry; qaIssues = retryIssues; }
    }
    parsedQA = coerceQuickAdd(parsedQA, qaCtx);
    return res.json({ result: parsedQA, criticIssues: qaIssues.length ? qaIssues : undefined });
  } catch (error: any) {
    console.error('Error parsing quick-add: ', error);
    return aiErrorResponse(res, error, 'An error occurred while interpreting that note');
  }
});

// ── AI starter chore plan (docs/ai-chore-plan-generator.md) ─────────────────────────────────────
// Chores empty state → the parent gives each kid's age (+ optional interests/gender) → one model call
// returns a tailored plan the parent REVIEWS before anything is added (preview/staging, never silent).
// The curated exemplar is style/coverage-only; assignment is to the REAL kid names in the request, and
// sanitizeGeneratedChores (shared, pure) clamps every field server-side. Explicitly told never to gate
// chores by gender — gender is at most incidental personalization.
const GENERATE_CHORES_SYSTEM = 'You design age-appropriate starter chore plans for a family app, calibrated by child development: '
  + 'younger kids get short, concrete, 1-step jobs; older kids get multi-step responsibility. Assign ONLY to the child names provided '
  + '(exact spelling; one name per chore — emit two rows if both kids should do it). NEVER gate or stereotype chores by gender; if a '
  + 'gender is provided it may at most flavor an interest tie-in. Cover breadth across: household help, personal habits, learning, '
  + 'enrichment/creative, family/cultural rituals, and outdoor. Titles short and kid-readable; put the how/why coaching in `notes`. '
  + 'points 5-20 (harder/older = more), timesPerDay 1-3, repeatType daily|weekly, scheduleTimeOfDay Morning|Afternoon|Evening|Anytime. '
  + 'Return schema-compliant JSON: an array of chore objects. The following example plan shows TONE, BREADTH, and NOTES STYLE only — '
  + 'do NOT copy its items or placeholder names: ' + CHORE_PLAN_STYLE_EXEMPLAR;
const GENERATE_CHORES_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING },
      assignedTo: { type: Type.STRING, description: 'Exactly one of the provided child names.' },
      points: { type: Type.NUMBER },
      timesPerDay: { type: Type.NUMBER },
      repeatType: { type: Type.STRING, description: 'daily or weekly' },
      scheduleTimeOfDay: { type: Type.STRING, description: 'Morning, Afternoon, Evening, or Anytime' },
      notes: { type: Type.STRING, description: 'Short how/why coaching for the kid (and parent).' },
    },
    required: ['title', 'assignedTo'],
  },
};

app.post('/api/generate-chores', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const kids = (Array.isArray(req.body?.kids) ? req.body.kids : [])
      .map((k: any) => ({
        name: String(k?.name ?? '').trim().slice(0, 80),
        age: Math.round(Number(k?.age)),
        interests: String(k?.interests ?? '').trim().slice(0, 200),
        gender: String(k?.gender ?? '').trim().slice(0, 20),
      }))
      .filter((k: any) => k.name && Number.isFinite(k.age) && k.age >= 1 && k.age <= 18)
      .slice(0, 8);
    if (!kids.length) return res.status(400).json({ error: 'At least one kid with a name and an age (1–18) is required.' });

    const kidLines = kids.map((k: any) =>
      `- ${k.name}, age ${k.age}${k.interests ? `, interests: ${k.interests}` : ''}${k.gender && k.gender !== 'unspecified' ? `, gender: ${k.gender}` : ''}`);
    const prompt = `Create a starter chore plan for these children (about 4-8 chores per child, tailored to each age${kids.some((k: any) => k.interests) ? ' and their interests' : ''}):\n${kidLines.join('\n')}`;

    const raw = await callGeminiJSON(prompt, GENERATE_CHORES_SYSTEM, GENERATE_CHORES_SCHEMA, '[]');
    const chores = sanitizeGeneratedChores(raw, kids.map((k: any) => k.name), 40);
    return res.json({ chores });
  } catch (error: any) {
    console.error('generate-chores error:', error?.message || error);
    return aiErrorResponse(res, error, 'Could not generate a chore plan right now.');
  }
});

/**
 * AI Assistant Copilot endpoint to ask layout planning questions, conflict resolution, or gap detection.
 * Returns { answer, actions } — actions is an optional list of create-only mutations the
 * client validates and applies via its existing add handlers (empty for pure Q&A).
 */
app.post('/api/copilot', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const { events, prompt, familyMembers = [], home, visitLog = [], chatHistory = [], documents = [], mealplan = [] } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Accept either name strings or full member objects (be tolerant of either client shape). Label with
    // age when known ("Leo (8)") so the copilot tailors activities by real age instead of guessing.
    const memberNames = (Array.isArray(familyMembers) ? familyMembers : [])
      .map((m: any) => {
        if (typeof m === 'string') return m;
        const name = m?.name;
        const age = Number(m?.age);
        return name ? (Number.isFinite(age) && age > 0 ? `${name} (${age})` : name) : null;
      })
      .filter(Boolean);

    // SERVER-LOCAL calendar date + wall-clock time (the household's timezone on a self-hosted LAN
    // deploy), NOT UTC — otherwise an evening query rolls to "tomorrow" and drops today's events.
    // Build the date from local getters (no locale/ICU dependency); the time label is cosmetic.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const nowLabel = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); // "3:15 PM"
    // A weak fallback model can't be trusted to mentally skip past dates, so drop them here —
    // the planner only ever sees today-and-upcoming events (Bug 9: it kept listing past days).
    const upcomingEvents = filterUpcomingEvents(events, today);

    // Prompt + schema live in src/utils/copilotPrompt.ts so the local-model bench reuses them
    // verbatim (no drift). See that file for the find-vs-create / short-title rules.
    //
    // Harnessed path (default on; COPILOT_HARNESS_ENABLED=false reverts): inject deterministic
    // DATE FACTS (weekday per date) + AVAILABILITY (per-person OFF/BUSY) so the weak local model
    // only reasons, never computes. Chosen here, before the
    // local-vs-Gemini branch inside callGeminiJSON, so BOTH models get the same grounding. Still
    // built from `upcomingEvents` (Bug 9 past-date guard) and the coerced `memberNames` (Bug 4);
    // COPILOT_HARNESS_SYSTEM carries the Bug 9/10/11 find-vs-create / short-title rules.
    const useHarness = process.env.COPILOT_HARNESS_ENABLED !== 'false';
    const availability = buildAvailabilityBlock(today, upcomingEvents, memberNames);

    // LONG WEEKEND (Bug 4): server-compute the off-day window so the weak model never reasons about
    // which days are off (confirmed model-agnostic failure). Planning queries only; '' (→ undefined)
    // when there's no long weekend in the window, so no block is injected.
    const longWeekend = useHarness && isPlanningQuery(prompt)
      ? (buildLongWeekendBlock(today, upcomingEvents, memberNames) || undefined)
      : undefined;

    // External grounding (Pattern 1): WEATHER + PLACES (+ travel times) + nearby EVENTS — fetched
    // only when harnessed, a home location is set, and this is a planning query (D9 — skip on direct
    // lookups). One per-user data-fetch quota check covers all three; each fetch is independently
    // best-effort + cached, so any failure just omits that block and the copilot answers with the
    // rest. Places/events keys are optional (free OSM/OSRM fallback for places+travel; events need a
    // Ticketmaster key). Weather + places + events are fetched in parallel.
    let weather: string | undefined;
    let places: string | undefined;
    let eventsNearby: string | undefined;
    // The id→venue/event map behind the PLACES/EVENTS FACTS the model sees — used to resolve a "place"
    // suggestion's [P#]/[E#] ref to a real name + link, and to DROP any specific place the model invents.
    const groundingFacts: GroundingFact[] = [];
    // Validate the client-supplied coordinates are FINITE and in-range before they reach the data
    // fetchers / cache keys — `typeof === 'number'` passes NaN/Infinity, which would poison the
    // coarse-grid caches and is inconsistent with the project's numeric-URL discipline.
    const validCoords = home
      && Number.isFinite(home.homeLat) && Math.abs(home.homeLat) <= 90
      && Number.isFinite(home.homeLng) && Math.abs(home.homeLng) <= 180;
    // Grounding fires for generic planning queries AND for place/proximity/food queries ("within 15
    // min", "near me", "vegan restaurant") — the latter miss isPlanningQuery's keyword heuristic but
    // still need the home location + venue list (else the model has no location and asks for a ZIP).
    if (useHarness && validCoords && (isPlanningQuery(prompt) || isPlacesQuery(prompt))) {
      const userId = req.user?.id || 'anon';
      if (withinDataFetchQuota(userId)) {
        const homeLabel = String(home.homeLabel || '');
        const windowEndExcl = addDaysISO(today, 12);
        // Query-aware places fetch:
        //   • FOOD/cafe intent ("vegan restaurant", "coffee") → Text Search (those aren't in the
        //     family includedTypes), biased ~10 mi unless a tighter proximity is given.
        //   • PROXIMITY constraint — by miles ("within 6 mi", "near me") or by drive time ("within
        //     20 minutes", "half-hour") → CLOSEST-first over a tighter radius, then filter by the
        //     actual drive. Miles → radius = miles × 1.4 (drive vs straight-line). Minutes → estimate
        //     radius at ~32 mph × 1.2 buffer, then trim by real driveMinutes.
        //   • Otherwise the default marquee/popularity list.
        const intent = detectPlacesIntent(prompt);
        const prox = parseDistanceConstraint(prompt);
        const radiusM = typeof prox?.maxMiles === 'number'
          ? Math.min(80000, Math.max(2500, Math.round(prox.maxMiles * 1609.34 * 1.4)))
          : typeof prox?.maxMinutes === 'number'
          ? Math.min(80000, Math.max(2500, Math.round((prox.maxMinutes / 60) * 32 * 1609.34 * 1.2)))
          : (intent ? 16000 : undefined);
        const placesPromise = fetchNearbyPlaces(home.homeLat, home.homeLng, {
          ...(radiusM ? { radiusM } : {}),
          ...(prox ? { rank: 'DISTANCE' as const } : {}),
          ...(intent ? { textQuery: intent.textQuery } : {}),
        });
        const [daily, aqiByDate, pollenByDate, placeList, eventList] = await Promise.all([
          fetchWeatherDaily(home.homeLat, home.homeLng),
          fetchAirQualityDaily(home.homeLat, home.homeLng),       // Open-Meteo, free
          fetchPollenDaily(home.homeLat, home.homeLng),           // Google Pollen (key-gated)
          placesPromise,
          fetchLocalEvents(home.homeLat, home.homeLng, today, windowEndExcl),
        ]);
        if (daily) weather = buildWeatherFacts(homeLabel, daily, 10, { aqiByDate, pollenByDate });
        if (placeList.length) {
          // Travel times are cached WITH the places: attachTravelTimes mutates the Place objects the
          // placesCache holds, so on a cache hit they already carry driveMinutes — skip the
          // Distance-Matrix/OSRM round-trip entirely (a failed prior attempt leaves them unset → retry).
          if (!placeList.some(p => typeof p.driveMinutes === 'number')) {
            await attachTravelTimes(home.homeLat, home.homeLng, placeList);
          }
          flagHiddenGems(placeList); // tag highly-rated-but-not-popular venues for the creative pick
          // For a FOOD intent, "a different X" means exclude places visited recently (HISTORY FACTS
          // still nudges the family-outing path softly, so don't hard-exclude there).
          let list = intent ? filterRecentlyVisited(placeList, visitLog, today) : placeList;
          let withinNote: { withinMiles?: number; withinMinutes?: number } | undefined;
          if (typeof prox?.maxMiles === 'number') {
            // Keep only venues within the requested drive distance; if none qualify (or drive times
            // are missing), fall back to the nearest few so the model has real options rather than
            // inventing one — then drop the "within N" claim from the header.
            const max = prox.maxMiles;
            const within = list.filter(p => typeof p.driveMiles === 'number' && p.driveMiles <= max);
            list = within.length ? within : list.slice(0, 5);
            withinNote = within.length ? { withinMiles: max } : undefined;
          } else if (typeof prox?.maxMinutes === 'number') {
            const max = prox.maxMinutes;
            const within = list.filter(p => typeof p.driveMinutes === 'number' && p.driveMinutes <= max);
            list = within.length ? within : list.slice(0, 5);
            withinNote = within.length ? { withinMinutes: max } : undefined;
          }
          places = buildPlacesFacts(homeLabel, list, 10, withinNote) || undefined;
          // Record the SAME id→venue mapping the model sees ([P#]), so a "place" suggestion that
          // references an id resolves to this real name + link (and anything off-list is dropped).
          for (const { id, place } of indexedPlaces(list, 10)) {
            groundingFacts.push({ id, name: place.name, url: place.url, kind: 'place' });
          }
        }
        if (eventList.length) {
          eventsNearby = buildEventsFacts(homeLabel, eventList) || undefined;
          for (const { id, event } of indexedEvents(eventList, 12)) {
            groundingFacts.push({ id, name: event.name, url: event.url, kind: 'event', date: event.date });
          }
        }
      }
    }

    // HISTORY FACTS (Pattern 1 grounding): server-computed "days since last visit" from the local
    // visit log — no external fetch/quota (it's the household's own data). Planning queries only.
    let history: string | undefined;
    if (useHarness && Array.isArray(visitLog) && visitLog.length && isPlanningQuery(prompt)) {
      history = buildHistoryFacts(today, visitLog) || undefined;
    }

    // Short conversation memory: flatten the last few chat turns so the model can resolve "that" /
    // "extend it" (the copilot is otherwise stateless per request). Sanitized + capped in the builder.
    const conversation = useHarness ? (buildConversationBlock(chatHistory) || undefined) : undefined;

    // MEALS FACTS: the family's own dinner plan — "what's for dinner (Tuesday)?" reads THIS block.
    const meals = useHarness ? buildMealsFacts(mealplan, today) : undefined;

    // LOCAL KNOWLEDGE FACTS: ground on the household's saved Docs Library. Semantic (embeddings) when
    // RAG_EMBEDDINGS_ENABLED, else keyword — both capped + same block format.
    const localKnowledge = useHarness && Array.isArray(documents) && documents.length
      ? (await buildLocalKnowledgeFactsAsync(documents, prompt) || undefined)
      : undefined;

    // Compact SAVED DOCS list (folder/name) so the model can move_document / delete_document by name.
    const savedDocs = Array.isArray(documents) && documents.length
      ? documents.slice(0, 60).map((d: any) => `${(d?.folder || 'Unfiled')}/${d?.name || ''}`.trim()).filter(Boolean).join('; ')
      : undefined;
    const contextPrompt = useHarness
      ? buildHarnessUserPrompt(today, upcomingEvents, memberNames, prompt, availability || undefined, weather || undefined, history || undefined, conversation, longWeekend, places, eventsNearby, nowLabel, home?.homeLabel, localKnowledge, savedDocs, meals)
      : buildCopilotPrompt(JSON.stringify(upcomingEvents, null, 2), memberNames, today, prompt);
    // Kid-pickable copilot name rides in the household settings blob (`home`) — one appended line so the
    // quick path answers to the family's name for it too. Clamped; only when actually renamed.
    const copilotNickname = String(home?.copilotName || '').split(/\s+/).join(' ').trim().slice(0, 24);
    const nameLine = copilotNickname && copilotNickname.toLowerCase() !== 'copilot'
      ? `\nThe family named you "${copilotNickname}" — refer to yourself by that name.` : '';
    const systemPrompt = (useHarness ? COPILOT_HARNESS_SYSTEM : COPILOT_SYSTEM) + nameLine;

    const meta: { model?: string; usedFallback?: boolean } = {};
    const parsed: any = await callGeminiJSON(
      contextPrompt,
      systemPrompt,
      COPILOT_SCHEMA,
      '{}',
      meta,
      // Mild temperature only. NOT frequency/presence penalties — verified they return
      // 400 "Penalty is not enabled" on the flash-lite fallback models, which would break the
      // fallback chain. The real loop fix is the find-vs-create prompt rule + the `description`
      // field (gives detail a home other than the title) + dedupeActions on the way out.
      { temperature: 0.5 },
    );

    // Critic / Verifier (A7): if the model emitted actions with concrete problems (a chore for a non-member,
    // a past/garbled date, a titleless event), run a BOUNDED corrective loop (≤2 passes) naming the issues so
    // it fixes them — rather than letting sanitizeCopilotActions silently drop the near-miss into a no-op.
    // Each pass must STRICTLY reduce the issue count to be adopted (monotonic → the loop can't thrash), and
    // the loop exits the moment the actions verify clean. KAGGLE_EVAL: self-correction as an iterative loop.
    if (useHarness) {
      // Two issue classes feed ONE bounded corrective loop: malformed actions (verifyActions) and
      // UNBACKED CLAIMS — a reply that says "I've added…" with no matching action (found live via the
      // eval harness on gemini-2.5-flash; per-eval it hit ~30% of explicit commands). The retry gives
      // the model a chance to emit the missing action; the backstop below refuses to let a lie stand.
      const allIssues = (p: any) => [
        ...verifyActions(Array.isArray(p.actions) ? p.actions : [], { memberNames, today }),
        ...verifyActionClaims(String(p.reply || ''), Array.isArray(p.actions) ? p.actions : []),
      ];
      let issues = allIssues(parsed);
      for (let pass = 0; pass < 2 && issues.length; pass++) {
        // Use a THROWAWAY meta for the critic retry so the reported model/usedFallback isn't overwritten by the
        // retry's model when we don't adopt the retry (else telemetry mislabels the kept first answer).
        const retryMeta: any = {};
        const retry: any = await callGeminiJSON(
          `${contextPrompt}\n\n${buildCriticNote(issues)}`, systemPrompt, COPILOT_SCHEMA, '{}', retryMeta, { temperature: 0.3 },
        );
        // Keep the retry only if it actually reduced the problems (else keep the current answer and stop —
        // a pass that can't improve won't improve on a rerun either).
        const retryIssues = retry ? allIssues(retry) : issues;
        if (retryIssues.length >= issues.length) break;
        parsed.actions = retry.actions;
        if (retry.reply) parsed.reply = retry.reply;
        meta.model = retryMeta.model; meta.usedFallback = retryMeta.usedFallback; // adopt → report the retry's model
        issues = retryIssues;
      }
      // Honesty backstop: the loop couldn't recover the action — append the correction so the family
      // never sees a confident "I've added it" with nothing behind it (agent-path convention).
      const correction = unbackedClaimCorrection(String(parsed.reply || ''), Array.isArray(parsed.actions) ? parsed.actions : []);
      if (correction) parsed.reply = `${String(parsed.reply || '')}\n\n${correction}`;
    }

    const sanitized = dedupeActions(sanitizeCopilotActions(parsed.actions, upcomingEvents));
    // Backstop (same guard as the agent path): never stage a delete of an all-day / Holiday-category event the
    // parent didn't explicitly ask to remove — holidays don't block a new plan, so an unrequested delete is a
    // data-loss slip. An explicit "delete/remove/cancel …" in the prompt keeps the delete.
    const { kept: safeActions } = filterUnrequestedHolidayDeletes(
      sanitized, upcomingEvents as any, prompt,
      (a: any) => ({ isDeleteEvent: a?.type === 'delete_event', ref: a?.payload || {} }),
    );
    return res.json({
      answer: parsed.reply || '',
      suggestions: sanitizeSuggestions(parsed.suggestions, upcomingEvents, groundingFacts),
      actions: safeActions,
      model: meta.model,
      usedFallback: !!meta.usedFallback,
    });
  } catch (err: any) {
    console.error('Copilot error:', err);
    return aiErrorResponse(res, err, 'Error occurred during assistant consulting.');
  }
});

/**
 * Exchanges a stored Google refresh token for a fresh access token.
 * Keeps Google Calendar sync working after a page reload (when Supabase no longer
 * exposes provider_token). Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — the
 * same credentials configured for the Supabase Google provider.
 */
app.post('/api/google-refresh', requireAuth, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token is required.' });
    }
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: 'Google client credentials are not configured on the server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).' });
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const data: any = await tokenRes.json();
    if (!tokenRes.ok) {
      // F-06/F-02: log Google's detail server-side; return a generic message (don't echo upstream text,
      // which can confirm token validity to a caller probing tokens).
      console.warn('Google token refresh failed:', data?.error_description || data?.error || tokenRes.status);
      return res.status(400).json({ error: 'Google authorization expired — please reconnect Google.' });
    }
    return res.json({ accessToken: data.access_token, expiresIn: data.expires_in });
  } catch (err: any) {
    console.error('Google token refresh error:', err);
    return res.status(500).json({ error: 'Token refresh error.' });
  }
});

// ── Kroger cart integration ─────────────────────────────────────────────────────────────────────
// OAuth (authorization_code, popup + postMessage like Google connect), store lookup, LLM-validated
// product matching, and the cart write the parent approves in Approvals. Kroger's public API has NO
// checkout/payment endpoint — adding to the cart is the ceiling, so the no-payment invariant holds by
// API contract. All pure logic lives in src/utils/krogerApi.ts (unit-tested); these routes are thin HTTP.
const KROGER_CLIENT_ID = process.env.KROGER_CLIENT_ID || '';
const KROGER_CLIENT_SECRET = process.env.KROGER_CLIENT_SECRET || '';
const krogerConfigured = () => !!(KROGER_CLIENT_ID && KROGER_CLIENT_SECRET);
const krogerBasic = () => 'Basic ' + Buffer.from(`${KROGER_CLIENT_ID}:${KROGER_CLIENT_SECRET}`).toString('base64');
// Callback redirect must EXACTLY match a URI registered in the Kroger portal. Derive it from the
// ORIGIN the browser is actually using (localhost vs LAN IP vs Cloud Run) — a fixed APP_URL broke
// live when the app was browsed via the LAN address (Kroger: "redirect_uri did not match"). The
// token exchange must use the same value, so the callback re-derives it from its own request.
const krogerRedirectUri = (req: any) => {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}/api/kroger/callback`;
};

// Short-lived, single-use handoff of the Kroger refresh token from the OAuth callback to the
// authenticated poll from the app window (see /api/kroger/poll). Keyed by the unguessable `state`
// nonce. Server-side because client popup handoffs (postMessage / shared localStorage / window.close)
// are broken by COOP, privacy extensions, and cross-origin popups — this path can't be. In-memory is
// fine for single-instance (appliance / local dev / min-instances 1); the ~1-minute OAuth window makes
// a cross-instance miss unlikely on the scaled demo.
const krogerPending = new Map<string, { token: string; exp: number }>();
function krogerPendingSweep(): void { const now = Date.now(); for (const [k, v] of krogerPending) if (v.exp < now) krogerPending.delete(k); }

async function krogerToken(body: string): Promise<{ ok: boolean; data: any }> {
  const r = await fetchWithTimeout('https://api.kroger.com/v1/connect/oauth2/token', 10000, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: krogerBasic() },
    body,
  });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

// App-level (client_credentials) token for product/location reads, cached until near expiry.
let krogerAppToken: { token: string; exp: number } | null = null;
async function getKrogerAppToken(): Promise<string | null> {
  if (krogerAppToken && Date.now() < krogerAppToken.exp - 60000) return krogerAppToken.token;
  const { ok, data } = await krogerToken(clientCredentialsBody('product.compact'));
  if (!ok || !data.access_token) return null;
  krogerAppToken = { token: data.access_token, exp: Date.now() + Number(data.expires_in || 1800) * 1000 };
  return krogerAppToken.token;
}

// Auth URL for the connect popup. State is a nonce the client echoes back via postMessage origin checks.
app.get('/api/kroger/auth-url', requireAuth, (req, res) => {
  if (!krogerConfigured()) return res.status(503).json({ error: 'Kroger integration is not configured on the server (KROGER_CLIENT_ID / KROGER_CLIENT_SECRET).' });
  const state = randomBytes(16).toString('hex');
  return res.json({ url: buildKrogerAuthUrl(KROGER_CLIENT_ID, krogerRedirectUri(req), state), state });
});

// OAuth callback: exchange the code, then hand the refresh token to the OPENER window and close.
// The token never touches our storage — the client keeps it per-device in localStorage, the exact
// Google-refresh-token precedent. (postMessage targets the app's own origin only.)
app.get('/api/kroger/callback', async (req, res) => {
  const esc = (s: string) => s.replace(/[<>&"']/g, '');
  if (!krogerConfigured()) return res.status(503).send('Kroger integration not configured.');
  const code = String(req.query.code || '');
  const state = esc(String(req.query.state || ''));
  if (!code) return res.status(400).send('Missing authorization code.');
  try {
    const { ok, data } = await krogerToken(authCodeTokenBody(code, krogerRedirectUri(req)));
    if (!ok || !data.refresh_token) {
      console.warn('[kroger] code exchange failed:', data?.error_description || data?.error || 'unknown');
      return res.status(400).send('Kroger sign-in failed — close this window and try again.');
    }
    // The popup was opened by the app on THIS same origin (the redirect landed here), so the
    // opener's origin == this request's origin — same derivation as the redirect URI itself.
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const appOrigin = `${proto}://${req.get('host')}`;
    // Robust handoff: stash the token server-side keyed by the state nonce; the app window claims it
    // via the authenticated /api/kroger/poll. Not dependent on the browser (COOP/extensions/origin).
    // postMessage stays as an optional fast path but is no longer relied upon.
    if (state) krogerPending.set(state, { token: data.refresh_token, exp: Date.now() + 300000 });
    const payload = JSON.stringify({ source: 'kroger-connect', refreshToken: data.refresh_token, state });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!doctype html><title>Kroger connected</title><body style="font-family:sans-serif">
<p>Kroger connected — you can close this window.</p>
<script>try{window.opener&&window.opener.postMessage(${payload},${JSON.stringify(appOrigin)});}catch(e){}window.close();</script></body>`);
  } catch (err) {
    console.error('[kroger] callback error:', err);
    return res.status(500).send('Kroger sign-in error — close this window and try again.');
  }
});

// The app window polls this after opening the connect popup; returns the refresh token ONCE the
// callback has stashed it (single-use), else {pending:true}. Authenticated — the token is only ever
// handed to a signed-in caller of this household. The unguessable state nonce is the claim key.
app.get('/api/kroger/poll', requireAuth, (req, res) => {
  const state = String(req.query.state || '');
  krogerPendingSweep();
  const entry = state ? krogerPending.get(state) : undefined;
  if (!entry) return res.json({ pending: true });
  krogerPending.delete(state); // single-use — the token now lives only on the claiming device
  return res.json({ refreshToken: entry.token });
});

// Nearby Kroger-banner stores for the Manage picker (app token; household home coords from the client).
app.get('/api/kroger/locations', requireAuth, async (req, res) => {
  if (!krogerConfigured()) return res.status(503).json({ error: 'Kroger integration is not configured.' });
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat and lng are required.' });
  try {
    const tok = await getKrogerAppToken();
    if (!tok) return res.status(502).json({ error: 'Kroger is unavailable right now.' });
    const r = await fetchWithTimeout(`https://api.kroger.com/v1/locations?filter.latLong.near=${lat},${lng}&filter.limit=8`, 10000, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const data = await r.json().catch(() => ({}));
    return res.json({ stores: shapeLocations(data) });
  } catch (err) {
    console.error('[kroger] locations error:', err);
    return res.status(500).json({ error: 'Store lookup failed.' });
  }
});

// Match shopping-list items to real products at the chosen store. Per item: Kroger fuzzy search
// (which happily returns frying pans for "paneer" — verified live) → shaped candidates → ONE
// schema-enforced model call picks an index or -1 → deterministic validation in krogerApi.ts.
app.post('/api/kroger/match', requireAuth, aiRateLimit, async (req, res) => {
  if (!krogerConfigured()) return res.status(503).json({ error: 'Kroger integration is not configured.' });
  const locationId = String(req.body?.locationId || '');
  const items = (Array.isArray(req.body?.items) ? req.body.items : []).map((s: any) => String(s || '').trim()).filter(Boolean).slice(0, 25);
  if (!locationId || !items.length) return res.status(400).json({ error: 'locationId and items are required.' });
  try {
    const tok = await getKrogerAppToken();
    if (!tok) return res.status(502).json({ error: 'Kroger is unavailable right now.' });
    // Search with the CLEANED term — the raw "(1 bulb)"/"(400g pack)" buy-units returned zero/junk
    // candidates and every item silently unmatched (root-caused live 2026-07-06; probe-verified the
    // bare nouns match). Zero hits on a >2-word term get ONE simpler retry (last two words). Search
    // failures are logged per item and carried into the response as honest reasons.
    const candidates: Record<string, ProductCandidate[]> = {};
    const searchFailed = new Set<string>();
    const searchProducts = async (term: string): Promise<ProductCandidate[] | null> => {
      const q = new URLSearchParams({ 'filter.term': term, 'filter.locationId': locationId, 'filter.limit': '5' });
      const r = await fetchWithTimeout(`https://api.kroger.com/v1/products?${q}`, 10000, { headers: { Authorization: `Bearer ${tok}` } });
      if (!r.ok) { console.warn(`[kroger] product search HTTP ${r.status} for term "${term}"`); return null; }
      return shapeProductCandidates(await r.json().catch(() => ({})));
    };
    for (const item of items) {
      const term = krogerSearchTerm(item);
      let found = term ? await searchProducts(term) : [];
      if (found && !found.length) {
        const retry = krogerFallbackTerm(term);
        if (retry) found = await searchProducts(retry);
      }
      if (found === null) { searchFailed.add(item); candidates[item] = []; }
      else {
        candidates[item] = found;
        if (!found.length) console.warn(`[kroger] zero candidates for "${item}" (term "${term}") at ${locationId}`);
      }
    }
    const matchSystem = 'You match grocery-list items to store products. Choose ONLY from the listed candidates; -1 when none truly is the item.';
    const judge = (subset: string[]) => callGeminiJSON(
      buildMatchPrompt(subset, candidates), matchSystem, KROGER_MATCH_SCHEMA, '{}', undefined, { temperature: 0.2 },
    ).catch(() => null);
    let result = validateMatchSelections(await judge(items), items, candidates, searchFailed);
    // Second pass for 'rejected' items only: candidates existed, the sampled judgment said no. A
    // fresh smaller-batch call flips genuine borderline cases (live 2026-07-06: butter/ginger matched
    // on a manual re-send with identical candidates) while real mismatches stay rejected. One extra
    // model call, no re-search; a failed retry merges as a no-op.
    const rejected = result.unmatched.filter(i => result.reasons?.[i] === 'rejected');
    if (rejected.length) result = mergeMatchRetry(result, validateMatchSelections(await judge(rejected), rejected, candidates));
    return res.json(result);
  } catch (err) {
    console.error('[kroger] match error:', err);
    return res.status(500).json({ error: 'Product matching failed.' });
  }
});

// The approved cart write. Refresh token comes from the caller's device (never our storage); the
// quantity clamp + UPC filter live in buildCartAddBody. 204 from Kroger = items are in the cart.
app.post('/api/kroger/cart-add', requireAuth, async (req, res) => {
  if (!krogerConfigured()) return res.status(503).json({ error: 'Kroger integration is not configured.' });
  const refreshToken = String(req.body?.refreshToken || '');
  if (!refreshToken) return res.status(400).json({ error: 'Kroger is not connected on this device.' });
  const body = buildCartAddBody(Array.isArray(req.body?.items) ? req.body.items : []);
  if (!body.items.length) return res.status(400).json({ error: 'No valid items to add.' });
  try {
    const { ok, data } = await krogerToken(refreshTokenBody(refreshToken));
    if (!ok || !data.access_token) {
      console.warn('[kroger] user token refresh failed:', data?.error_description || data?.error || 'unknown');
      return res.status(400).json({ error: 'Kroger authorization expired — reconnect Kroger in Manage.' });
    }
    const r = await fetchWithTimeout('https://api.kroger.com/v1/cart/add', 15000, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.access_token}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.warn('[kroger] cart add failed:', r.status, t.slice(0, 200));
      return res.status(502).json({ error: 'Kroger rejected the cart update — try again in a minute.' });
    }
    // Hand back the fresh refresh token when Kroger rotates it, so the device can keep it current.
    return res.json({ added: body.items.length, ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}) });
  } catch (err) {
    console.error('[kroger] cart add error:', err);
    return res.status(500).json({ error: 'Cart update failed.' });
  }
});


// Grounding services (weather, air, pollen, places, events, geocode) → src/server/grounding.ts

app.post('/api/geocode', requireAuth, async (req, res) => {
  try {
    const raw = String(req.body?.q ?? '').trim();
    const userId = req.user?.id || 'anon';
    if (!withinDataFetchQuota(userId)) return res.status(429).json({ error: 'Too many location lookups — try again in a bit.' });

    // Reverse path (#4): "lat, lng" → "City, State" via the keyless BigDataCloud client endpoint (fixed host →
    // no SSRF surface). Falls back to the coord string on any failure so home-setting never breaks.
    const coord = raw.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
    if (coord) {
      const clat = Number(coord[1]), clng = Number(coord[2]);
      if (!Number.isFinite(clat) || Math.abs(clat) > 90 || !Number.isFinite(clng) || Math.abs(clng) > 180) {
        return res.status(400).json({ error: 'Latitude must be -90 to 90 and longitude -180 to 180.' });
      }
      try {
        const rr = await fetchWithTimeout(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${clat}&longitude=${clng}&localityLanguage=en`);
        if (rr.ok) {
          const d: any = await rr.json();
          const city = String(d?.city || d?.locality || '').trim();
          const st = String((d?.principalSubdivisionCode || '').split('-')[1] || d?.principalSubdivision || '').trim();
          const lbl = [city, st].filter(Boolean).join(', ').replace(/\s+/g, ' ').slice(0, 80);
          if (lbl) return res.json({ label: lbl, lat: clat, lng: clng });
        }
      } catch { /* fall through to the coord-string label */ }
      return res.json({ label: `${clat.toFixed(4)}, ${clng.toFixed(4)}`, lat: clat, lng: clng });
    }

    const zip = parseUsZip(raw);
    if (!zip) return res.status(400).json({ error: 'Enter a 5-digit US ZIP code (e.g. 98074).' });

    // Open-Meteo's geocoder has no postal-code support, so resolve the ZIP via the keyless
    // zippopotam.us (fixed host → no SSRF surface). A missing ZIP returns HTTP 404 there.
    const r = await fetchWithTimeout(`https://api.zippopotam.us/us/${zip}`);
    if (!r.ok) return res.status(404).json({ error: `Couldn't find ZIP "${zip}".` });
    const data: any = await r.json();
    const place = Array.isArray(data?.places) ? data.places[0] : null;
    const lat = Number(place?.latitude);
    const lng = Number(place?.longitude);
    if (!place || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(404).json({ error: `Couldn't find ZIP "${zip}".` });
    }
    // Collapse whitespace + cap length so the place name can't carry newlines into the prompt later.
    const label = [place['place name'], place['state abbreviation']]
      .filter(Boolean).join(', ').replace(/\s+/g, ' ').trim().slice(0, 80);
    return res.json({ label: label || `ZIP ${zip}`, lat, lng });
  } catch (err: any) {
    console.error('Geocode error:', err?.message || err);
    return res.status(500).json({ error: 'Location lookup failed.' });
  }
});


// ── Step-up PIN — pure helpers in src/server/stepUpPin.ts; stateful limiters below ──────────────
const STEPUP_VERIFY_PER_MIN = Number(process.env.STEPUP_VERIFY_PER_MIN) || 5;
const stepUpHits = new Map<string, { count: number; resetAt: number }>();
const STEPUP_LOCK_MAX_FAILS = 5;
const STEPUP_LOCK_MS = 10 * 60_000;
const stepUpFails = new Map<string, { fails: number; lockUntil: number }>();
const STEPUP_SET_PER_5MIN = Number(process.env.STEPUP_SET_PER_5MIN) || 3;
const stepUpSetHits = new Map<string, { count: number; resetAt: number }>();

// Set/replace the household PIN: hash it server-side, hand back {hash,salt} for the client to persist.
app.post('/api/stepup/set', requireAuth, (req, res) => {
  const key = req.user?.id || req.ip || 'anon';
  const now = Date.now();
  pruneExpired(stepUpSetHits, now);
  const { allowed, entry } = checkRateWindow(stepUpSetHits.get(key), now, STEPUP_SET_PER_5MIN, 5 * 60_000);
  stepUpSetHits.set(key, entry);
  if (!allowed) return res.status(429).json({ error: 'Too many PIN changes — wait a few minutes.', retryable: true });
  const pin = req.body?.pin;
  if (!isValidPin(pin)) return res.status(400).json({ error: 'PIN must be 4–8 digits.' });
  const salt = randomBytes(16).toString('hex');
  return res.json({ hash: hashStepUpPin(String(pin), salt), salt });
});

// Verify a submitted PIN against the stored {hash,salt}. Rate-limited per user to blunt brute force.
app.post('/api/stepup/verify', requireAuth, (req, res) => {
  const key = req.user?.id || req.ip || 'anon';
  const now = Date.now();
  pruneExpired(stepUpHits, now);
  const { allowed, entry } = checkRateWindow(stepUpHits.get(key), now, STEPUP_VERIFY_PER_MIN, 60_000);
  stepUpHits.set(key, entry);
  if (!allowed) return res.status(429).json({ error: 'Too many PIN attempts — wait a minute.', retryable: true });
  // Failure lockout (layer 2): while locked, refuse WITHOUT verifying — a locked window leaks nothing
  // about further guesses, right or wrong.
  const lockEntry = stepUpFails.get(key);
  if (lockEntry && lockEntry.lockUntil > now) {
    return res.status(429).json({ error: 'Too many wrong PINs — PIN entry is locked for 10 minutes.', retryable: true });
  }
  if (stepUpFails.size >= 256) for (const [k, v] of stepUpFails) if (v.lockUntil <= now) stepUpFails.delete(k); // same bounded-Map paranoia as pruneExpired
  const { pin, hash, salt } = req.body || {};
  const valid = verifyStepUpPin(String(pin ?? ''), String(hash ?? ''), String(salt ?? ''));
  const nextLock = nextPinLockEntry(lockEntry, valid, now);
  if (nextLock) stepUpFails.set(key, nextLock); else stepUpFails.delete(key);
  return res.json({ valid });
});


// ── Email scan (capabilities B1 bills + B2 packages) — provider-agnostic ingestion ──────────────
// Reads ONLY bill/shipment-shaped mail (tight per-capability filter), parses in-memory, returns
// tap-to-add reminder suggestions. The email body is NEVER persisted (owner-consented privacy model).
// gmail.googleapis.com is a fixed host (no SSRF surface). The client passes a Google access token.
// GmailAdapter only for now; a Microsoft Graph adapter (live.com/outlook.com) slots in behind the
// same NormalizedMessage shape later.

// Shared Gmail fetch: list by query + get each (full) + normalize. Returns messages plus an optional
// {status,error} when the read failed (caller checks scan.error).
async function gmailScan(accessToken: string, query: string, maxResults = 30):
  Promise<{ messages: NormalizedMessage[]; status?: number; error?: string }> {
  const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
  const q = encodeURIComponent(query);
  const listR = await fetchWithTimeout(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${maxResults}`, 8000, auth);
  if (!listR.ok) {
    if (listR.status === 401 || listR.status === 403) return { messages: [], status: 403, error: 'Gmail access not granted — sign out and back in to allow email reading.' };
    return { messages: [], status: 502, error: 'Could not read email right now.' };
  }
  const listData: any = await listR.json();
  const ids: string[] = (Array.isArray(listData?.messages) ? listData.messages : []).slice(0, maxResults).map((m: any) => m?.id).filter(Boolean);
  const messages: NormalizedMessage[] = [];
  for (const id of ids) {
    try {
      const r = await fetchWithTimeout(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, 8000, auth);
      if (r.ok) messages.push(normalizeGmail(await r.json()));
    } catch (e: any) {
      // One slow/aborted message must NOT abort the whole scan — skip it and keep the rest.
      console.warn('gmailScan: skipped a message:', e?.message || e);
    }
  }
  return { messages };
}

// Microsoft Graph scan (Outlook / live.com / hotmail). Unlike Gmail there's no equivalent of the
// Gmail-syntax pre-filter query here, so it fetches the most recent N messages and lets the per-capability
// AI parser filter (it already discards non-bills / non-newsletters). Same NormalizedMessage output.
async function graphScan(accessToken: string, maxResults = 30):
  Promise<{ messages: NormalizedMessage[]; status?: number; error?: string }> {
  const url = `https://graph.microsoft.com/v1.0/me/messages?$top=${maxResults}`
    + `&$select=from,subject,receivedDateTime,bodyPreview,body&$orderby=receivedDateTime desc`;
  const r = await fetchWithTimeout(url, 8000, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) return { messages: [], status: 403, error: 'Outlook access not granted — reconnect your Microsoft account.' };
    return { messages: [], status: 502, error: 'Could not read email right now.' };
  }
  const data: any = await r.json();
  const messages = (Array.isArray(data?.value) ? data.value : []).slice(0, maxResults).map(normalizeGraph);
  return { messages };
}

// Provider-agnostic inbox fetch: Microsoft Graph when an x-graph-token is present, else Gmail. The query is
// Gmail-syntax (ignored by Graph). Returns the SAME shape so the scan endpoints don't branch on provider.
async function fetchInbox(req: express.Request, query: string, maxResults = 30):
  Promise<{ messages: NormalizedMessage[]; status?: number; error?: string }> {
  const graphToken = String(req.headers['x-graph-token'] || '');
  if (graphToken) return graphScan(graphToken, maxResults);
  const googleToken = String(req.headers['x-google-token'] || '');
  if (googleToken) return gmailScan(googleToken, query, maxResults);
  return { messages: [], status: 400, error: 'Connect your Google or Microsoft account to scan email.' };
}

// Dedupe suggestions by date|title and cap (shared by both scans).
function dedupeSuggestions<T extends { start: string; title: string }>(list: (T | null)[], cap = 20): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of list) {
    if (!s) continue;
    const k = `${s.start}|${s.title.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

const BILL_SYSTEM = 'You extract bills / payment-due items from emails into strict JSON. Never invent amounts or dates; omit any field you cannot read.';
const BILL_SCHEMA = {
  type: Type.OBJECT,
  properties: { bills: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
    payee: { type: Type.STRING }, amount: { type: Type.STRING }, dueDate: { type: Type.STRING }, account: { type: Type.STRING },
    confidence: { type: Type.NUMBER, description: 'Your 0-1 confidence this is a REAL bill with correctly-read fields. Use below 0.5 when unsure — such rows are discarded.' },
  }, required: ['payee'] } } },
  required: ['bills'],
};

// Email scans run on adversarial/spammy inbox content that trips flash models into repetition loops (a
// free-text field ballooning into thousands of repeated tokens — seen burning the prepay credits once the app
// went cloud-only). Two guards: EMAIL_SCAN_DISABLED kills the whole scan path (auto + manual) — the credit-burn
// off-switch for the cloud-only deploy; SCAN_GENCONFIG caps each call's output HARD at 1k (these JSON results
// need ~1k, not the 8k default) so a loop truncates fast and cheap. (No frequency/presence penalties — they 400
// on the flash-lite chain models; see the copilot note ~L1685.)
const EMAIL_SCAN_DISABLED = process.env.EMAIL_SCAN_DISABLED === 'true';
const SCAN_GENCONFIG = { maxOutputTokens: 1024 };
// Local-slot override for the scans (Phase-3): a thinking local model burns its budget on reasoning
// tokens, so 1k truncates mid-JSON — give the LOCAL slot 4k with THINK=low instead (the cloud call
// keeps the hard 1k anti-runaway cap above; local tokens are free, the cap there bounds LATENCY).
const SCAN_LOCAL_OPTS = { local: { maxOutputTokens: 4096, think: 'low' as const } };
// Phase-3 confidence gate: each scan row self-reports a 0-1 confidence (prompted + in-schema); an
// explicitly LOW score (<0.5) drops the row before it becomes a suggestion. Rows without the field
// pass — the gate targets a weak model's dutiful-but-unsure extractions, not schema drift.
const confidentRows = <T,>(rows: T[]): T[] =>
  rows.filter(r => typeof (r as { confidence?: unknown })?.confidence !== 'number' || (r as { confidence: number }).confidence >= 0.5);

app.post('/api/scan-bills', requireAuth, aiRateLimit, async (req, res) => {
  if (EMAIL_SCAN_DISABLED) return res.json({ suggestions: [], bills: [], scanned: 0 });
  try {
    const today = new Date().toLocaleDateString('en-CA');
    const scan = await fetchInbox(req, buildBillQuery());
    if (scan.error) return res.status(scan.status || 502).json({ error: scan.error });
    if (!scan.messages.length) return res.json({ suggestions: [], scanned: 0 });
    let parsed: any;
    try { parsed = await callGeminiJSON(buildBillParsePrompt(scan.messages), BILL_SYSTEM, BILL_SCHEMA, '{"bills":[]}', undefined, SCAN_GENCONFIG, SCAN_LOCAL_OPTS); }
    catch (e: any) {
      console.warn('scan-bills parse failed:', e?.message || e);
      return res.status(503).json({ error: 'The AI is busy — try the scan again in a moment.', retryable: true });
    }
    const bills: ParsedBill[] = confidentRows(Array.isArray(parsed?.bills) ? parsed.bills : []);
    const suggestions = dedupeSuggestions(bills.map(b => billToSuggestion(b, today)));
    // Also return the raw parsed bills so the client can PERSIST them to the `bills` collection (the
    // agent's get_bills reads that) — parsed fields only, never the email body.
    return res.json({ suggestions, bills, scanned: scan.messages.length });
  } catch (err: any) {
    console.error('scan-bills error:', err?.message || err);
    return res.status(500).json({ error: 'Bill scan failed.' });
  }
});

const NEWSLETTER_SYSTEM = 'You filter bulk/newsletter emails for a family knowledge library, keeping only genuinely useful LOCAL/community content. Output strict JSON; never invent details.';
const NEWSLETTER_CLASSIFY_SCHEMA = {
  type: Type.OBJECT,
  properties: { items: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
    index: { type: Type.NUMBER }, keep: { type: Type.BOOLEAN }, title: { type: Type.STRING }, summary: { type: Type.STRING },
  }, required: ['index', 'keep'] } } },
  required: ['items'],
};

// Newsletter ingestion → the Docs Library corpus. Scan a wider window, then ONE Gemini pass classifies each
// email: keep only genuinely-useful LOCAL/community content (drops the random promo/transactional mail that
// was cluttering Docs) and rewrites the kept ones with a clean title + summary. Returns normalized messages;
// the client persists them into `documents`. On AI failure we fall back to the raw scan (best-effort).
app.post('/api/scan-newsletters', requireAuth, aiRateLimit, async (req, res) => {
  if (EMAIL_SCAN_DISABLED) return res.json({ newsletters: [], scanned: 0 });
  try {
    const scan = await fetchInbox(req, buildNewsletterQuery(), 30);
    if (scan.error) return res.status(scan.status || 502).json({ error: scan.error });
    if (!scan.messages.length) return res.json({ newsletters: [], scanned: 0 });
    // `ran` distinguishes "the classifier produced verdicts" from "the call threw". On a thrown error we fall
    // back to the raw scan (best-effort); if it RAN we honor its verdicts — an empty/garbled result then keeps
    // NOTHING rather than re-dumping raw promo mail (the exact regression P4 set out to kill).
    let byIndex = new Map<number, { keep?: boolean; title?: string; summary?: string }>();
    let ran = false;
    try {
      const parsed = await callGeminiJSON(buildNewsletterClassifyPrompt(scan.messages), NEWSLETTER_SYSTEM, NEWSLETTER_CLASSIFY_SCHEMA, '{"items":[]}', undefined, SCAN_GENCONFIG, SCAN_LOCAL_OPTS);
      ran = true;
      // Join by the model-echoed 1-based "index" (matches "Email N"), NOT array position — so a dropped or
      // reordered verdict can't staple the wrong title/keep onto the wrong email.
      for (const v of (Array.isArray(parsed?.items) ? parsed.items : [])) {
        if (typeof v?.index === 'number') byIndex.set(v.index, v);
      }
    } catch (e: any) {
      console.warn('scan-newsletters classify failed — keeping raw scan:', e?.message || e);
    }
    const newsletters = scan.messages
      .map((m, i) => ({ m, v: byIndex.get(i + 1) }))
      .filter(({ v }) => (ran ? v?.keep === true : true))
      .map(({ m, v }) => ({ ...m, subject: v?.title?.trim() || m.subject, snippet: v?.summary?.trim() || m.snippet }));
    return res.json({ newsletters, scanned: scan.messages.length });
  } catch (err: any) {
    console.error('scan-newsletters error:', err?.message || err);
    return res.status(500).json({ error: 'Newsletter scan failed.' });
  }
});

const PACKAGE_SYSTEM = 'You extract incoming package / delivery info from emails into strict JSON. Never invent dates; omit any field you cannot read.';
const PACKAGE_SCHEMA = {
  type: Type.OBJECT,
  properties: { packages: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
    carrier: { type: Type.STRING }, item: { type: Type.STRING }, eta: { type: Type.STRING }, trackingNumber: { type: Type.STRING },
    confidence: { type: Type.NUMBER, description: 'Your 0-1 confidence this is a REAL incoming delivery with correctly-read fields. Use below 0.5 when unsure — such rows are discarded.' },
  } } } },
  required: ['packages'],
};

app.post('/api/scan-packages', requireAuth, aiRateLimit, async (req, res) => {
  if (EMAIL_SCAN_DISABLED) return res.json({ suggestions: [], scanned: 0 });
  try {
    const today = new Date().toLocaleDateString('en-CA');
    const scan = await fetchInbox(req, buildPackageQuery());
    if (scan.error) return res.status(scan.status || 502).json({ error: scan.error });
    if (!scan.messages.length) return res.json({ suggestions: [], scanned: 0 });
    let parsed: any;
    try { parsed = await callGeminiJSON(buildPackageParsePrompt(scan.messages), PACKAGE_SYSTEM, PACKAGE_SCHEMA, '{"packages":[]}', undefined, SCAN_GENCONFIG, SCAN_LOCAL_OPTS); }
    catch (e: any) {
      console.warn('scan-packages parse failed:', e?.message || e);
      return res.status(503).json({ error: 'The AI is busy — try the scan again in a moment.', retryable: true });
    }
    const pkgs: ParsedPackage[] = confidentRows(Array.isArray(parsed?.packages) ? parsed.packages : []);
    const suggestions = dedupeSuggestions(pkgs.map(p => packageToSuggestion(p, today)));
    return res.json({ suggestions, scanned: scan.messages.length });
  } catch (err: any) {
    console.error('scan-packages error:', err?.message || err);
    return res.status(500).json({ error: 'Package scan failed.' });
  }
});

const KIDS_SYSTEM = "You extract kids' scheduled activities/events from emails into strict JSON. Never invent dates; omit any field you cannot read.";
const KIDS_SCHEMA = {
  type: Type.OBJECT,
  properties: { activities: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
    title: { type: Type.STRING }, date: { type: Type.STRING }, time: { type: Type.STRING }, location: { type: Type.STRING }, category: { type: Type.STRING },
    confidence: { type: Type.NUMBER, description: 'Your 0-1 confidence this is a REAL scheduled kids activity with correctly-read fields. Use below 0.5 when unsure — such rows are discarded.' },
  }, required: ['title'] } } },
  required: ['activities'],
};

app.post('/api/scan-kids', requireAuth, aiRateLimit, async (req, res) => {
  if (EMAIL_SCAN_DISABLED) return res.json({ suggestions: [], scanned: 0 });
  try {
    const today = new Date().toLocaleDateString('en-CA');
    const scan = await fetchInbox(req, buildKidsActivityQuery());
    if (scan.error) return res.status(scan.status || 502).json({ error: scan.error });
    if (!scan.messages.length) return res.json({ suggestions: [], scanned: 0 });
    let parsed: any;
    try { parsed = await callGeminiJSON(buildKidsActivityParsePrompt(scan.messages), KIDS_SYSTEM, KIDS_SCHEMA, '{"activities":[]}', undefined, SCAN_GENCONFIG, SCAN_LOCAL_OPTS); }
    catch (e: any) {
      console.warn('scan-kids parse failed:', e?.message || e);
      return res.status(503).json({ error: 'The AI is busy — try the scan again in a moment.', retryable: true });
    }
    const acts: ParsedActivity[] = confidentRows(Array.isArray(parsed?.activities) ? parsed.activities : []);
    const suggestions = dedupeSuggestions(acts.map(a => activityToSuggestion(a, today)));
    return res.json({ suggestions, scanned: scan.messages.length });
  } catch (err: any) {
    console.error('scan-kids error:', err?.message || err);
    return res.status(500).json({ error: "Kids' activity scan failed." });
  }
});

// ── B6 camera-footage summaries (SCAFFOLD) ── event-triggered HA camera.snapshot → local vision
// model → "notable?" summary. Needs Home Assistant (C2) + a local vision model on GPU0 (C1). Stubbed
// until those land.
app.post('/api/camera-summary', requireAuth, (_req, res) =>
  res.status(501).json({ error: 'Camera summaries are not configured yet (needs Home Assistant + a local vision model).' }));

// ── Morning briefing (on-demand preview) ── the same §7a morning agent the scheduler runs, demoable
// without waiting for the cron: deterministic agenda + nudges, the ADK-concierge-authored narrative,
// AND the MORNING PLANNER's validated proposals. Proposals come back as stage-ready shapes (tool +
// summary + payload + goalId) with NO ids/stamps — the CLIENT stages them under the visitor's own
// RLS-scoped identity (no service-role in this path), still confirm-tier, still parent-approved.
app.post('/api/morning-briefing', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const { events = [], chores = [], goals = [], shopping = [], ledger = [], mealplan = [] } = req.body || {};
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const evList = Array.isArray(events) ? events : [];
    const chList = Array.isArray(chores) ? chores : [];
    // mealplan = MealPlan[] (the client sends the collection); buildDinnerLines picks the newest
    // week's plans itself (one per meal — breakfast/lunch/dinner lines as covered).
    const briefing = buildBriefing(evList, chList, today, 14, Array.isArray(mealplan) ? mealplan : []);
    // The ADK concierge AUTHORS the narrative from the deterministically-extracted facts, so the in-app
    // preview is genuinely agent-generated (matching the emailed digest). Best-effort: if the agent is
    // unreachable, agentSummary stays undefined and the card renders the structured briefing (title/lines/
    // nudges with their 1-tap actions) exactly as before.
    briefing.agentSummary = (await composeBriefingViaAgent(briefingToText(briefing), today)) || undefined;
    // Morning planner (best-effort, same guard rails as the digest path): empty proposals on any failure.
    let proposals: unknown[] = [];
    try {
      const shList = (Array.isArray(shopping) ? shopping : []).slice(0, 100);
      const glList = (Array.isArray(goals) ? goals : []).slice(0, 20);
      const lgList = (Array.isArray(ledger) ? ledger : []).slice(-100);
      const plannerStores = sanitizeStoreList(req.body?.stores); // household lists (Phase-5)
      const facts = buildMorningFacts({ today, agendaText: briefingToText(briefing), chores: chList, shopping: shList, goals: glList, pendingLedger: lgList });
      const raw = await callGeminiJSON(facts, MORNING_PLANNER_SYSTEM, buildMorningPlannerSchema(plannerStores), '{"proposals":[]}', undefined, MORNING_GENCONFIG);
      proposals = validateMorningProposals(raw?.proposals, { today, shopping: shList, pendingLedger: lgList, goals: glList, factsText: facts, stores: plannerStores });
    } catch (e: any) {
      console.warn('[morning-briefing] planner skipped:', e?.message || e);
    }
    return res.json({ ...briefing, proposals });
  } catch (err: any) {
    console.error('morning-briefing error:', err?.message || err);
    return res.status(500).json({ error: 'Could not build the briefing.' });
  }
});

// ── Concierge ADK agent proxy ───────────────────────────────────────────────────
// The React panel calls this SAME-ORIGIN route, NOT the Python agent directly: a direct browser fetch to
// the agent's own origin/IP is blocked by the prod CSP (connect-src 'self'), and same-origin also avoids
// CORS + baking the agent URL into the client bundle. We forward to the ADK service (AGENT_BASE_URL),
// passing the caller's Supabase JWT so the agent's MCP writes are RLS-scoped to that visitor. requireAuth
// (signed-in only) + aiRateLimit (it drives Gemini — cost-bearing, same as the other AI routes).
const AGENT_BASE_URL = (process.env.AGENT_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');

// Forward ONE chat turn to the ADK service — the single shared implementation for the sync proxy below
// AND the async job worker (extracted so the two paths can't drift on headers/body handling). The caller's
// JWT rides along so the agent's MCP writes stay RLS-scoped to that visitor.
async function forwardAgentChat(authHeader: string, body: unknown): Promise<{ status: number; text: string }> {
  const upstream = await fetch(`${AGENT_BASE_URL}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader, // the visitor's JWT (validated by requireAuth)
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: upstream.status, text: await upstream.text() };
}

app.post('/api/agent/chat', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const upstream = await forwardAgentChat(req.headers.authorization as string, req.body);
    // Pass the agent's JSON ({reply,sessionId} or its error) straight through with its status.
    res.status(upstream.status).type('application/json').send(upstream.text);
  } catch (err) {
    return aiErrorResponse(res, err, 'The concierge agent is unavailable right now.');
  }
});

// ── Async agent jobs (roadmap "Backlog High — Async agent jobs") ────────────────
// POST /api/agent/chat-async queues a job row and returns { jobId } IMMEDIATELY; an in-process worker
// runs the SAME forwardAgentChat the sync route uses and marks the row done/error. The client polls
// GET /api/agent/job/:id (askConciergeAgentAsync) — no held-open HTTP request, no spinner-length turn.
//
// SCOPE (deliberate): the worker is in-process and runs NOW, within the caller's JWT lifetime — no
// durable queue, no webhooks. If the server dies mid-turn the row stays 'running'; the client poller
// times out honestly (~3 min). See src/storage/agentJobs.ts for the store + the same note.

// Per-request store: LOCAL_MODE scopes by the box session's household over SQLite (app-enforced filter);
// cloud mode builds a JWT-scoped Supabase client — the SAME per-visitor-RLS pattern the MCP child uses
// (src/mcp/persistence.ts) — so Postgres RLS enforces the household boundary on every job row. Returns
// null when the caller has no household yet (cloud first-run edge; the routes turn that into a 403).
async function agentJobStoreFor(req: Request): Promise<AgentJobStore | null> {
  if (LOCAL_MODE) return new SqliteAgentJobStore(getSqliteAdapter(), req.householdId!);
  const token = String(req.headers.authorization || '').slice(7); // "Bearer " — validated by requireAuth
  const client = createClient(
    process.env.VITE_SUPABASE_URL || '',
    process.env.VITE_SUPABASE_ANON_KEY || '',
    { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } },
  );
  const hid = await lookupHouseholdId(client);
  return hid ? new SupabaseAgentJobStore(client, hid) : null;
}

app.post('/api/agent/chat-async', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'A message is required.' });
    const store = await agentJobStoreFor(req);
    if (!store) return res.status(403).json({ error: 'No household found for this account.' });
    const jobId = randomUUID();
    await store.insert(jobId, message); // throws pre-migration on cloud → clean 500 below, nothing queued
    const authHeader = req.headers.authorization as string;
    const body = req.body; // the FULL turn body (sessionId/history/goals/…) — same contract as /chat
    // The in-process worker — deliberately NOT awaited, so { jobId } returns immediately. Every failure
    // path lands the row in 'error' with an honest message; if even that write fails (process-level
    // trouble), log it — the row stays 'running' and the client poller times out rather than hanging.
    void (async () => {
      try {
        await store.update(jobId, { status: 'running' });
        const upstream = await forwardAgentChat(authHeader, body);
        if (upstream.status >= 200 && upstream.status < 300) {
          let data: any = {};
          try { data = JSON.parse(upstream.text); } catch { /* non-JSON 2xx — treat fields as absent */ }
          await store.update(jobId, {
            status: 'done',
            reply: String(data?.reply ?? ''),
            actions: Array.isArray(data?.actions) ? data.actions : [],
            ...(data?.model ? { model: String(data.model) } : {}),
            ...(data?.sessionId ? { sessionId: String(data.sessionId) } : {}),
          });
        } else {
          // Surface the agent's own error text when it sent one; otherwise an honest status line.
          let msg = `The agent returned HTTP ${upstream.status}.`;
          try { const e = JSON.parse(upstream.text); if (e?.error) msg = String(e.error); } catch { /* keep the status line */ }
          await store.update(jobId, { status: 'error', reply: msg });
        }
      } catch (err: any) {
        console.error('agent job worker error:', err?.message || err);
        try { await store.update(jobId, { status: 'error', reply: 'The concierge agent is unavailable right now.' }); }
        catch (e2: any) { console.error('agent job error-write failed (job stays running):', e2?.message || e2); }
      }
    })();
    return res.json({ jobId });
  } catch (err: any) {
    console.error('agent chat-async error:', err?.message || err);
    return res.status(500).json({ error: 'Could not queue the agent request.' });
  }
});

// Poll a job. Household scoping is the storage layer's invariant (SQLite: app-enforced household_id
// filter; cloud: RLS via the caller's JWT-scoped client + the explicit filter) — another household's
// job id is indistinguishable from a nonexistent one (404), by design.
app.get('/api/agent/job/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: 'Invalid job id.' });
    const store = await agentJobStoreFor(req);
    if (!store) return res.status(403).json({ error: 'No household found for this account.' });
    const job = await store.get(id);
    if (!job) return res.status(404).json({ error: 'No such job.' });
    return res.json(job); // { id, status, message, reply, actions, model, sessionId, createdAt, updatedAt }
  } catch (err: any) {
    console.error('agent job read error:', err?.message || err);
    return res.status(500).json({ error: 'Could not read the job.' });
  }
});


// Set up Dev server vs Static serving for client React
async function startServer() {
  // Fail fast on missing required config — otherwise the server boots "successfully" and then EVERY
  // request 401s/500s (auth/AI unreachable) with nothing in the log pointing at the cause.
  const localLlm = /^(1|true|yes|on)$/i.test(process.env.LOCAL_LLM_ENABLED || '');
  const required: [string, boolean][] = [
    // Supabase creds are required ONLY in cloud mode. The LAN appliance (LOCAL_MODE = SQLite) has no
    // Supabase, so demanding them would block the box from booting — skip them when LOCAL_MODE.
    ['VITE_SUPABASE_URL', LOCAL_MODE || !!process.env.VITE_SUPABASE_URL],
    ['VITE_SUPABASE_ANON_KEY', LOCAL_MODE || !!process.env.VITE_SUPABASE_ANON_KEY],
    ['GEMINI_API_KEY', !!process.env.GEMINI_API_KEY || localLlm], // optional only if a local model is the primary
  ];
  const missing = required.filter(([, ok]) => !ok).map(([name]) => name);
  if (missing.length) {
    console.error(`FATAL: missing required environment variable(s): ${missing.join(', ')}. `
      + `Set them in .env (see .env.example) and restart.`);
    process.exit(1);
  }

  // Announce the resolved storage backend at boot. storageMode() auto-detects Supabase whenever
  // VITE_SUPABASE_URL is set with no explicit STORAGE — log the decision so that fallback is never
  // silent (a box landing on the wrong backend is otherwise invisible until requests misbehave).
  const explicitStorage = (process.env.STORAGE || '').trim().toLowerCase();
  console.log(`[storage] mode=${STORAGE_MODE} `
    + `(${explicitStorage === 'sqlite' || explicitStorage === 'supabase'
        ? `STORAGE=${explicitStorage}` : `auto-detected from ${process.env.VITE_SUPABASE_URL ? 'VITE_SUPABASE_URL' : 'no Supabase config'}`})`
    + `${LOCAL_MODE ? ` · SQLite at ${process.env.SQLITE_PATH || './data/famhub.db'}` : ''}`);

  if (process.env.NODE_ENV !== "production") {
    console.log('Running in DEVELOPMENT mode. Loading Vite dev middleware.');
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        // Vite watches the WHOLE project root and falls back to a FULL PAGE RELOAD for any changed file
        // that isn't in the client module graph. So editing a doc (.md), the Python agent, or a test was
        // reloading the running app and wiping in-memory state (the copilot chat, the agent session, goal
        // context). Ignore everything the React client never imports, so only real src changes HMR.
        watch: {
          ignored: [
            '**/node_modules/**', '**/.git/**',
            '**/*.md', '**/docs/**', '**/planning/**',           // docs — never imported by the client
            '**/agent/**', '**/*.py', '**/__pycache__/**', '**/.pytest_cache/**', // the Python agent
            '**/__tests__/**', '**/*.test.*',                    // tests — don't affect the running app
          ],
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    console.log('Running in PRODUCTION mode. Serving static assets.');
    const distPath = path.join(process.cwd(), 'dist');
    const indexHtmlPath = path.join(distPath, 'index.html');
    if (!existsSync(indexHtmlPath)) {
      throw new Error(`Production mode but ${indexHtmlPath} is missing — run "npm run build" first.`);
    }
    // Vite content-hashes asset filenames, so they're safe to cache for a year (immutable).
    // index.html itself must NOT be long-cached (it points at the hashed assets) — express.static
    // serves it with the default no-long-cache, and the SPA fallback below re-sends it fresh.
    app.use(express.static(distPath, { maxAge: '1y', immutable: true, index: false }));
    // Inject the RUNTIME web config into index.html so ONE built image runs against any backend — cloud
    // Supabase OR the local SQLite appliance — without baking VITE_* at build time ("build once, deploy
    // anywhere"). The client reads window.__APP_CONFIG__ (falling back to import.meta.env in dev). Cached:
    // the server env is fixed for the process lifetime.
    let indexHtmlInjected: string | null = null;
    app.get('*', (_req, res) => {
      if (indexHtmlInjected == null) {
        const raw = readFileSync(path.join(distPath, 'index.html'), 'utf8');
        // APP_CONFIG_SCRIPT is the module-level constant the CSP script-src hash was computed from —
        // injecting anything else here would be blocked by that hash.
        indexHtmlInjected = raw.replace('</head>', `<script>${APP_CONFIG_SCRIPT}</script></head>`);
      }
      res.type('html').send(indexHtmlInjected);
    });
  }

  // Cloud Scheduler trigger for the daily digest: an external cron POSTs here (one trigger source → no
  // multi-instance double-send, the issue the in-process interval has). Gated by a shared secret header so
  // only the scheduler can fire it. Per-household work is best-effort + logged inside runDailyDigest.
  app.post('/internal/run-digest', async (req, res) => {
    const secret = process.env.DIGEST_TRIGGER_SECRET;
    if (!secret) return res.status(404).json({ error: 'Digest trigger not enabled.' });
    if (secret.length < 32) { // refuse a weak/typo'd secret rather than gate behind it
      console.error('[digest] DIGEST_TRIGGER_SECRET is too short (<32 chars) — refusing to enable the trigger.');
      return res.status(503).json({ error: 'Digest trigger misconfigured.' });
    }
    const provided = String(req.headers['x-digest-secret'] || '');
    // Hash both sides to a fixed width before timingSafeEqual → constant-time regardless of input length
    // (no length-leak from the buffer-length check timingSafeEqual would otherwise require).
    const ok = timingSafeEqual(createHash('sha256').update(provided).digest(), createHash('sha256').update(secret).digest());
    if (!ok) return res.status(401).json({ error: 'Unauthorized.' });
    try {
      await runDailyDigest();
      return res.json({ ok: true });
    } catch (e: any) {
      console.error('[digest] /internal/run-digest failed:', e?.message || e);
      return res.status(500).json({ error: 'Digest run failed.' });
    }
  });

  // Centralized error handler (must be the LAST middleware): a route that throws synchronously or forwards an
  // error via next(err) lands here instead of crashing the process or leaking a stack to the client. The
  // per-route try/catch blocks still handle their own async rejections; this is the backstop. F-06 parity:
  // generic body, detail logged server-side.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled request error:', err?.stack || err?.message || err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Something went wrong.' });
  });

  // A stray unhandled promise rejection: log it. In a CONTAINER (appliance Docker / Cloud Run) exit so the
  // orchestrator recycles a process that may be in a bad state (gated by EXIT_ON_UNHANDLED, which the
  // appliance compose + Cloud Run set; K_SERVICE is Cloud Run's own marker). On the bare LAN kiosk, keep the
  // always-on server up (the offending request already failed via its own catch / the middleware above).
  process.on('unhandledRejection', reason => {
    console.error('Unhandled promise rejection:', reason);
    if (process.env.EXIT_ON_UNHANDLED === 'true' || process.env.K_SERVICE) process.exit(1);
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is booted successfully on http://0.0.0.0:${PORT}`);
  });

  startDigestScheduler();
}

// Daily-digest scheduler + runner → src/server/digest.ts

if (!process.env.VITEST) {
  startServer();
}
