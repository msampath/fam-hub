# Maps + Events grounding — API key setup

The copilot grounds its activity suggestions in **real, server-fetched data** (Pattern 1 — the server fetches and injects facts; the model never web-searches, which proved unreliable on local models). Three new optional data sources feed the harness:

| Block | Source (primary) | Free fallback | Key needed |
| --- | --- | --- | --- |
| `PLACES FACTS` (venues) | Google Places API (New) | OpenStreetMap Overpass | `GOOGLE_MAPS_API_KEY` (optional) |
| Drive times (on each place) | Google Distance Matrix | OSRM demo server | `GOOGLE_MAPS_API_KEY` (optional) |
| Air quality (AQI in WEATHER FACTS) | **Open-Meteo (free, keyless)** | — | none |
| Pollen (allergy tips in WEATHER FACTS) | Google Pollen API | — (Open-Meteo pollen is Europe-only) | `GOOGLE_MAPS_API_KEY` (optional) |
| `EVENTS FACTS` (dated events) | Ticketmaster Discovery | — (none) | `TICKETMASTER_API_KEY` (required for events) |

> **Air quality** is fetched **free from Open-Meteo** (US AQI per day → wildfire-smoke / outdoor-safety guidance) — you do **not** need Google's Air Quality API. **Solar API** is rooftop solar-panel potential (energy ROI), **not** sunshine for outings — irrelevant here, don't add it.

**It already works with zero keys** — places + drive times fall back to the free OpenStreetMap/OSRM endpoints. Add the keys below to upgrade quality (Google: prominence-ranked, well-known venues + accurate drive times) and to turn on events (Ticketmaster).

After setting any key in `.env`, **rebuild + restart the server** (`npm run build && npm run start`) — these run server-side.

---

## 1. Google Maps Platform key (Places + Distance Matrix)

Powers higher-quality venues (ranked by prominence, with ratings) and accurate drive times. Requires a billing account with a card, but a personal household stays well within the monthly free allowance (this app makes a few cached calls per planning query).

1. **Create / pick a project** — <https://console.cloud.google.com/projectcreate> (you can reuse the project you already use for the Google Calendar OAuth).
2. **Enable billing** — Console → **Billing** → link a billing account (card required even for free-tier usage). Maps Platform won't return results without it.
3. **Enable the APIs** — Console → **APIs & Services → Library**, search for and **Enable** each:
   - **Places API (New)**  ← family venues (`places:searchNearby`) **and** food/cafe/cuisine queries (`places:searchText`, used when you ask for "a coffee shop", "vegan restaurant", etc.)
   - **Distance Matrix API**  ← drive times
   - **Pollen API**  ← per-day pollen for allergy tips (optional; skip if you don't want pollen)
   - *(Do **not** bother with Air Quality API — it's free via Open-Meteo — or Solar API — irrelevant.)*

   > **Free-tier note (2025 pricing):** each Places SKU gets **1,000 free Enterprise-tier calls/month**. The app requests `rating` + `userRatingCount` (Enterprise tier) and uses two SKUs — **Nearby Search** and **Text Search** — plus **Distance Matrix**, each with its own monthly free allotment. With the 24-hour places cache, the planning-query gate, and one household, real usage is in the tens of calls/month — comfortably free. Watch Text Search only if you ever open this to many households or drop the cache.
4. **Create the key** — **APIs & Services → Credentials → + Create credentials → API key**. Copy it.
5. **Restrict the key** (recommended) — click the key → **Edit**:
   - **Application restrictions:** *None* (the key is used **server-side**, so an HTTP-referrer/IP restriction isn't required; if you want one, restrict by your server's public IP — not a referrer, since calls don't come from a browser).
   - **API restrictions → Restrict key →** select **Places API (New)**, **Distance Matrix API**, and **Pollen API** only.
6. **(Optional) cap spend** — Billing → **Budgets & alerts** → set a low budget alert (e.g. $5) for peace of mind. You can also set per-API quotas under each API's **Quotas** page.
7. **Add to `.env`:**
   ```env
   GOOGLE_MAPS_API_KEY="AIza...your-key"
   # PLACES_RADIUS_M="40000"   # optional: venue search radius in meters (default ≈ 25 mi)
   ```

> Without this key the app uses **OpenStreetMap Overpass** (venues) + **OSRM** (drive times) — free, no billing, but lower quality and no popularity ranking (the app compensates by preferring wikidata-tagged "notable" venues).

> **Note on the legacy Distance Matrix API:** Google is steering new projects toward the **Routes API** (`computeRouteMatrix`). The classic Distance Matrix API still works and is simplest to enable; if Google ever disables it on your project, switch the server's travel-time call to Routes API (`server.ts → attachTravelTimes`).

---

## 2. Ticketmaster Discovery key (nearby events)

Free, instant, no billing — powers the `EVENTS FACTS` block (concerts, fairs, family shows, sports near home in the planning window).

1. Go to <https://developer.ticketmaster.com/> → **Sign up** (or sign in).
2. Open **My Apps** → your default app is created automatically (or **Add a new app**).
3. Copy the **Consumer Key** (this is the `apikey`).
4. **Add to `.env`:**
   ```env
   TICKETMASTER_API_KEY="your-consumer-key"
   ```

> The default Ticketmaster tier allows ~5,000 calls/day — far beyond a single household's cached usage. Without this key, no events block is injected (everything else still works).

---

## Verify it's working

1. `npm run build && npm run start` (must log `Running in PRODUCTION mode`).
2. In the app, make sure a **Home ZIP code** is set (account menu) — the fetches are keyed off the home location and only run on **planning** queries.
3. Ask the copilot something like *"activities for the long weekend"* and watch the **server console**:
   - `Google Places non-200 (falling back to OSM)` or `Distance Matrix non-200 (falling back to OSRM)` → the key isn't enabled/authorized for that API (re-check steps 3–5).
   - No warning + specific named venues with `~N min drive` in the answer → Google path is live.
4. All fetches are **best-effort**: any failure just omits that block and the copilot answers with whatever else it has — it never errors out.
