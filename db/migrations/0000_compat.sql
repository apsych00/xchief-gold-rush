-- Box compatibility layer.
--
-- The game SQL (0001..0007) was written for Supabase, which supplies an `auth` schema,
-- `auth.uid()`, an `auth.users` table and the `anon` / `authenticated` roles. On the box the
-- game server verifies identity itself and sets it per transaction:
--
--   select set_config('app.player_id', '<uuid>', true);   -- SET LOCAL, cleared at commit
--
-- and `auth.uid()` reads it back. Identity therefore still never comes from a client-supplied
-- function argument. Everything in 0001..0007 applies unchanged, and the pgTAP suites that use
-- `set role anon` keep running as the regression proof for the access layer.

create schema if not exists auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public, extensions to anon, authenticated, service_role;
grant execute on all functions in schema extensions to anon, authenticated, service_role;

-- Supabase granted table access to these roles by default; the migrations then revoke what the
-- client must not touch. Mirror that starting point so the revokes mean the same thing here.
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- The identity table the server owns. Only the three columns the game reads.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  email_confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(current_setting('app.player_id', true), '')::uuid
$$;
