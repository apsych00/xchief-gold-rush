-- Shared fixtures for the pgTAP suite. pgTAP tests run as `postgres`, which is why we can
-- insert straight into auth.users to create fixture identities.
--
-- Not itself an assertion file beyond a one-line sanity check - other files call these
-- functions after their own `select plan(N)`.

create extension if not exists pgtap with schema extensions;
create schema if not exists tests;

-- Inserts a confirmed-email auth user + a matching, email-populated players row.
create or replace function tests.create_confirmed_player(p_email text, p_display text default null)
returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, email_change,
    email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_email, crypt('x', gen_salt('bf')),
    now(), '{"provider":"email","providers":["email"]}', '{}',
    now(), now(), '', '', '', ''
  );
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
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, email_change,
    email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_email, crypt('x', gen_salt('bf')),
    null, '{"provider":"email","providers":["email"]}', '{}',
    now(), now(), '', '', '', ''
  );
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
  values (p_label, crypt(p_secret, gen_salt('bf')))
  returning id into v_id;
  return v_id;
end $$;

select plan(1);
select ok(true, 'fixtures loaded');
select * from finish();
