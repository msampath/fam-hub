-- Family-Hub — post-capstone additive migration (Wave 7: async agent jobs + web cache, pgvector prep).
--
-- HOW TO APPLY: paste this WHOLE file into the Supabase SQL editor and run it once.
-- STRICTLY ADDITIVE: only CREATE TABLE IF NOT EXISTS / CREATE EXTENSION IF NOT EXISTS + their RLS
-- policies — it does not alter, drop, or rewrite anything the judge-frozen live demo already uses,
-- so it is safe to run against the shared project. Re-running it is also safe (IF NOT EXISTS +
-- drop-policy-then-create, the same idempotent pattern schema.sql uses).
--
-- ASSUMES schema.sql has already been applied (this file references households and the
-- get_user_household_id() helper it defines) — true on the live project.
--
-- What it adds:
--   1. agent_jobs  — queued async agent turns (POST /api/agent/chat-async + GET /api/agent/job/:id).
--   2. web_cache   — 7-day household-scoped page cache for the concierge's fetch_page tool.
--   3. pgvector    — the extension only, prep for Docs-Library semantic retrieval.
--   4. (commented out) documents_embeddings — enable when the embeddings work actually lands.
--
-- The SQLite appliance got the mirror tables in code (src/storage/sqlite.ts bootstrap) — nothing to
-- run there.

-- ── 1. Async agent jobs ──────────────────────────────────────────────────────
-- One row per queued agent turn: queued → running → done|error. The Express server inserts/updates
-- these under the CALLER's JWT, so RLS (below) scopes every row to their household. `session_id` is
-- round-tripped so a follow-up turn can continue the same agent session.

create table if not exists agent_jobs (
  id           uuid        default gen_random_uuid() primary key,
  household_id uuid        references households(id) on delete cascade not null,
  status       text        not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
  message      text        not null,
  reply        text,                 -- the agent's answer — or the honest failure text when status='error'
  actions      jsonb,                -- the agent's actions array (staged confirmations etc.)
  model        text,                 -- which model actually answered (primary or the fallback it walked to)
  session_id   text,
  created_at   timestamptz default now() not null,
  updated_at   timestamptz default now() not null
);

alter table agent_jobs enable row level security;

-- Same policy shape as family_data ("household data access" in schema.sql): full CRUD for household
-- members only.
drop policy if exists "household job access" on agent_jobs;
create policy "household job access" on agent_jobs
  for all
  using      (household_id = get_user_household_id())
  with check (household_id = get_user_household_id());

-- ── 2. Web cache ─────────────────────────────────────────────────────────────
-- Household-scoped page cache for the concierge's fetch_page tool. url_hash = sha256 of the NORMALIZED
-- url (src/utils/webCache.ts); `content` is the packed { text, links } page. The 7-day TTL is enforced
-- on READ by the app (stale rows are ignored) and stale rows are pruned best-effort on write — no cron.

create table if not exists web_cache (
  household_id uuid        references households(id) on delete cascade not null,
  url_hash     text        not null,
  url          text        not null,
  content      text        not null,
  fetched_at   timestamptz default now() not null,
  primary key (household_id, url_hash)
);

alter table web_cache enable row level security;

drop policy if exists "household web cache access" on web_cache;
create policy "household web cache access" on web_cache
  for all
  using      (household_id = get_user_household_id())
  with check (household_id = get_user_household_id());

