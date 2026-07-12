-- Family-Hub — post-capstone migration (Wave 7 additive + F-04/F-02/CAS hardening, §§5-7).
--
-- HOW TO APPLY: paste this WHOLE file into the Supabase SQL editor and run it once.
-- §§1-4 are STRICTLY ADDITIVE (CREATE TABLE/EXTENSION IF NOT EXISTS) — always safe, including re-runs.
-- §§5-7 (2026-07-11) are NOT purely additive: §5 drops+recreates the "join household" policy and
-- REDEFINES join_household_by_code (denies direct household_members inserts, adds expiry + attempt
-- throttle to the join RPC); §7 adds a BEFORE trigger on family_data. Both are idempotent (safe to
-- re-run) but DO change live behavior on whatever project they run against — apply them ONLY to a
-- fresh/isolated project with no live user traffic depending on the old behavior, never to a
-- judge-frozen or otherwise-live shared project. §6 remains additive-only (a new table, no feature
-- wiring yet).
--
-- ASSUMES schema.sql has already been applied (this file references households and the
-- get_user_household_id() helper it defines).
--
-- What it adds:
--   1. agent_jobs  — queued async agent turns (POST /api/agent/chat-async + GET /api/agent/job/:id).
--   2. web_cache   — 7-day household-scoped page cache for the concierge's fetch_page tool.
--   3. pgvector    — the extension only, prep for Docs-Library semantic retrieval.
--   4. (commented out) documents_embeddings — enable when the embeddings work actually lands.
--   5. F-04 invite-join hardening — deny-direct-insert + create_household() RPC, CSPRNG 16-hex codes,
--      7-day expiry + regenerate, join-attempt throttle (see the paired src/supabase.ts changes).
--   6. oauth_tokens table (F-02 prep only — schema, not the full refresh-token-binding feature).
--   7. Server-set family_data.updated_at trigger (hardens CAS against client clock skew).
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

-- ── 5. F-04 invite-join completion ───────────────────────────────────────────────────────────────────
-- APPLIED 2026-07-11 as the v2 baseline: this project is a fresh, isolated Supabase instance created
-- specifically so this hardening could ship WITHOUT the live-policy-change risk that kept it commented
-- on the original (judge-frozen) project. Zero existing rows here, so 5b's re-key UPDATE is a no-op —
-- there is no "in-flight live traffic" risk on this project. Paired client changes shipped in the same
-- commit: src/supabase.ts's createHousehold()/getOrCreateHousehold()/isValidInviteCode()/
-- regenerateInviteCode(), plus a "Regenerate" button in Manage.tsx.
--
-- 5a. Close the direct-INSERT bypass (the core F-04 finding): the household_members INSERT policy
--     used to check only user_id = auth.uid(), so an attacker who LEARNS a household_id could insert
--     their own membership row and skip the invite code entirely. Deny direct inserts; SECURITY
--     DEFINER RPCs (owned by postgres, bypass RLS) become the ONLY way to create OR join a membership.

drop policy if exists "join household" on household_members;
create policy "join household" on household_members for insert with check (false);

-- create_household(): replaces the client's old direct household+membership INSERT (schema.sql's
-- comment already anticipated this — "the join RPC delete-then-inserts to maintain [one household per
-- user]"). Creates the row + this user's own membership atomically; the household_members unique
-- constraint on user_id makes a concurrent double-call fail safely (23505) rather than fork state.

create or replace function create_household()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  hid uuid;
begin
  if auth.uid() is null then
    return null;
  end if;
  insert into households (owner_id) values (auth.uid()) returning id into hid;
  insert into household_members (user_id, household_id) values (auth.uid(), hid);
  return hid;
end;
$$;

revoke execute on function create_household() from anon;
grant  execute on function create_household() to authenticated;

-- 5b. Longer, CSPRNG invite codes (24-bit md5 substring → 64-bit): re-key existing households (no-op
--     here — zero rows) and change the default. pgcrypto's gen_random_bytes is CSPRNG; 8 bytes → 16 hex
--     chars. Paired: src/supabase.ts's isValidInviteCode now gates on /^[0-9a-f]{16}$/i.

alter table households
  alter column invite_code set default upper(encode(extensions.gen_random_bytes(8), 'hex'));
update households set invite_code = upper(encode(extensions.gen_random_bytes(8), 'hex'));

-- 5c. Code expiry + rotation: a code was a standing secret before this. Add an expiry the RPC enforces
--     and a member-callable regenerate. Paired: src/supabase.ts's regenerateInviteCode() + Manage.tsx's
--     "Regenerate" button.

