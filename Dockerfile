# Family-Hub concierge — DEMO BACKEND container (capstone).
# KAGGLE_EVAL: Deployability — ONE image runs the Python ADK agent service AND the Node MCP server it
# spawns as a stdio child, so the whole agent toolchain is a single Cloud Run deployable.
#
# Multi-stage: the MCP server is esbuild-BUNDLED to a single dist/mcp-server.cjs in a builder stage, so the
# runtime image runs it via `node` (NOT `npx tsx`) — dropping the dev toolchain (tsx/vite/esbuild) AND
# removing the ~5s tsx transpile-on-cold-spawn that caused the documented ADK MCP session timeout.

# ── 1. builder: bundle the MCP server (needs devDeps: esbuild) ────────────────────────────────────────
FROM node:24-bookworm-slim AS mcpbuild
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:mcp     # → dist/mcp-server.cjs (externals stay external; only @mcp/sdk + @supabase remain)

# ── 2. runtime: Python (ADK) + Node (the bundled MCP child), PRODUCTION deps only ─────────────────────
FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Production Node deps only — the MCP bundle's runtime requires (@modelcontextprotocol/sdk, @supabase/supabase-js)
# are dependencies, so `--omit=dev` is sufficient and drops tsx/vite/esbuild/vitest/etc.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Python deps (ADK) in a venv — Debian's system Python is externally-managed (PEP 668).
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
COPY agent/requirements.txt ./agent/requirements.txt
RUN pip install --no-cache-dir -r agent/requirements.txt

# The bundled MCP server + the ADK agent package. No src/ or tsconfig needed at runtime (bundled in).
COPY --from=mcpbuild /app/dist/mcp-server.cjs ./dist/mcp-server.cjs
COPY agent ./agent

# Tells agent/concierge/agent.py to spawn the MCP child as `node dist/mcp-server.cjs` instead of `npx tsx …`.
ENV MCP_SERVER_CJS=/app/dist/mcp-server.cjs

# Writable data dir for the LAN appliance's SQLite DB (STORAGE=sqlite), shared with the web container via a
# volume so the agent's MCP child + the Express server write the same file. Owned by `node` so the dropped-
# privilege process can create/lock it. (node:sqlite — the local backend — needs the Node 24 base above.)
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data

# Cloud Run injects $PORT (default 8080). agent/api.py (FastAPI) serves POST /chat with per-request
# visitor-JWT isolation; the concierge spawns the MCP server as a stdio child (node dist/mcp-server.cjs,
# cwd=/app). Persistence activates per request when the visitor's JWT arrives as a Bearer token; Gemini needs
# GOOGLE_API_KEY (+ GOOGLE_GENAI_USE_VERTEXAI=FALSE). See agent/README.md.
ENV PORT=8080
EXPOSE 8080
# Drop privileges — the base image ships a non-root `node` user.
USER node
# Serves agent.api:app from /app (WORKDIR), so `agent` resolves as a package on sys.path.
CMD ["sh", "-c", "uvicorn agent.api:app --host 0.0.0.0 --port ${PORT}"]
