import { Router } from 'express';
import { randomBytes } from 'crypto';
import {
  buildKrogerAuthUrl, authCodeTokenBody, refreshTokenBody, clientCredentialsBody,
  shapeLocations, shapeProductCandidates, buildMatchPrompt, validateMatchSelections, mergeMatchRetry,
  buildCartAddBody, KROGER_MATCH_SCHEMA, krogerSearchTerm, krogerFallbackTerm, type ProductCandidate,
} from '../utils/krogerApi';
import { callGeminiJSON } from './gemini';
import { fetchWithTimeout, mapWithConcurrency } from './fetchUtils';
import { requireAuth, aiRateLimit } from './middleware';

const KROGER_CLIENT_ID = process.env.KROGER_CLIENT_ID || '';
const KROGER_CLIENT_SECRET = process.env.KROGER_CLIENT_SECRET || '';
const krogerConfigured = () => !!(KROGER_CLIENT_ID && KROGER_CLIENT_SECRET);
const krogerBasic = () => 'Basic ' + Buffer.from(`${KROGER_CLIENT_ID}:${KROGER_CLIENT_SECRET}`).toString('base64');
const krogerRedirectUri = (req: any) => {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}/api/kroger/callback`;
};

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

let krogerAppToken: { token: string; exp: number } | null = null;
async function getKrogerAppToken(): Promise<string | null> {
  if (krogerAppToken && Date.now() < krogerAppToken.exp - 60000) return krogerAppToken.token;
  const { ok, data } = await krogerToken(clientCredentialsBody('product.compact'));
  if (!ok || !data.access_token) return null;
  krogerAppToken = { token: data.access_token, exp: Date.now() + Number(data.expires_in || 1800) * 1000 };
  return krogerAppToken.token;
}

export const krogerRouter = Router();

krogerRouter.get('/auth-url', requireAuth, (req, res) => {
  if (!krogerConfigured()) return res.status(503).json({ error: 'Kroger integration is not configured on the server (KROGER_CLIENT_ID / KROGER_CLIENT_SECRET).' });
  const state = randomBytes(16).toString('hex');
  return res.json({ url: buildKrogerAuthUrl(KROGER_CLIENT_ID, krogerRedirectUri(req), state), state });
});

krogerRouter.get('/callback', async (req, res) => {
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
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const appOrigin = `${proto}://${req.get('host')}`;
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

krogerRouter.get('/poll', requireAuth, (req, res) => {
  const state = String(req.query.state || '');
  krogerPendingSweep();
  const entry = state ? krogerPending.get(state) : undefined;
  if (!entry) return res.json({ pending: true });
  krogerPending.delete(state);
  return res.json({ refreshToken: entry.token });
});

krogerRouter.get('/locations', requireAuth, async (req, res) => {
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

krogerRouter.post('/match', requireAuth, aiRateLimit, async (req, res) => {
  if (!krogerConfigured()) return res.status(503).json({ error: 'Kroger integration is not configured.' });
  const locationId = String(req.body?.locationId || '');
  const items = (Array.isArray(req.body?.items) ? req.body.items : []).map((s: any) => String(s || '').trim()).filter(Boolean).slice(0, 25);
  if (!locationId || !items.length) return res.status(400).json({ error: 'locationId and items are required.' });
  try {
    const tok = await getKrogerAppToken();
    if (!tok) return res.status(502).json({ error: 'Kroger is unavailable right now.' });
    const candidates: Record<string, ProductCandidate[]> = {};
    const searchFailed = new Set<string>();
    const searchProducts = async (term: string): Promise<ProductCandidate[] | null> => {
      const q = new URLSearchParams({ 'filter.term': term, 'filter.locationId': locationId, 'filter.limit': '5' });
      const r = await fetchWithTimeout(`https://api.kroger.com/v1/products?${q}`, 10000, { headers: { Authorization: `Bearer ${tok}` } });
      if (!r.ok) { console.warn(`[kroger] product search HTTP ${r.status} for term "${term}"`); return null; }
      return shapeProductCandidates(await r.json().catch(() => ({})));
    };
    // Up to 5 items searched concurrently (was strictly serial — up to ~50 sequential product-search
    // round-trips per list, 7-15s of latency before the AI match even starts). Each item's own
    // primary-term + optional-fallback-retry sequence is unchanged; different items write to distinct
    // keys of `candidates`/`searchFailed`, so concurrent writes here are safe (no shared key contention).
    await mapWithConcurrency(items, 5, async (item: string) => {
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
    });
    const matchSystem = 'You match grocery-list items to store products. Choose ONLY from the listed candidates; -1 when none truly is the item.';
    const judge = (subset: string[]) => callGeminiJSON(
      buildMatchPrompt(subset, candidates), matchSystem, KROGER_MATCH_SCHEMA, '{}', undefined, { temperature: 0.2 },
    ).catch(() => null);
    let result = validateMatchSelections(await judge(items), items, candidates, searchFailed);
    const rejected = result.unmatched.filter(i => result.reasons?.[i] === 'rejected');
    if (rejected.length) result = mergeMatchRetry(result, validateMatchSelections(await judge(rejected), rejected, candidates));
    return res.json(result);
  } catch (err) {
    console.error('[kroger] match error:', err);
    return res.status(500).json({ error: 'Product matching failed.' });
  }
});

krogerRouter.post('/cart-add', requireAuth, async (req, res) => {
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
    return res.json({ added: body.items.length, ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}) });
  } catch (err) {
    console.error('[kroger] cart add error:', err);
    return res.status(500).json({ error: 'Cart update failed.' });
  }
});
