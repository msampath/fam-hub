-- Family-Hub — Supabase schema
-- Run this entire file in the Supabase SQL Editor on a fresh project, THEN run
-- supabase/migrations/2026-07-06-post-capstone.sql (it adds agent_jobs, web_cache, pgvector and
-- oauth_tokens — the app's async agent chat + page cache need those tables).
--
-- This file IS the hardened baseline: the F-04 §5 invite-join hardening (deny direct membership
-- inserts, create_household()/join RPCs, CSPRNG 16-hex codes with expiry + attempt throttle) and the
-- §7 server-set updated_at trigger are folded in, so the client's required RPCs exist from first
-- sign-in and RE-RUNNING this file can never revert the migration's hardening (it used to: the old
-- permissive join policy + 6-hex md5 default silently came back on a re-run).

-- pgcrypto provides gen_random_bytes (CSPRNG invite codes). Supabase convention: extensions schema.
create extension if not exists pgcrypto with schema extensions;

-- ── Households ───────────────────────────────────────────────────────────────

create table if not exists households (
  id          uuid        default gen_random_uuid() primary key,
  owner_id    uuid        references auth.users(id) on delete cascade not null,
  -- §5b: 16-hex CSPRNG code (64 bits — was a guessable 6-hex md5 substring). §5c: codes expire 7 days
  -- after mint (Manage → Regenerate rotates them); the join RPC below enforces the expiry.
  invite_code text        unique default upper(encode(extensions.gen_random_bytes(8), 'hex')) not null,
  invite_code_expires_at timestamptz default (now() + interval '7 days'),
  created_at  timestamptz default now() not null
);

-- Idempotent convergence for a pre-hardening project re-running this file (create table if not exists
-- is a no-op there, so the hardened default + expiry column must land explicitly too).
alter table households alter column invite_code set default upper(encode(extensions.gen_random_bytes(8), 'hex'));
alter table households add column if not exists invite_code_expires_at timestamptz default (now() + interval '7 days');

-- ── Household members ────────────────────────────────────────────────────────

create table if not exists household_members (
  user_id      uuid        references auth.users(id)    on delete cascade not null,
  household_id uuid        references households(id)    on delete cascade not null,
  joined_at    timestamptz default now() not null,
  primary key (user_id, household_id)
);

-- ONE household per user — the app's actual model (the join RPC delete-then-inserts to maintain it).
-- This is the durable fix for the household-spawning/fragmentation class: with it, getOrCreateHousehold
-- can never accumulate multiple memberships. Idempotent (drop-then-add); errors if pre-existing
-- duplicate user_id rows exist, which is the desired signal to reconcile them first.
alter table household_members drop constraint if exists household_members_user_unique;
alter table household_members add  constraint household_members_user_unique unique (user_id);

-- ── Key-value blob store for all family app data ─────────────────────────────
-- One row per (household_id, data_key); each row's `data` is the whole collection as a JSONB array.
-- The authoritative key list lives in the COLLECTIONS registry in src/App.tsx — keep that as the
-- source of truth. Current keys: 'events' | 'sources' | 'members' | 'shopping' | 'pantry' |
-- 'chores' | 'rewards' | 'redemptions' | 'xpbank' | 'choreweek' | 'calendars' | 'hiddenevents' |
-- 'settings' | 'visitlog' | 'copilotlog' | 'quickaddlog'.

create table if not exists family_data (
  household_id uuid        references households(id) on delete cascade not null,
  data_key     text        not null,
  data         jsonb       not null default '[]'::jsonb,
  updated_at   timestamptz default now() not null,
  primary key (household_id, data_key)
);

-- ── Row Level Security ───────────────────────────────────────────────────────

alter table households      enable row level security;
alter table household_members enable row level security;
alter table family_data     enable row level security;

-- Helper: returns the household_id of the current authenticated user.
-- search_path pinned (SECURITY DEFINER hygiene): resolves household_members in public only, so a
-- malicious same-name object in a caller-controlled schema can never shadow it.
create or replace function get_user_household_id()
returns uuid language sql security definer stable
set search_path = public
as $$
  select household_id
  from   household_members
  where  user_id = auth.uid()
  order by joined_at   -- deterministic: match the client's getOrCreateHousehold ordering (oldest first)
  limit  1;
