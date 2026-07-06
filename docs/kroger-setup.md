# Kroger send-to-cart — setup & how it works

Family-Hub can turn a shopping list into items **in your real Kroger-family cart** (Kroger, Fred Meyer,
QFC, Ralphs, King Soopers, …) — matched to real products at *your* store, staged as one Approval, and
written to the cart only after a parent approves. Payment is structurally impossible: the public Kroger
API has **no checkout or payment endpoint**, so you always review and pay in Kroger's own app.

This is the project's first fully closed agentic loop — *"I want paneer butter masala tomorrow"* →
family-scaled ingredients in buy units → routed store lists → per-list send → LLM-validated product
matching → one human approval → a real cart at a real store.

## 1. Create your (free) Kroger developer app

1. Sign up at [developer.kroger.com](https://developer.kroger.com) and create an app
   (My Apps → *Create App*).
2. Environment: **Production** (the demo data in Certification is not your real store). Requesting the
   `cart.basic:write` scope for a personal app was approved same-day in our experience.
3. Scopes the app uses:
   - `product.compact` — product search (server-to-server, client credentials)
   - `cart.basic:write` + `profile.compact` — the customer OAuth connect + cart writes
4. **Redirect URIs — read this twice.** The server derives the OAuth callback from the origin the
   browser is actually using, so the portal must list an EXACT entry for **every origin you browse the
   app from**:
   - `http://localhost:4894/api/kroger/callback`
   - `http://<your-LAN-IP>:4894/api/kroger/callback` (e.g. the wall tablet's address)
   - your public URL + `/api/kroger/callback`, if you host it
   A mismatch fails with Kroger's `redirect_uri did not match` — add the missing origin, no code change
   needed.

## 2. Configure Family-Hub

In your git-ignored `.env` (see `.env.example`):

```
KROGER_CLIENT_ID="your-client-id"
KROGER_CLIENT_SECRET="your-client-secret"
```

Restart the server. Without these, every Kroger surface degrades to an honest 503 and the UI simply
doesn't offer the feature.

> Hygiene: the secret lives only in `.env` (never committed). If it ever leaks, rotate it in the
> portal, update `.env`, restart — connected devices keep working (their tokens are their own).

## 3. Connect — the two-level model

In **Manage → Groceries**:

1. **Connect Kroger account** — sign in on Kroger's page. The app picks the sign-in up automatically
   (a server-side, single-use handoff keyed by a nonce with a 5-minute TTL — deliberately not
   `postMessage`/popup plumbing, which ad-blockers and COOP break). The refresh token is stored **on
   that device only** (browser localStorage) — never in the shared household database.
2. Pick the connection's store: **"Shop at → Fred Meyer - Issaquah"** (nearby locations are looked up
   from your home location).
3. **Link lists to the connection** — e.g. *Grocery Store → Kroger*, while *Costco* stays *Not linked*.

The store location is a property of the **connection**, not of any list — that's how people actually
shop (one Kroger store serves the household; several lists may point at it). Changing the connection's
store re-points every linked list at once. A future retailer (e.g. an Instacart adapter) appears as a
second connection card, linkable to its own lists.

## 4. Send → match → approve → cart

1. Every **linked** list gets its own **Send to <store>** button on the Shopping page (plus a one-tap
   offer right after a recipe/dish ask adds items).
2. Per item, the server searches the store's real catalog (search terms are cleaned of buy-unit
   parentheticals — Kroger's fuzzy search returns *frying pans* for "paneer" and green-onion bulbs for
   "Garlic (1 bulb)"; a zero-hit multi-word term gets one simpler retry).
3. **A schema-enforced model call must pick from the listed candidates or decline** (`-1 beats a wrong
   add`). Validation is deterministic: out-of-range indexes and out-of-stock picks are dropped,
   hallucinated items ignored. Items the model declines get **one focused second-pass re-judge**
   (borderline calls flip; real mismatches stay declined).
4. One **confirm-tier Approval** shows exactly what will happen, one line per item —
   `• Ginger (1 piece) → Organic Ginger Root (1 lb, $3.99)` — plus a per-item honest reason for
   anything that didn't make it: *No match at this store* / *Couldn't confidently match — try Send
   again* / *Search failed*. Quantities default to 1 (the list carries buy units, not counts — bump
   quantities in the Kroger cart).
5. **Approve** → the server writes the cart (UPCs validated, quantities clamped 1–10). Matched items
   are checked off your list; unmatched ones stay. Checkout happens in Kroger's own app, or not at all.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `redirect_uri did not match` on connect | The origin you're browsing from isn't registered — add its exact `/api/kroger/callback` URI in the portal (§1.4). |
| Every Kroger button 503s | `KROGER_CLIENT_ID`/`KROGER_CLIENT_SECRET` not set on the server (§2). |
| "Search failed for: …" on the Approval | Transient Kroger API error — Send again in a bit. |
| "Couldn't confidently match: …" | Real candidates existed but none cleared the bar (after the automatic second pass) — Send again for a fresh judgment, or rename the item closer to what the store calls it. |
| "No match at this store: …" | The store's catalog genuinely returned nothing — that's why multi-store lists exist (kasuri methi lives at the Indian store, not Fred Meyer). |
| Disconnect | Manage → Groceries → Disconnect: drops this device's token and clears the connection + list links. |

## Where the code lives

Pure logic in [`src/utils/krogerApi.ts`](../src/utils/krogerApi.ts) (auth URL/token bodies, candidate
shaping, match prompt + deterministic validation, retry merge, draft summary, two-level bindings) with
tests in `src/__tests__/krogerApi.test.ts`; server routes in [`server.ts`](../server.ts) (`/api/kroger/*`);
per-device token + connect flow in [`src/utils/krogerClient.ts`](../src/utils/krogerClient.ts); panel UI in
[`src/components/shell/KrogerPanel.tsx`](../src/components/shell/KrogerPanel.tsx). The cart write applies
through the same Approvals ledger as every other confirm-tier action.
