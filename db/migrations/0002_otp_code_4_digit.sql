-- Login OTP code 8 digits -> 4 (commit 1b71586). db/schema.sql already defines
-- public.request_otp_code() at 4 digits, so a fresh database never needs this file - it only
-- matters to a database that has db/schema.sql recorded as applied from before that commit,
-- which would otherwise keep issuing 8-digit codes forever while every client only accepts 4,
-- locking out every new user.
--
-- create or replace is safe to run whether or not the box was already hand-patched.
create or replace function public.request_otp_code(p_player uuid, p_email text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_code text;
begin
  -- Ticket S2 / red team D3: a new code supersedes every earlier unused one for the same
  -- email, so verify_otp_code's "newest unused code" lookup always finds this one - guessing
  -- an older still-live code stops being a way to keep the 5-attempt budget going forever.
  update public.otp_codes set used_at = now() where email = p_email and used_at is null;

  -- 4 digits zero-padded (0000-9999 is a legal code, "0042" stays 4 characters).
  v_code := to_char(floor(random() * 10000)::int, 'FM0000');
  insert into public.otp_codes (player_id, email, code_hash, expires_at)
  values (p_player, p_email, encode(extensions.digest(v_code, 'sha256'), 'hex'), now() + interval '10 minutes');
  return v_code;
end $$;
