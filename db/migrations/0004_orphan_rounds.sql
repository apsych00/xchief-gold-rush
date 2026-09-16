-- Self-healing for orphaned rounds. If an edge function dies between open and settle, the
-- round would stay 'open' forever and the unique index would lock that player or kiosk out
-- with round_in_flight. A round older than 30s can no longer be honestly settled (the
-- 5-second window is long gone), so opening a new one first voids any such leftover.

create or replace function public.open_round(p_player uuid, p_dir text, p_lever int, p_start_price numeric)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_stake int;
  v_coins int;
  v_recent int;
  v_id uuid;
begin
  if p_dir not in ('up', 'down') then raise exception 'bad_dir'; end if;
  if p_lever not in (1, 2, 5) then raise exception 'bad_lever'; end if;
  if p_start_price is null or p_start_price <= 0 then raise exception 'bad_price'; end if;

  perform public.ensure_player(p_player);
  v_stake := public.stake_for(p_lever);

  -- void leftovers that can never settle honestly
  update public.rounds set status = 'settled', outcome = 'void', end_at = now()
  where player_id = p_player and status = 'open' and start_at < now() - interval '30 seconds';

  select coins into v_coins from public.players where id = p_player for update;
  if v_coins < v_stake then raise exception 'insufficient_coins'; end if;

  select count(*) into v_recent from public.rounds
    where player_id = p_player and created_at > now() - interval '1 hour';
  if v_recent >= 60 then raise exception 'rate_limited'; end if;

  begin
    insert into public.rounds (player_id, dir, lever, stake, start_price)
    values (p_player, p_dir, p_lever, v_stake, p_start_price)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'round_in_flight';
  end;

  return json_build_object('round_id', v_id, 'stake', v_stake, 'start_price', p_start_price);
end $$;

create or replace function public.open_kiosk_round(p_kiosk uuid, p_dir text, p_start_price numeric)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if p_dir not in ('up', 'down') then raise exception 'bad_dir'; end if;
  if p_start_price is null or p_start_price <= 0 then raise exception 'bad_price'; end if;
  if not exists (select 1 from public.kiosks where id = p_kiosk and status = 'active') then
    raise exception 'kiosk_unauthorized';
  end if;

  update public.rounds set status = 'settled', outcome = 'void', end_at = now()
  where kiosk_id = p_kiosk and status = 'open' and start_at < now() - interval '30 seconds';

  begin
    insert into public.rounds (kiosk_id, dir, lever, stake, start_price)
    values (p_kiosk, p_dir, 1, 0, p_start_price)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'round_in_flight';
  end;
  return json_build_object('round_id', v_id, 'start_price', p_start_price);
end $$;

revoke execute on function
  public.open_round(uuid, text, int, numeric),
  public.open_kiosk_round(uuid, text, numeric)
from public, anon, authenticated;
