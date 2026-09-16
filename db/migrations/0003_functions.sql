-- The only write path. Two groups:
--   * service-role only (called by the edge functions that own the 5-second clock):
--       ensure_player, open_round, settle_round, void_round,
--       verify_kiosk, open_kiosk_round, settle_kiosk_round
--   * callable by a signed-in client (identity taken from auth.uid(), never from arguments):
--       get_me, claim_task, free_refill

-- ---------------------------------------------------------------- economy --

-- Payout multiplier for the wins BEFORE this round: 0 -> 1x, 1 -> 1.5x, 2 -> 2x, 3+ -> 3x.
create or replace function public.combo_mult(p_streak int)
returns numeric language sql immutable as $$
  select (array[1, 1.5, 2, 3]::numeric[])[least(greatest(p_streak, 0), 3) + 1];
$$;

create or replace function public.stake_for(p_lever int)
returns int language sql immutable as $$
  select 100 * p_lever;
$$;

-- ---------------------------------------------------------------- players --

-- Create the players row on first contact; copy the email in once it is confirmed.
create or replace function public.ensure_player(p_player uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_confirmed timestamptz;
begin
  select email, email_confirmed_at into v_email, v_confirmed
    from auth.users where id = p_player;
  if not found then
    raise exception 'unknown_user';
  end if;
  insert into public.players (id, email, display_name)
  values (
    p_player,
    case when v_confirmed is not null then v_email end,
    coalesce(nullif(split_part(coalesce(v_email, ''), '@', 1), ''), 'Player')
  )
  on conflict (id) do update set
    email = coalesce(excluded.email, public.players.email),
    display_name = coalesce(public.players.display_name, excluded.display_name),
    updated_at = now();
end $$;

create or replace function public.get_me()
returns public.players language plpgsql security definer set search_path = public as $$
declare
  p public.players%rowtype;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;
  perform public.ensure_player(auth.uid());
  select * into p from public.players where id = auth.uid();
  return p;
end $$;

-- ----------------------------------------------------------------- rounds --

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

create or replace function public.settle_round(p_round uuid, p_end_price numeric)
returns json language plpgsql security definer set search_path = public as $$
declare
  r public.rounds%rowtype;
  p public.players%rowtype;
  v_outcome text;
  v_mult numeric := 1;
  v_delta int := 0;
  v_coins int;
  v_streak int;
begin
  if p_end_price is null or p_end_price <= 0 then raise exception 'bad_price'; end if;

  select * into r from public.rounds where id = p_round for update;
  if not found or r.status <> 'open' or r.player_id is null then
    raise exception 'round_not_open';
  end if;
  select * into p from public.players where id = r.player_id for update;

  if p_end_price = r.start_price then
    v_outcome := 'flat';
  elsif (r.dir = 'up' and p_end_price > r.start_price) or (r.dir = 'down' and p_end_price < r.start_price) then
    v_outcome := 'win';
  else
    v_outcome := 'lose';
  end if;

  v_coins := p.coins;
  v_streak := p.streak;

  if v_outcome = 'win' then
    v_mult := public.combo_mult(p.streak);
    v_delta := round(r.stake * v_mult)::int;
    v_coins := p.coins + v_delta;
    v_streak := p.streak + 1;
    update public.players set
      coins = v_coins,
      record = greatest(record, v_coins),
      streak = v_streak,
      best_streak = greatest(best_streak, v_streak),
      wins = wins + 1,
      rounds = rounds + 1,
      updated_at = now()
    where id = p.id;
  elsif v_outcome = 'lose' then
    v_delta := -r.stake;
    v_coins := greatest(0, p.coins - r.stake);
    v_streak := 0;
    update public.players set
      coins = v_coins, streak = 0, rounds = rounds + 1, updated_at = now()
    where id = p.id;
  else
    update public.players set rounds = rounds + 1, updated_at = now() where id = p.id;
  end if;

  update public.rounds set
    end_price = p_end_price, end_at = now(), outcome = v_outcome,
    delta = v_delta, mult = v_mult, status = 'settled'
  where id = p_round;

  return json_build_object(
    'outcome', v_outcome, 'delta', v_delta, 'mult', v_mult,
    'coins', v_coins, 'streak', v_streak, 'record', greatest(p.record, v_coins),
    'start_price', r.start_price, 'end_price', p_end_price
  );
end $$;

-- A round whose price feed went stale: closed with no effect on coins or streak.
create or replace function public.void_round(p_round uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.rounds set status = 'settled', outcome = 'void', end_at = now()
  where id = p_round and status = 'open';
end $$;

-- ------------------------------------------------------------------ kiosk --

create or replace function public.verify_kiosk(p_secret text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if p_secret is null or length(p_secret) < 16 then raise exception 'kiosk_unauthorized'; end if;
  select id into v_id from public.kiosks
    where status = 'active' and secret_hash = crypt(p_secret, secret_hash);
  if v_id is null then raise exception 'kiosk_unauthorized'; end if;
  return v_id;
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
  begin
    insert into public.rounds (kiosk_id, dir, lever, stake, start_price)
    values (p_kiosk, p_dir, 1, 0, p_start_price)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'round_in_flight';
  end;
  return json_build_object('round_id', v_id, 'start_price', p_start_price);
end $$;

-- Five server-validated wins in a row claims one coupon, atomically, and resets the streak.
create or replace function public.settle_kiosk_round(p_round uuid, p_end_price numeric)
returns json language plpgsql security definer set search_path = public as $$
declare
  r public.rounds%rowtype;
  k public.kiosks%rowtype;
  v_outcome text;
  v_streak int;
  v_code text;
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
      v_streak := 0;
    end if;
  elsif v_outcome = 'lose' then
    v_streak := 0;
  end if;

  update public.kiosks set streak = v_streak where id = k.id;
  update public.rounds set end_price = p_end_price, end_at = now(), outcome = v_outcome, status = 'settled'
  where id = p_round;

  return json_build_object('outcome', v_outcome, 'streak', v_streak, 'coupon', v_code);
end $$;

-- ------------------------------------------------------------------ tasks --

create or replace function public.claim_task(p_task text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  t public.tasks%rowtype;
  v_last timestamptz;
  v_confirmed timestamptz;
  v_coins int;
begin
  if v_uid is null then raise exception 'unauthenticated'; end if;
  select * into t from public.tasks where id = p_task;
  if not found then raise exception 'unknown_task'; end if;

  perform public.ensure_player(v_uid);

  if t.requires_email then
    select email_confirmed_at into v_confirmed from auth.users where id = v_uid;
    if v_confirmed is null then raise exception 'email_required'; end if;
  end if;

  select max(claimed_at) into v_last from public.task_claims
    where player_id = v_uid and task_id = p_task;
  if v_last is not null and (t.repeat_ms is null or v_last > now() - make_interval(secs => t.repeat_ms / 1000.0)) then
    raise exception 'already_claimed';
  end if;

  insert into public.task_claims (player_id, task_id, reward) values (v_uid, p_task, t.reward);
  update public.players set
    coins = coins + t.reward,
    record = greatest(record, coins + t.reward),
    updated_at = now()
  where id = v_uid
  returning coins into v_coins;

  return json_build_object('coins', v_coins, 'reward', t.reward);
end $$;

create or replace function public.free_refill()
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  p public.players%rowtype;
  v_coins int;
begin
  if v_uid is null then raise exception 'unauthenticated'; end if;
  perform public.ensure_player(v_uid);
  select * into p from public.players where id = v_uid for update;
  if p.free_refill_used or p.coins >= 100 then raise exception 'refill_unavailable'; end if;
  update public.players set
    coins = coins + 300,
    record = greatest(record, coins + 300),
    free_refill_used = true,
    updated_at = now()
  where id = v_uid
  returning coins into v_coins;
  return json_build_object('coins', v_coins, 'reward', 300);
end $$;

-- ----------------------------------------------------------------- grants --

-- Service-role only: a client holding the anon key must not be able to call these.
revoke execute on function
  public.ensure_player(uuid),
  public.open_round(uuid, text, int, numeric),
  public.settle_round(uuid, numeric),
  public.void_round(uuid),
  public.verify_kiosk(text),
  public.open_kiosk_round(uuid, text, numeric),
  public.settle_kiosk_round(uuid, numeric)
from public, anon, authenticated;

-- Client-callable, identity from the JWT.
revoke execute on function public.get_me(), public.claim_task(text), public.free_refill() from public, anon;
grant execute on function public.get_me(), public.claim_task(text), public.free_refill() to authenticated;
