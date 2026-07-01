# Install fam-hub on your own box (LAN appliance)

Run the whole thing — calendar, chores, shopping, and the AI concierge — on a machine on your home network.
**No accounts, no cloud bills**: your data lives in a local SQLite file on the box, and the AI runs on *your*
free Google AI Studio key (or a local model). One family per box.

## What you need
- **A box with Docker** that stays on: a mini-PC, NAS (Synology/Unraid/CasaOS), an old laptop, or a Raspberry
  Pi 4/5 (arm64). Install Docker: https://docs.docker.com/engine/install/ (or Docker Desktop on Windows/Mac).
- **A Google AI Studio key** (free): https://aistudio.google.com/apikey — powers the in-app copilot **and the
  multi-agent concierge**. *(Optional: skip the key and run a local Ollama for the in-app copilot — but the
  concierge needs a Gemini/Vertex key today; see "Local model" below.)*

## Option A — one command (recommended)
On the box:
```bash
curl -fsSL https://raw.githubusercontent.com/msampath/fam-hub/initial-push/scripts/install.sh | sh
```
It checks Docker, drops the config into `~/fam-hub`, asks for your key, pulls the prebuilt images, and starts.
When it finishes it prints the URL. Open **`http://<box-LAN-ip>:4894`** from any device on your network → set a
household passphrase → you're in. Re-run the same command anytime to **update**.

## Option B — manual (prebuilt images)
```bash
mkdir fam-hub && cd fam-hub
curl -fsSL https://raw.githubusercontent.com/msampath/fam-hub/initial-push/docker-compose.appliance.prebuilt.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/msampath/fam-hub/initial-push/.env.example -o .env
# edit .env → paste your key into GEMINI_API_KEY (one key powers both the copilot + the agent)
docker compose pull
docker compose up -d
```

## Option C — build from source
Clone the repo and build the images locally (slower; needs the source tree):
```bash
git clone https://github.com/msampath/fam-hub && cd fam-hub
cp .env.example .env     # add your key
docker compose -f docker-compose.appliance.yml up -d --build
```

## Local model for the in-app copilot (zero inference cost)
Leave the keys empty and run [Ollama](https://ollama.com) on the box (or another LAN host), then set the
`LOCAL_LLM_*` env in `.env` (the **in-app copilot** supports a keyless local-first chain). Maps/web/weather are
keyless by default (OpenStreetMap / DuckDuckGo / Open-Meteo), so the dashboard + copilot run at ~$0 marginal.

> **Caveat — the concierge still needs a key.** The multi-agent **concierge** (the ADK agent that researches +
> plans trips) has no local-model path yet, so on a keyless box it stays offline while everything else (calendar,
> chores, shopping, the in-app copilot) works. The box comes up either way — it no longer blocks on the concierge.

## Manage it
```bash
cd ~/fam-hub
docker compose logs -f          # watch logs
docker compose down             # stop (data is kept in the named volume)
docker compose up -d            # start again
```
- **Back up your data:** it lives in the Docker volume `famhub-data` (the SQLite DB + the household passphrase
  hash). **Stop the box first** so the WAL database is copied consistently — a live tar can capture a torn,
  half-written snapshot: `docker compose down && docker run --rm -v famhub-data:/d -v "$PWD":/b alpine tar czf /b/famhub-backup.tgz -C /d . && docker compose up -d`
- **Update:** re-run the installer (Option A), or `docker compose pull && docker compose up -d`.
- **Uninstall:** `docker compose down -v` (the `-v` also deletes the data volume — back up first).

## Security note
The box trusts your **LAN** — the passphrase gates the dashboard, but there's no per-user isolation (it's one
household). **Do not port-forward it to the public internet** or expose it beyond a network you trust. (The
multi-tenant hardening needed for a public deployment is documented but off by default — see
[`docs/lan-appliance.md`](./lan-appliance.md).)

## For maintainers: choosing the storage backend
The box picks SQLite vs Supabase from **environment variables at runtime** — there is no config file to edit,
and end users never choose (the appliance is SQLite-only by design). The lever is the `STORAGE` env var, read by
`storageMode()` ([`src/storage/index.ts`](../src/storage/index.ts)):

- `STORAGE=sqlite` → local appliance mode (household passphrase + the SQLite data API). **The appliance compose
  files pin this explicitly** — it's load-bearing, don't remove it.
- `STORAGE=supabase` → cloud mode (browser talks to Supabase directly; needs `VITE_SUPABASE_URL` +
  `VITE_SUPABASE_ANON_KEY`).
- **Unset** → auto-detect: Supabase **iff** `VITE_SUPABASE_URL` is present, else SQLite. The resolved mode is
  logged at boot (`[storage] mode=… (…)`) so a fallback is never silent — check that line if a box lands on the
  wrong backend.

To run this stack **Supabase-backed** instead, set `STORAGE=supabase` + the two `VITE_SUPABASE_*` vars (and don't
use the appliance compose files, which hardcode SQLite).

## For maintainers: publishing the images
The prebuilt images are built + pushed to GHCR by [`.github/workflows/appliance-images.yml`](../.github/workflows/appliance-images.yml)
on every push to the default branch. **After the first run, set both packages
(`fam-hub-web`, `fam-hub-agent`) to PUBLIC** in GitHub → your profile → Packages, so the install script can
pull them without auth. Tag a release (`vX.Y.Z`) to publish a pinned version; pin it on a box with
`IMAGE_TAG=vX.Y.Z` in `.env`.