-- ── 3. pgvector (prep only) ──────────────────────────────────────────────────
-- Installs the extension so the embeddings table below can be enabled later without another visit.
-- Supabase convention: extensions live in the `extensions` schema (it's on the default search_path).

create extension if not exists vector with schema extensions;

-- ── 4. OPTIONAL: Docs-Library semantic retrieval (leave commented until that work lands) ─────────────
-- Roadmap "Docs Library completion": pgvector + nomic-embed-text (768-dim) chunk embeddings. Uncomment
-- when the embedding writer ships — creating it early would just be an empty table to keep in sync.
--
-- NOTE: the companion piece — a Storage BUCKET for the binary originals (today only extracted text is
-- kept) — is created in the Supabase dashboard UI (Storage → New bucket, private), not in SQL.
--
-- create table if not exists documents_embeddings (
--   household_id uuid        references households(id) on delete cascade not null,
--   doc_id       text        not null,   -- the Library document's id in the `documents` collection
--   chunk_index  int         not null default 0,
--   content      text        not null,   -- the chunk's text (what the match returns)
--   embedding    extensions.vector(768), -- nomic-embed-text dimension
--   created_at   timestamptz default now() not null,
--   primary key (household_id, doc_id, chunk_index)
-- );
--
-- alter table documents_embeddings enable row level security;
--
-- drop policy if exists "household embeddings access" on documents_embeddings;
-- create policy "household embeddings access" on documents_embeddings
--   for all
--   using      (household_id = get_user_household_id())
--   with check (household_id = get_user_household_id());

-- ── 5. OPTIONAL: F-04 invite-join completion (post-judging — do NOT run while the demo is frozen) ────
-- STATUS (honest split, 2026-07-06):
--   In CODE already:  the client join path goes through the SECURITY DEFINER RPC
--                     join_household_by_code (schema.sql) — code validity IS checked server-side on
--                     the legitimate path — and src/supabase.ts now rejects malformed codes before
--                     the RPC (6-hex format gate, isValidInviteCode).
--   PENDING (this SQL): everything below. It changes a LIVE policy ("join household") plus the codes
--                     themselves, so it stays commented until after judging. The Express server does
--                     not participate in the join flow at all (client → Supabase RPC direct), so
--                     these controls can only live here, in the database.
--
-- 5a. Close the direct-INSERT bypass (the core F-04 finding): today the household_members INSERT
--     policy checks only user_id = auth.uid(), so an attacker who LEARNS a household_id can insert
--     their own membership row and skip the invite code entirely. Deny direct inserts; the
--     SECURITY DEFINER RPC (owned by postgres, bypasses RLS) becomes the ONLY join path.
--     NB: schema.sql's createHousehold client code also does a direct membership insert on FIRST
--     sign-in — move that insert into a small SECURITY DEFINER create_household() RPC in the same
--     change, or the first-run flow breaks. That's why this must land as one reviewed unit.
--
-- drop policy if exists "join household" on household_members;
-- create policy "join household" on household_members for insert with check (false);
--
-- 5b. Longer, CSPRNG invite codes (24-bit md5 substring → 64-bit): re-key existing households and
--     change the default. pgcrypto's gen_random_bytes is CSPRNG; 8 bytes → 16 hex chars.
--
-- alter table households
--   alter column invite_code set default upper(encode(extensions.gen_random_bytes(8), 'hex'));
-- update households set invite_code = upper(encode(extensions.gen_random_bytes(8), 'hex'));
--   -- (then relax isValidInviteCode in src/supabase.ts to /^[0-9a-f]{16}$/i in the same deploy)
--
-- 5c. Code expiry + rotation: a code is a standing secret today. Add an expiry the RPC enforces and
--     a member-callable regenerate.
--
-- alter table households add column if not exists invite_code_expires_at timestamptz;
-- create or replace function regenerate_invite_code()
-- returns text language plpgsql security definer set search_path = public as $$
-- declare new_code text;
-- begin
--   if auth.uid() is null then return null; end if;
--   new_code := upper(encode(extensions.gen_random_bytes(8), 'hex'));
--   update households set invite_code = new_code, invite_code_expires_at = now() + interval '7 days'
--     where id = get_user_household_id();
--   return new_code;
-- end; $$;
-- revoke execute on function regenerate_invite_code() from anon;
-- grant  execute on function regenerate_invite_code() to authenticated;
--   -- and inside join_household_by_code, after the code lookup:
--   --   if (select invite_code_expires_at from households where id = hid) < now() then return null; end if;
--
-- 5d. Attempt throttle on the RPC (enumeration brake): the RPC is callable by any authenticated user
--     with no limit. Track attempts per user and refuse after 10/hour.
--
-- create table if not exists join_attempts (
--   user_id uuid not null, attempted_at timestamptz default now() not null
-- );
-- alter table join_attempts enable row level security; -- no policies: only the definer fn touches it
--   -- and at the TOP of join_household_by_code:
--   --   if (select count(*) from join_attempts where user_id = auth.uid()
--   --       and attempted_at > now() - interval '1 hour') >= 10 then return null; end if;
--   --   insert into join_attempts (user_id) values (auth.uid());
