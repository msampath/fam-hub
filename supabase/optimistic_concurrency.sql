-- OPTIONAL hardening for optimistic concurrency (§5.3).
--
-- The app's stale-write rejection (compare-and-set on family_data.updated_at) works WITHOUT this — the
-- updated_at column already exists (see schema.sql) and the client stamps it on every write. This trigger
-- just makes updated_at SERVER-authoritative (always = now() on the server), so the version token can't be
-- skewed by a client's wrong clock. Run once in the Supabase SQL editor if you want that extra robustness.

create or replace function family_data_touch() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists family_data_touch on family_data;
create trigger family_data_touch
  before insert or update on family_data
  for each row execute function family_data_touch();
