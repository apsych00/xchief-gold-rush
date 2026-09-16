-- Shared fixtures for the pgTAP suite. pgTAP tests run as `postgres`, which is why we can
-- insert straight into auth.users to create fixture identities.
--
-- On the box the auth.users table is the small server-owned one from 0000_compat.sql:
-- (id, email, email_confirmed_at, created_at). The Supabase GoTrue columns the previous
-- version of this file filled (instance_id, aud, role, encrypted_password, raw_*_meta_data,
-- tokens, updated_at) carry no meaning there and none of them is read by the game SQL, so
-- the inserts drop them. "Confirmed" means email_confirmed_at is set, exactly as before.
-- pgcrypto lives in the `extensions` schema (placed there by 0000_compat), so crypt() and
-- gen_salt() are referenced with that schema qualification.
--
-- Not itself an assertion file beyond a one-line sanity check - other files call these
-- functions after their own `select plan(N)`.

create extension if not exists pgtap;
create schema if not exists tests;

-- Inserts a confirmed-email auth user + a matching, email-populated players row.
create or replace function tests.create_confirmed_player(p_email text, p_display text default null)
returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, email_confirmed_at)
  values (v_id, p_email, now());
  perform public.ensure_player(v_id);
  if p_display is not null then
    update public.players set display_name = p_display where id = v_id;
  end if;
  return v_id;
end $$;

-- Inserts an unconfirmed auth user + players row (email stays null on players per ensure_player).
create or replace function tests.create_unconfirmed_player(p_email text)
returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_id, p_email);
  perform public.ensure_player(v_id);
  return v_id;
end $$;

-- Inserts a bare auth user with no email at all - the real anonymous-player shape - plus a
-- matching players row, returns the id.
create or replace function tests.create_anonymous_player()
returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_id);
  perform public.ensure_player(v_id);
  return v_id;
end $$;

-- Inserts an active kiosk with a known raw secret, returns the kiosk id.
create or replace function tests.create_kiosk(p_label text, p_secret text)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.kiosks (label, secret_hash)
  values (p_label, extensions.crypt(p_secret, extensions.gen_salt('bf')))
  returning id into v_id;
  return v_id;
end $$;

select plan(1);
select ok(true, 'fixtures loaded');
select * from finish();
