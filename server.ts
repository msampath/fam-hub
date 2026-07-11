import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import compression from 'compression';
import helmet from 'helmet';
import path from 'path';
import { readFileSync, existsSync, promises as fsp } from 'node:fs';
import dotenv from 'dotenv';
import { randomUUID, timingSafeEqual, createHash } from 'crypto';
import { Type } from '@google/genai';
import { createClient, type User } from '@supabase/supabase-js';
// NOTE: `vite` is imported DYNAMICALLY in the dev branch below (not here) so it can be a devDependency and
// stay out of the production runtime image — the dev middleware never loads in production.
import { buildCopilotPrompt, COPILOT_SYSTEM, COPILOT_HARNESS_SYSTEM, COPILOT_SCHEMA } from './src/utils/copilotPrompt';
import { buildHarnessUserPrompt, buildConversationBlock, buildMealsFacts, addDaysISO } from './src/utils/copilotHarness';
import { buildLocalKnowledgeFactsAsync } from './src/utils/localKnowledge';
import { verifyActions, buildCriticNote, verifyActionClaims, unbackedClaimCorrection } from './src/utils/copilotCritic';
import { verifyQuickAdd, buildQuickAddCriticNote, coerceQuickAdd } from './src/utils/quickAddCritic';
import { krogerRouter } from './src/server/kroger';
import { emailScanRouter } from './src/server/emailScan';
import { stepUpRouter } from './src/server/stepUpRoutes';
import { agentProxyRouter } from './src/server/agentProxy';
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
import { requireAuth, aiRateLimit, preAuthThrottle } from './src/server/middleware';
import { withinDataFetchQuota, fetchWeatherDaily, fetchAirQualityDaily, fetchPollenDaily, fetchNearbyPlaces, attachTravelTimes, fetchLocalEvents, parseUsZip } from './src/server/grounding';
import { runDailyDigest, startDigestScheduler, briefingToText, composeBriefingViaAgent } from './src/server/digest';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { hasUsableText } from './src/utils/pdfText';
// Single-click LAN appliance: local SQLite storage + local household auth (no Supabase). See src/storage/.
import { storageMode, getSqliteAdapter } from './src/storage';
import { handleDataGet, handleDataSave, handleDataLoadAll } from './src/storage/dataApi';
import { verifySession, signSession, newSession, isValidPassphrase } from './src/storage/localAuth';
import { getOrCreateHouseholdId, getSessionSecret, isHouseholdConfigured, setHouseholdPassphrase, checkHouseholdPassphrase, changeHouseholdPassphrase } from './src/storage/boxConfig';
// Pure helpers extracted to src/server/ — imported for internal use, re-exported for test consumers.
import { checkRateWindow, pruneExpired } from './src/server/rateLimit';
import { parseGeminiJSON, repairTruncatedJson, isTextOnlyContents, contentsToText, isTransientError, isRecoverableError, orderFallbackModels, isLikelyTextModel, resolveFallbackChain, isLocalToken, buildAttemptChain } from './src/server/llmHelpers';
import { shiftIsoDate, filterUpcomingEvents, dedupeActions, ALLOWED_COPILOT_ACTIONS, sanitizeCopilotActions, sanitizeSuggestions, parseICS } from './src/server/copilotHelpers';
import type { GroundingFact } from './src/server/copilotHelpers';
import { hashStepUpPin, verifyStepUpPin, isValidPin, nextPinLockEntry } from './src/server/stepUpPin';
export { checkRateWindow, pruneExpired, resetPruneTimer } from './src/server/rateLimit';
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

const UPLOAD_ROUTES = new Set([
  '/api/parse-pdf', '/api/extract-pdf-text', '/api/extract-docx-text',
  '/api/extract-xlsx-text', '/api/vision-scan-pantry', '/api/photos/upload',
]);
const bigBody = express.json({ limit: '10mb' });
const smallBody = express.json({ limit: '256kb' });
app.use((req, res, next) => {
  (UPLOAD_ROUTES.has(req.path) ? bigBody : smallBody)(req, res, next);
});

// Auth middleware (requireAuth, aiRateLimit, preAuthThrottle) → src/server/middleware.ts
app.use(preAuthThrottle);

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
// COST DISCIPLINE: most PDFs carry an embedded text layer, so extract that LOCALLY first (pdfjs-dist — free,
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
      const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
      const pages: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        pages.push(content.items.map((it: any) => it.str).join(' '));
      }
      layerText = pages.join('\n').trim();
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

// Kroger cart integration → src/server/kroger.ts
app.use('/api/kroger', krogerRouter);

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


// Step-up PIN routes → src/server/stepUpRoutes.ts
app.use('/api/stepup', stepUpRouter);


// Email scan routes (bills, newsletters, packages, kids' activities) → src/server/emailScan.ts
app.use('/api', emailScanRouter);

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

// Agent proxy + async job routes → src/server/agentProxy.ts
app.use('/api/agent', agentProxyRouter);


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

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is booted successfully on http://0.0.0.0:${PORT}`);
  });

  startDigestScheduler();

  process.on('SIGTERM', () => {
    console.log('SIGTERM received — draining connections...');
    server.close(() => {
      console.log('All connections drained — exiting.');
      process.exit(0);
    });
  });
}

// Daily-digest scheduler + runner → src/server/digest.ts

if (!process.env.VITEST) {
  startServer();
}