$$;

-- households: members can read; owner can update; any auth user can create their own.
-- NOTE: `owner_id = auth.uid()` in the SELECT policy is required for the
-- INSERT ... RETURNING in getOrCreateHousehold to succeed on FIRST sign-in — at
-- that moment the household_members row doesn't exist yet, so get_user_household_id()
-- is still NULL and a members-only read policy would filter out the just-inserted row.
-- (drop-then-create so this file is safe to re-run in the SQL Editor.)
drop policy if exists "read own household"   on households;
drop policy if exists "create own household" on households;
drop policy if exists "owner can update"     on households;
create policy "read own household"   on households for select using (id = get_user_household_id() or owner_id = auth.uid());
create policy "create own household" on households for insert with check (owner_id = auth.uid());
create policy "owner can update"     on households for update using (owner_id = auth.uid());

-- household_members: anyone can see their membership; direct INSERTs are DENIED (F-04 §5a) — the
-- SECURITY DEFINER RPCs below (create_household / join_household_by_code) are the ONLY way to create
-- or join a membership, so learning a household_id never lets an attacker insert themselves into it.
drop policy if exists "read membership" on household_members;
drop policy if exists "join household"  on household_members;
drop policy if exists "leave household" on household_members;
create policy "read membership"  on household_members for select
  using (household_id = get_user_household_id() or user_id = auth.uid());
create policy "join household"   on household_members for insert with check (false);
create policy "leave household"  on household_members for delete using (user_id = auth.uid());

-- create_household(): the client's ONLY way to start a household (direct INSERTs are denied above).
-- Creates the row + this user's own membership atomically; the household_members unique constraint on
-- user_id makes a concurrent double-call fail safely (23505) rather than fork state.
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

-- regenerate_invite_code() (§5c): mint a fresh CSPRNG code for the caller's own household — the old
-- code stops working; the new one expires in 7 days. NULL when unauthenticated OR the caller has no
-- household (matching the client's documented contract).
create or replace function regenerate_invite_code()
returns text language plpgsql security definer set search_path = public as $$
declare
  hid uuid;
  new_code text;
begin
  if auth.uid() is null then return null; end if;
  hid := get_user_household_id();
  if hid is null then return null; end if;
  new_code := upper(encode(extensions.gen_random_bytes(8), 'hex'));
  update households set invite_code = new_code, invite_code_expires_at = now() + interval '7 days'
    where id = hid;
  return new_code;
end; $$;
revoke execute on function regenerate_invite_code() from anon;
grant  execute on function regenerate_invite_code() to authenticated;

-- §5d: join-attempt throttle storage (enumeration brake for the join RPC). No policies: only the
-- definer function below touches it. Indexed for the per-user window count; each caller's own stale
-- rows are pruned on their next attempt, so the table stays bounded by recently-active users.
create table if not exists join_attempts (
  user_id uuid not null, attempted_at timestamptz default now() not null
);
alter table join_attempts enable row level security;
create index if not exists join_attempts_user_time on join_attempts (user_id, attempted_at);

-- Join-by-invite-code (SECURITY DEFINER): a NON-member cannot SELECT a household by its invite code
-- (the households read policy only exposes your own / owned household), so joining must run with
-- elevated rights. Validates the code server-side (incl. the §5c expiry — a NULL expiry, from a
-- pre-hardening household, never expires), throttles attempts to 10/hour per user (§5d), re-points
-- the caller's membership, and returns the household id (or NULL for a bad/expired/throttled code).
-- Scoped to auth.uid() so a caller can only ever join THEMSELVES.
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
  -- Prune this caller's stale attempts, then count the last hour's window.
  delete from join_attempts where user_id = auth.uid() and attempted_at < now() - interval '1 hour';
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

-- family_data: full CRUD for household members only
drop policy if exists "household data access" on family_data;
create policy "household data access" on family_data
  for all
  using      (household_id = get_user_household_id())
  with check (household_id = get_user_household_id());

-- ── Server-set updated_at (§7) ────────────────────────────────────────────────
-- family_data.updated_at is the optimistic-concurrency (CAS) version token. Postgres stamps it on
-- every write so two clients with skewed clocks can never mint the same token; both write paths
-- already read back the server's returned value (.select('updated_at')), so this is a drop-in.

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
