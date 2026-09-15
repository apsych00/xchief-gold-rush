-- Two fixes.
-- 1. Supabase installs pgcrypto in the `extensions` schema. verify_kiosk pinned search_path to
--    `public`, so crypt() was not found and every kiosk call failed as unauthorized.
-- 2. Supabase's linter flags SECURITY DEFINER views. Replace the leaderboard view with a
--    SECURITY DEFINER function that returns only the three safe columns - same access model
--    (anonymous visitors can read the top 10, nothing else about players), accepted pattern.

create or replace function public.verify_kiosk(p_secret text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id uuid;
begin
  if p_secret is null or length(p_secret) < 16 then raise exception 'kiosk_unauthorized'; end if;
  select id into v_id from public.kiosks
    where status = 'active' and secret_hash = crypt(p_secret, secret_hash);
  if v_id is null then raise exception 'kiosk_unauthorized'; end if;
  return v_id;
end $$;
revoke execute on function public.verify_kiosk(text) from public, anon, authenticated;

drop view if exists public.leaderboard;

create or replace function public.leaderboard()
returns table (display_name text, record int, rank bigint)
language sql security definer stable set search_path = public as $$
  select display_name, record, rank() over (order by record desc, updated_at asc) as rank
  from public.players
  where email is not null
  order by record desc, updated_at asc
  limit 10;
$$;
revoke execute on function public.leaderboard() from public;
grant execute on function public.leaderboard() to anon, authenticated;