alter table households add column if not exists invite_code_expires_at timestamptz;

create or replace function regenerate_invite_code()
returns text language plpgsql security definer set search_path = public as $$
declare new_code text;
begin
  if auth.uid() is null then return null; end if;
  new_code := upper(encode(extensions.gen_random_bytes(8), 'hex'));
  update households set invite_code = new_code, invite_code_expires_at = now() + interval '7 days'
    where id = get_user_household_id();
  return new_code;
end; $$;
revoke execute on function regenerate_invite_code() from anon;
grant  execute on function regenerate_invite_code() to authenticated;

-- 5d. Attempt throttle on the join RPC (enumeration brake): it was callable by any authenticated user
--     with no limit. Track attempts per user and refuse after 10/hour.

create table if not exists join_attempts (
  user_id uuid not null, attempted_at timestamptz default now() not null
);
alter table join_attempts enable row level security; -- no policies: only the definer fn below touches it

-- join_household_by_code, REDEFINED (schema.sql created the original; this replaces it with the same
-- signature) to add the 5c expiry check and the 5d attempt throttle. A NULL invite_code_expires_at
-- (a household created before this migration ran) never expires — only applies to fresh/regenerated codes.

create or replace function join_household_by_code(code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  hid uuid;
  expires_at timestamptz;
begin
  if auth.uid() is null then
    return null;
  end if;
  if (select count(*) from join_attempts where user_id = auth.uid()
      and attempted_at > now() - interval '1 hour') >= 10 then
    return null;
  end if;
  insert into join_attempts (user_id) values (auth.uid());

  select id, invite_code_expires_at into hid, expires_at from households where invite_code = upper(trim(code));
  if hid is null then
    return null;
  end if;
  if expires_at is not null and expires_at < now() then
    return null;
  end if;
  -- Leave any current household, then join the target (one membership at a time).
  delete from household_members where user_id = auth.uid();
  insert into household_members (user_id, household_id)
    values (auth.uid(), hid)
    on conflict (user_id, household_id) do nothing;
  return hid;
end;
$$;

revoke execute on function join_household_by_code(text) from anon;
grant  execute on function join_household_by_code(text) to authenticated;

-- ── 6. F-02 refresh-token binding — TABLE ONLY (schema prep, not the full feature) ─────────────────────
-- APPLIED 2026-07-11: creates the storage this feature needs. Does NOT yet change /api/google-refresh's
-- behavior (still accepts a token in the request body — see src/server code) — that's a separate,
-- larger change (move the refresh token server-side at OAuth-connect time, encrypt at rest, stop
-- accepting body tokens) intentionally left as a TODO, matching this section's original scope.
-- ASSESSED 2026-07-06: /api/google-refresh authenticates the CALLER but accepts ANY refresh token in
-- the body (the token lives per-device in client localStorage by design — same pattern as Kroger; the
-- server stores no copy today, so there is nothing to "bind to" without new storage). Already in code:
-- the caller must hold a valid session (requireAuth) and Google's error bodies are NOT echoed (a prober
-- can't use us to confirm token validity — the F-02 "at minimum" + F-06).
-- F-03 (DNS-rebinding), assessed the same pass, needs NO schema work: src/utils/ssrfGuard.ts already
-- pins every safeFetch hop to its validated IP, and all other outbound calls are fixed-host.

create table if not exists oauth_tokens (
  user_id      uuid        primary key references auth.users(id) on delete cascade,
  provider     text        not null default 'google' check (provider in ('google', 'kroger')),
  token_cipher text        not null,  -- AES-GCM ciphertext, key from server env (never plaintext)
  created_at   timestamptz default now() not null,
  updated_at   timestamptz default now() not null
);
alter table oauth_tokens enable row level security; -- no policies yet: server-only via service key,
  -- until the feature above actually lands and defines how the JWT-scoped client should touch this.

-- ── 7. Server-set updated_at trigger (hardens the CAS token against client clock skew) ─────────────────
-- APPLIED 2026-07-11: the optimistic-concurrency token on family_data.updated_at was CLIENT-set before
-- this (browser saveHouseholdData, MCP SupabasePersistence.casWrite — both already correctly read back
-- the SERVER's returned updated_at via .select('updated_at') rather than assuming their own submitted
-- timestamp survived, so this trigger is a drop-in — verified 2026-07-11, no client code changes needed).
-- This trigger makes Postgres stamp it instead, removing the theoretical equal-timestamp collision
-- between two skewed clients.

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists family_data_set_updated_at on family_data;
create trigger family_data_set_updated_at
  before insert or update on family_data
  for each row execute function set_updated_at();
