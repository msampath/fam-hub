-- Family-Hub — Supabase schema
-- Run this entire file in the Supabase SQL Editor (once, on a fresh project).

-- ── Households ───────────────────────────────────────────────────────────────

create table if not exists households (
  id          uuid        default gen_random_uuid() primary key,
  owner_id    uuid        references auth.users(id) on delete cascade not null,
  invite_code text        unique default upper(substr(md5(gen_random_uuid()::text), 1, 6)) not null,
  created_at  timestamptz default now() not null
);

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

-- Helper: returns the household_id of the current authenticated user
create or replace function get_user_household_id()
returns uuid language sql security definer stable as $$
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

-- household_members: anyone can see their membership; anyone can insert their own row (join)
drop policy if exists "read membership" on household_members;
drop policy if exists "join household"  on household_members;
drop policy if exists "leave household" on household_members;
create policy "read membership"  on household_members for select
  using (household_id = get_user_household_id() or user_id = auth.uid());
create policy "join household"   on household_members for insert with check (user_id = auth.uid());
create policy "leave household"  on household_members for delete using (user_id = auth.uid());

-- Join-by-invite-code (SECURITY DEFINER): a NON-member cannot SELECT a household by its invite code
-- (the households read policy only exposes your own / owned household), so joining must run with
-- elevated rights. This validates the code server-side, re-points the caller's membership to that
-- household, and returns its id (or NULL for a bad code). Scoped to auth.uid() so a caller can only
-- ever join THEMSELVES. (Also hardens the deferred "server-validate the invite-join" item.)
create or replace function join_household_by_code(code text)
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
  select id into hid from households where invite_code = upper(trim(code));
  if hid is null then
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
