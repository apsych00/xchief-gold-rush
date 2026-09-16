-- Box rules (docs/box-plan.md, "Decisions locked"):
--   * 400 rounds per player per rolling hour (was 60)
--   * rounds.source recorded for audit only
--   * kiosk streak resets after 60 s with no round on that kiosk
--   * an empty coupon pool keeps the streak and reports exhausted instead of silently resetting

alter table public.rounds add column if not exists source text;
alter table public.kiosks add column if not exists last_round_at timestamptz;

-- create or replace cannot change an argument list: adding p_source as a defaulted 5th/4th
-- parameter silently left the 0004 versions installed, and 4-arg / 3-arg calls (which the
-- server makes when the source is unknown) would still have resolved to them - old 60/hr cap,
-- no idle reset. Drop the superseded overloads so exactly one open_round / open_kiosk_round
-- exists and every call gets the box rules.
drop function if exists public.open_round(uuid, text, int, numeric);
drop function if exists public.open_kiosk_round(uuid, text, numeric);

create or replace function public.open_round(p_player uuid, p_dir text, p_lever int, p_start_price numeric, p_source text default null)
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

  update public.rounds set status = 'settled', outcome = 'void', end_at = now()
  where player_id = p_player and status = 'open' and start_at < now() - interval '30 seconds';

  select coins into v_coins from public.players where id = p_player for update;
  if v_coins < v_stake then raise exception 'insufficient_coins'; end if;

  select count(*) into v_recent from public.rounds
    where player_id = p_player and created_at > now() - interval '1 hour';
  if v_recent >= 400 then raise exception 'rate_limited'; end if;

  begin
    insert into public.rounds (player_id, dir, lever, stake, start_price, source)
    values (p_player, p_dir, p_lever, v_stake, p_start_price, p_source)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'round_in_flight';
  end;

  return json_build_object('round_id', v_id, 'stake', v_stake, 'start_price', p_start_price);
end $$;

create or replace function public.open_kiosk_round(p_kiosk uuid, p_dir text, p_start_price numeric, p_source text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  k public.kiosks%rowtype;
begin
  if p_dir not in ('up', 'down') then raise exception 'bad_dir'; end if;
  if p_start_price is null or p_start_price <= 0 then raise exception 'bad_price'; end if;

  select * into k from public.kiosks where id = p_kiosk and status = 'active' for update;
  if not found then raise exception 'kiosk_unauthorized'; end if;

  -- a new visitor starts fresh: no round on this kiosk for 60 s resets the streak
  if k.last_round_at is not null and k.last_round_at < now() - interval '60 seconds' and k.streak > 0 then
    update public.kiosks set streak = 0 where id = p_kiosk;
  end if;
  update public.kiosks set last_round_at = now() where id = p_kiosk;

  update public.rounds set status = 'settled', outcome = 'void', end_at = now()
  where kiosk_id = p_kiosk and status = 'open' and start_at < now() - interval '30 seconds';

  begin
    insert into public.rounds (kiosk_id, dir, lever, stake, start_price, source)
    values (p_kiosk, p_dir, 1, 0, p_start_price, p_source)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'round_in_flight';
  end;
  return json_build_object('round_id', v_id, 'start_price', p_start_price);
end $$;

create or replace function public.settle_kiosk_round(p_round uuid, p_end_price numeric)
returns json language plpgsql security definer set search_path = public as $$
declare
  r public.rounds%rowtype;
  k public.kiosks%rowtype;
  v_outcome text;
  v_streak int;
  v_code text;
  v_exhausted boolean := false;
begin
  if p_end_price is null or p_end_price <= 0 then raise exception 'bad_price'; end if;

  select * into r from public.rounds where id = p_round for update;
  if not found or r.status <> 'open' or r.kiosk_id is null then
    raise exception 'round_not_open';
  end if;
  select * into k from public.kiosks where id = r.kiosk_id for update;

  if p_end_price = r.start_price then
    v_outcome := 'flat';
  elsif (r.dir = 'up' and p_end_price > r.start_price) or (r.dir = 'down' and p_end_price < r.start_price) then
    v_outcome := 'win';
  else
    v_outcome := 'lose';
  end if;

  v_streak := k.streak;
  if v_outcome = 'win' then
    v_streak := k.streak + 1;
    if v_streak >= 5 then
      update public.coupons set status = 'claimed', claimed_by_kiosk = k.id, claimed_at = now()
      where id = (
        select id from public.coupons where status = 'available'
        order by created_at limit 1 for update skip locked
      )
      returning code into v_code;
      if v_code is null then
        -- pool empty: keep the streak so the visitor is not robbed; the kiosk tells the staff
        v_exhausted := true;
        raise warning 'coupons_exhausted: kiosk % reached a 5-win streak with no codes left', k.id;
      else
        v_streak := 0;
      end if;
    end if;
  elsif v_outcome = 'lose' then
    v_streak := 0;
  end if;

  update public.kiosks set streak = v_streak, last_round_at = now() where id = k.id;
  update public.rounds set end_price = p_end_price, end_at = now(), outcome = v_outcome, status = 'settled'
  where id = p_round;

  return json_build_object('outcome', v_outcome, 'streak', v_streak, 'coupon', v_code, 'coupons_exhausted', v_exhausted,
                           'start_price', r.start_price, 'end_price', p_end_price);
end $$;

revoke execute on function
  public.open_round(uuid, text, int, numeric, text),
  public.open_kiosk_round(uuid, text, numeric, text),
  public.settle_kiosk_round(uuid, numeric)
from public, anon, authenticated;
