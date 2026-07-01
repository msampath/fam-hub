#!/bin/sh
# fam-hub LAN appliance — one-command installer. On a box with Docker:
#
#   curl -fsSL https://raw.githubusercontent.com/msampath/fam-hub/initial-push/scripts/install.sh | sh
#
# Sets up ~/fam-hub with the prebuilt compose + your config, pulls the published images, and starts. Re-run
# anytime to update. Override: IMAGE_OWNER (fork), FAMHUB_DIR (install path), FAMHUB_BRANCH, GEMINI_API_KEY.
set -eu

OWNER="${IMAGE_OWNER:-msampath}"
BRANCH="${FAMHUB_BRANCH:-initial-push}"
DIR="${FAMHUB_DIR:-$HOME/fam-hub}"
RAW="https://raw.githubusercontent.com/$OWNER/fam-hub/$BRANCH"

echo "fam-hub appliance installer"

# 1) Prereqs.
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is not installed — install it first: https://docs.docker.com/engine/install/" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 'docker compose' (v2) is unavailable — update Docker, then re-run." >&2
  exit 1
fi

# 2) Fetch the prebuilt compose + the env template (saved as the compose default names so plain
#    'docker compose' commands work from $DIR).
mkdir -p "$DIR"
echo "-> Installing into $DIR"
curl -fsSL "$RAW/docker-compose.appliance.prebuilt.yml" -o "$DIR/docker-compose.yml"
[ -f "$DIR/.env" ] || curl -fsSL "$RAW/.env.example" -o "$DIR/.env"

# 3) Inference key — from env or a one-time prompt (works under `curl | sh` via /dev/tty).
KEY="${GEMINI_API_KEY:-}"
if [ -z "$KEY" ] && [ -r /dev/tty ]; then
  printf "Paste your Google AI Studio key (https://aistudio.google.com/apikey) [Enter to skip]: "
  read KEY < /dev/tty || true
fi
if [ -n "$KEY" ]; then
  sed -i.bak "s|^GEMINI_API_KEY=.*|GEMINI_API_KEY=$KEY|" "$DIR/.env"   # ONE key; the agent aliases it internally
  rm -f "$DIR/.env.bak"
fi

# 3b) Storage backend. Default = local SQLite (the appliance: zero accounts, data stays on this box). Optional
#     cloud mode syncs through your own Supabase project across devices/locations. STORAGE is honored by the
#     compose default (${STORAGE:-sqlite}); we only write it when the user opts into cloud. EXPERIMENTAL — the
#     cloud path isn't yet end-to-end validated against the prebuilt images; SQLite is the supported default.
MODE="${STORAGE:-}"
if [ -z "$MODE" ] && [ -r /dev/tty ]; then
  printf "Storage: [1] local SQLite (recommended, default)  [2] cloud Supabase (your own project): "
  read _M < /dev/tty || true
  [ "$_M" = "2" ] && MODE="supabase" || MODE="sqlite"
fi
if [ "$MODE" = "supabase" ]; then
  SB_URL="${VITE_SUPABASE_URL:-}"; SB_KEY="${VITE_SUPABASE_ANON_KEY:-}"
  if [ -z "$SB_URL" ] && [ -r /dev/tty ]; then
    printf "  Supabase project URL (https://xxxx.supabase.co): "; read SB_URL < /dev/tty || true
  fi
  if [ -z "$SB_KEY" ] && [ -r /dev/tty ]; then
    printf "  Supabase anon key: "; read SB_KEY < /dev/tty || true
  fi
  if [ -n "$SB_URL" ] && [ -n "$SB_KEY" ]; then
    # Upsert: strip any prior cloud lines first so re-running to update doesn't accumulate duplicate keys.
    sed -i.bak '/^STORAGE=/d; /^VITE_SUPABASE_URL=/d; /^VITE_SUPABASE_ANON_KEY=/d' "$DIR/.env" && rm -f "$DIR/.env.bak"
    { echo "STORAGE=supabase"; echo "VITE_SUPABASE_URL=$SB_URL"; echo "VITE_SUPABASE_ANON_KEY=$SB_KEY"; } >> "$DIR/.env"
    echo "-> Cloud (Supabase) mode configured. NOTE: this path is experimental — verify your data syncs."
  else
    echo "WARNING: cloud mode needs both the Supabase URL and anon key — staying on local SQLite." >&2
  fi
fi

# 4) Pull + start.
cd "$DIR"
echo "-> Pulling images..."
docker compose pull
echo "-> Starting..."
docker compose up -d

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"                                                # Linux
[ -n "$IP" ] || IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)"  # macOS
[ -n "$IP" ] || IP="<this-box-ip>"
echo ""
echo "fam-hub is running:  http://$IP:4894   (set a household passphrase to begin)"
echo "Config + data live in $DIR. Update later by re-running this installer."
[ -z "$KEY" ] && echo "NOTE: no AI key set — the box runs (calendar/chores/shopping), but the AI copilot stays offline until you add GEMINI_API_KEY to $DIR/.env, then: (cd $DIR && docker compose up -d)"
exit 0
