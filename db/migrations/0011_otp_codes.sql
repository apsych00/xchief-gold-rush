-- Ticket 4: login codes on the box (docs/box-plan.md 1.5, docs/box-spec.md 1.5).
--
-- otp_codes holds one row per requested code and only its sha256 hash, never the code itself.
-- Two service-role-only functions own the whole lifecycle; the client never reads or writes
-- this table, and identity still never comes from a client-supplied argument - the server has
-- already verified the caller's token before it ever calls request_otp_code/verify_otp_code.

create table public.otp_codes (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null,
  email text not null,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index otp_codes_email_created on public.otp_codes (email, created_at desc);

alter table public.otp_codes enable row level security;
revoke all on public.otp_codes from public, anon, authenticated;

-- Generates an 8-digit code, stores only its hash, returns the plain code once so the caller
-- (server/otp.js) can mail it or, in dev, capture it in dev_otps.
create or replace function public.request_otp_code(p_player uuid, p_email text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_code text;
begin
  v_code := to_char(floor(random() * 100000000)::int, 'FM00000000');
  insert into public.otp_codes (player_id, email, code_hash, expires_at)
  values (p_player, p_email, encode(extensions.digest(v_code, 'sha256'), 'hex'), now() + interval '10 minutes');
  return v_code;
end $$;

-- The newest unused, unexpired code for (player, email) gets five guesses. The right code
-- confirms the email on this player, unless another player already holds it confirmed - then
-- nothing changes and the caller gets email_taken (merging that case is Layer 2).
--
-- Returns text, not the boolean the spec sketch names, for a reason worth recording: a plain
-- `raise exception` aborts the whole calling statement, undoing any UPDATE made earlier in the
-- same call (verified live against this database - see the ticket 4 handoff report). So a wrong
-- guess cannot both durably increment `attempts` AND raise in the same call; the increment would
-- never survive to the next guess and too_many_attempts could never be reached. Only the two
-- outcomes with nothing left to lose (no live code at all; another player already owns the
-- email) still raise, exactly as every other function in this file does. A wrong guess instead
-- returns a status text so its attempts update commits normally; ledger.js turns that into the
-- same error shape as everything else.
create or replace function public.verify_otp_code(p_player uuid, p_email text, p_code text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_row public.otp_codes%rowtype;
  v_attempts int;
  v_taken uuid;
begin
  select * into v_row from public.otp_codes
    where player_id = p_player and email = p_email and used_at is null and expires_at > now()
    order by created_at desc
    limit 1
    for update;

  if not found then
    raise exception 'expired_code';
  end if;

  if v_row.code_hash <> encode(extensions.digest(p_code, 'sha256'), 'hex') then
    v_attempts := v_row.attempts + 1;
    if v_attempts >= 5 then
      update public.otp_codes set attempts = v_attempts, used_at = now() where id = v_row.id;
      return 'too_many_attempts';
    end if;
    update public.otp_codes set attempts = v_attempts where id = v_row.id;
    return 'invalid_code';
  end if;

  select id into v_taken from public.players where email = p_email and id <> p_player for update;
  if v_taken is not null then
    raise exception 'email_taken';
  end if;

  update public.otp_codes set used_at = now() where id = v_row.id;

  insert into auth.users (id, email, email_confirmed_at)
  values (p_player, p_email, now())
  on conflict (id) do update set email = excluded.email, email_confirmed_at = excluded.email_confirmed_at;

  update public.players set email = p_email, updated_at = now() where id = p_player;

  return 'ok';
end $$;

revoke execute on function public.request_otp_code(uuid, text), public.verify_otp_code(uuid, text, text)
from public, anon, authenticated;
