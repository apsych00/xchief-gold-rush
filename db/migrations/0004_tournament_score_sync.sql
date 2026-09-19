-- Tournament score desync fix (score-single-source): every coin-granting path now keeps
-- public.tournament_scores in step with players.coins, not just settle_round.
--
-- Before this, settle_round was the ONLY function writing tournament_scores - the table the
-- public leaderboard and my_rank() actually rank on. Every reward path (claim_task,
-- release_task_reward, free_refill, and the email/signup grant inside verify_otp_code) raised
-- players.coins and stopped, so a player who verified their email or claimed a mission saw the
-- balance move in their own UI but never appeared on the board until they happened to play a
-- round. db/schema.sql already defines all of this in the new shape, so a fresh database never
-- needs this file; it exists for every database that recorded schema.sql before that commit.
--
-- All of these are create-or-replace of existing bodies (plus one new function), so this is safe
-- to run whether or not a box was already hand-patched.
create or replace function public.bump_tournament_score(p_player uuid, p_coins int, p_tournament text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tournament_id text := p_tournament;
begin
  if v_tournament_id is null then
    select id into v_tournament_id from public.current_tournament();
  end if;
  if v_tournament_id is null then return; end if;
  insert into public.tournament_scores (tournament_id, player_id, record, updated_at)
  values (v_tournament_id, p_player, p_coins, now())
  on conflict (tournament_id, player_id) do update
    set record = excluded.record, updated_at = excluded.updated_at
    where excluded.record > public.tournament_scores.record;
end $$;

create or replace function public.release_task_reward(p_player uuid, p_task text)
returns json language plpgsql security definer set search_path = public as $$
declare
  t public.tasks%rowtype;
  v_device_id uuid;
  v_email text;
  v_coins int;
  v_ip inet;
begin
  v_ip := nullif(current_setting('app.client_ip', true), '')::inet;
  select * into t from public.tasks where id = p_task;
  if not found then raise exception 'unknown_task'; end if;

  perform public.ensure_player(p_player);
  perform 1 from public.players where id = p_player for update;

  select device_id, email into v_device_id, v_email from public.players where id = p_player;

  if exists (select 1 from public.task_claims where player_id = p_player and task_id = p_task) then
    return null;
  end if;

  if v_email is not null and exists (
    select 1 from public.task_claims tc
    join public.players p2 on p2.id = tc.player_id
    where tc.task_id = p_task and p2.email = v_email and tc.player_id <> p_player
  ) then
    return null;
  end if;

  begin
    insert into public.task_claims (player_id, task_id, reward, device_id, claimed_ip)
    values (p_player, p_task, t.reward, v_device_id, v_ip);
  exception when unique_violation then
    return null;
  end;

  update public.players set
    coins = coins + t.reward,
    record = greatest(record, coins + t.reward),
    updated_at = now()
  where id = p_player
  returning coins into v_coins;

  perform public.bump_tournament_score(p_player, v_coins);
  return json_build_object('coins', v_coins, 'reward', t.reward);
end $$;

create or replace function public.claim_task(p_task text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  t public.tasks%rowtype;
  v_last timestamptz;
  v_confirmed timestamptz;
  v_coins int;
  v_device_id uuid;
  v_email text;
  v_ip inet;
begin
  if v_uid is null then raise exception 'unauthenticated'; end if;
  v_ip := nullif(current_setting('app.client_ip', true), '')::inet;
  select * into t from public.tasks where id = p_task;
  if not found then raise exception 'unknown_task'; end if;
  -- ticket B6+B7+B9 decision 5: claim_task from the client remains only for kind='manual' - every
  -- other kind is released by the server itself (report_video_progress, return_task_visit,
  -- verify_otp_code), never by a client-initiated claim.
  if t.kind <> 'manual' then raise exception 'not_claimable'; end if;

  perform public.ensure_player(v_uid);
  -- Serialize all claims for this player: the check below and the insert run under this lock.
  perform 1 from public.players where id = v_uid for update;

  if t.requires_email then
    select email_confirmed_at into v_confirmed from auth.users where id = v_uid;
    if v_confirmed is null then raise exception 'email_required'; end if;
  end if;

  select device_id, email into v_device_id, v_email from public.players where id = v_uid;

  select max(claimed_at) into v_last from public.task_claims
    where player_id = v_uid and task_id = p_task;
  if v_last is not null and (t.repeat_ms is null or v_last > now() - make_interval(secs => t.repeat_ms / 1000.0)) then
    raise exception 'already_claimed';
  end if;

  if v_email is not null and exists (
    select 1 from public.task_claims tc
    join public.players p2 on p2.id = tc.player_id
    where tc.task_id = p_task and p2.email = v_email and tc.player_id <> v_uid
  ) then
    raise exception 'already_claimed';
  end if;

  begin
    insert into public.task_claims (player_id, task_id, reward, device_id, claimed_ip)
    values (v_uid, p_task, t.reward, v_device_id, v_ip);
  exception when unique_violation then
    raise exception 'already_claimed';
  end;

  update public.players set
    coins = coins + t.reward,
    record = greatest(record, coins + t.reward),
    updated_at = now()
  where id = v_uid
  returning coins into v_coins;

  perform public.bump_tournament_score(v_uid, v_coins);
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
  -- Two distinct reasons this refuses, so the caller can tell "you already used yours" from
  -- "you don't need it yet" (docs/layers.md C5: a second free_refill is `already_refilled`).
  if p.free_refill_used then raise exception 'already_refilled'; end if;
  if p.coins >= 100 then raise exception 'refill_unavailable'; end if;

  if p.email is not null and exists (
    select 1 from public.players p2
    where p2.email = p.email and p2.id <> v_uid and p2.free_refill_used
  ) then
    raise exception 'already_refilled';
  end if;

  begin
    update public.players set
      coins = coins + 300,
      record = greatest(record, coins + 300),
      free_refill_used = true,
      updated_at = now()
    where id = v_uid
    returning coins into v_coins;
  exception when unique_violation then
    raise exception 'already_refilled';
  end;

  perform public.bump_tournament_score(v_uid, v_coins);
  return json_build_object('coins', v_coins, 'reward', 300);
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
  v_tournament_id text;
begin
  select id into v_tournament_id from public.current_tournament();
  if p_end_price is null or p_end_price <= 0 then raise exception 'bad_price'; end if;
  select * into r from public.rounds where id = p_round for update;
  if not found or r.status <> 'open' or r.player_id is null then raise exception 'round_not_open'; end if;
  select * into p from public.players where id = r.player_id for update;
  if p_end_price = r.start_price then v_outcome := 'flat';
  elsif (r.dir = 'up' and p_end_price > r.start_price) or (r.dir = 'down' and p_end_price < r.start_price) then v_outcome := 'win';
  else v_outcome := 'lose'; end if;
  v_coins := p.coins; v_streak := p.streak;
  if v_outcome = 'win' then
    v_mult := public.combo_mult(p.streak);
    v_delta := round(r.stake * v_mult)::int;
    v_coins := p.coins + v_delta; v_streak := p.streak + 1;
    update public.players set coins = v_coins, record = greatest(record, v_coins), streak = v_streak,
      best_streak = greatest(best_streak, v_streak), wins = wins + 1, rounds = rounds + 1, updated_at = now() where id = p.id;
  elsif v_outcome = 'lose' then
    v_delta := -r.stake; v_coins := greatest(0, p.coins - r.stake); v_streak := 0;
    update public.players set coins = v_coins, streak = 0, rounds = rounds + 1, updated_at = now() where id = p.id;
  else
    update public.players set rounds = rounds + 1, updated_at = now() where id = p.id;
  end if;
  update public.rounds set end_price = p_end_price, end_at = now(), outcome = v_outcome, delta = v_delta, mult = v_mult,
    status = 'settled', tournament_id = v_tournament_id where id = p_round;
  perform public.bump_tournament_score(p.id, v_coins, v_tournament_id);
  return json_build_object('outcome', v_outcome, 'delta', v_delta, 'mult', v_mult, 'coins', v_coins, 'streak', v_streak,
    'record', greatest(p.record, v_coins), 'best_streak', greatest(p.best_streak, v_streak), 'start_price', r.start_price, 'end_price', p_end_price);
end $$;

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

  update public.otp_codes set used_at = now() where id = v_row.id;

  if v_taken is not null then
    return 'logged_in:' || v_taken::text;
  end if;

  insert into auth.users (id, email, email_confirmed_at)
  values (p_player, p_email, now())
  on conflict (id) do update set email = excluded.email, email_confirmed_at = excluded.email_confirmed_at;

  update public.players set email = p_email, updated_at = now() where id = p_player;

  return 'ok';
end $$;

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
