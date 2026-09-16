-- xChief Gold Rush: the complete box database schema, in one file.
--
-- This is the entire database that migrations 0000..0011 used to add up to,
-- written as if designed in one pass: each table once with its final columns,
-- each function once with its final body and signature, each grant and revoke
-- stated once, at the end. There are no users of this database yet, so there is
-- no migration history to preserve: apply this file once to a fresh
-- PostgreSQL 16, then db/seed.sql. server/migrate.mjs and db/run-tests.sh do
-- exactly that.
--
-- The server owns every outcome and every coin. Clients never write these
-- tables directly (see the RLS section); every mutation goes through one of the
-- SECURITY DEFINER functions below or the service role.

-- ---------------------------------------------------------------- auth compatibility layer --
--
-- The game SQL was written for Supabase, which supplies an `auth` schema,
-- `auth.uid()`, an `auth.users` table and the `anon` / `authenticated` roles. On
-- the box the game server verifies identity itself and sets it per transaction:
--
--   select set_config('app.player_id', '<uuid>', true);   -- SET LOCAL, cleared at commit
--
-- and `auth.uid()` reads it back. Identity therefore still never comes from a
-- client-supplied function argument, and the pgTAP suites that use
-- `set role anon` keep running as the regression proof for the access layer.

-- pgcrypto is the game's only extension. Supabase installs it into the
-- `extensions` schema, so we do too (verify_kiosk and the OTP functions depend
-- on that search_path, see their comments in the Functions section).
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

-- Supabase granted table access to these roles by default; this schema then
-- revokes what the client must not touch. Mirror that starting point so the
-- revokes mean the same thing here. (These defaults apply to everything created
-- after this point, so this block must stay ahead of the table and function
-- definitions below.)
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

-- ------------------------------------------------------------------------------- tables --

-- One row per auth user (anonymous or email). Created lazily by ensure_player().
create table public.players (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  email text, -- set only once the email is confirmed; null = not eligible for the leaderboard
  coins int not null default 1000,
  record int not null default 1000, -- peak balance; the leaderboard ranks this
  streak int not null default 0,
  best_streak int not null default 0,
  wins int not null default 0,
  rounds int not null default 0,
  free_refill_used boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Physical booth devices. The raw secret is never stored, only its bcrypt hash.
create table public.kiosks (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  secret_hash text not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  streak int not null default 0, -- consecutive server-validated wins on this kiosk
  created_at timestamptz not null default now(),
  last_round_at timestamptz -- drives the 60 s idle streak reset (docs/box-plan.md)
);

-- Every round, web or kiosk. Also the audit trail: both prices and both
-- timestamps are recorded.
create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  player_id uuid references public.players (id) on delete cascade,
  kiosk_id uuid references public.kiosks (id) on delete cascade,
  dir text not null check (dir in ('up', 'down')),
  lever int not null default 1 check (lever in (1, 2, 5)),
  stake int not null default 0,
  start_price numeric not null,
  end_price numeric,
  start_at timestamptz not null default now(),
  end_at timestamptz,
  outcome text check (outcome in ('win', 'lose', 'flat', 'void')),
  delta int not null default 0,
  mult numeric not null default 1,
  status text not null default 'open' check (status in ('open', 'settled')),
  created_at timestamptz not null default now(),
  source text, -- which feed price the round was opened on; recorded for audit only
  check (player_id is not null or kiosk_id is not null)
);

-- Server-side mirror of the task rewards in src/config.js.
create table public.tasks (
  id text primary key,
  reward int not null,
  repeat_ms bigint, -- null = one-time
  requires_email boolean not null default false
);

create table public.task_claims (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players (id) on delete cascade,
  task_id text not null references public.tasks (id),
  claimed_at timestamptz not null default now(),
  reward int not null
);

-- The $100 codes. Claimed atomically, once each.
create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null default 'available' check (status in ('available', 'claimed')),
  claimed_by_kiosk uuid references public.kiosks (id),
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Dev-only OTP capture. When the OTP sender has no ELASTIC_API_KEY configured, it
-- stores the login code here instead of sending mail, so the login flow can be
-- tested without an email provider. Production always has the key, so this table
-- stays empty there. Service role only: no client role can read or write it.
create table public.dev_otps (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  token text not null,
  created_at timestamptz not null default now()
);

-- Login codes (docs/box-plan.md 1.5, docs/box-spec.md 1.5). One row per requested
-- code, holding only its sha256 hash, never the code itself. Two service-role-only
-- functions own the whole lifecycle; the client never reads or writes this table,
-- and identity still never comes from a client-supplied argument - the server has
-- already verified the caller's token before it ever calls request_otp_code.
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

-- ------------------------------------------------------------------------------ indexes --

-- One round in flight per identity. This is what keeps streaks honest:
-- a second concurrent round cannot be opened to fish for a win.
create unique index uniq_open_round_per_player on public.rounds (player_id)
  where status = 'open' and player_id is not null;
create unique index uniq_open_round_per_kiosk on public.rounds (kiosk_id)
  where status = 'open' and kiosk_id is not null;
create index rounds_player_created on public.rounds (player_id, created_at desc);
create index task_claims_player_task on public.task_claims (player_id, task_id, claimed_at desc);
create index coupons_available on public.coupons (created_at) where status = 'available';
create index dev_otps_email_created on public.dev_otps (email, created_at desc);
create index otp_codes_email_created on public.otp_codes (email, created_at desc);

-- ----------------------------------------------------------------- RLS + policies --
--
-- Row Level Security: the client may read its own data and the public leaderboard,
-- nothing else. Writes are impossible from the client: privileges are revoked
-- outright (see the Grants section), and every mutation happens inside SECURITY
-- DEFINER functions or as the service role.

alter table public.players enable row level security;
alter table public.rounds enable row level security;
alter table public.tasks enable row level security;
alter table public.task_claims enable row level security;
alter table public.kiosks enable row level security;
alter table public.coupons enable row level security;
alter table public.dev_otps enable row level security;
alter table public.otp_codes enable row level security;

create policy players_select_own on public.players
  for select to authenticated using (id = auth.uid());

create policy rounds_select_own on public.rounds
  for select to authenticated using (player_id = auth.uid());

create policy task_claims_select_own on public.task_claims
  for select to authenticated using (player_id = auth.uid());

create policy tasks_select_all on public.tasks
  for select to anon, authenticated using (true);

-- kiosks, coupons, dev_otps and otp_codes deliberately have NO client policy:
-- service-role tables. The public top-10 leaderboard is exposed through the
-- SECURITY DEFINER function public.leaderboard() below, not a view: Supabase's
-- linter flags SECURITY DEFINER views, and a function keeps the same access
-- model (anonymous visitors can read the top 10, nothing else about players).

-- ---------------------------------------------------------------------------- functions --
--
-- The only write path. Two groups:
--   * service-role only (called by the game server that owns the 5-second clock):
--       ensure_player, open_round, settle_round, void_round,
--       verify_kiosk, open_kiosk_round, settle_kiosk_round,
--       request_otp_code, verify_otp_code
--   * callable by a signed-in client (identity taken from auth.uid(), never from
--       arguments): get_me, claim_task, free_refill
-- The access rules for all of them are stated once in the Grants section.

-- --------------------------------------------------------------------------- economy --

-- Payout multiplier for the wins BEFORE this round: 0 -> 1x, 1 -> 1.5x, 2 -> 2x, 3+ -> 3x.
create function public.combo_mult(p_streak int)
returns numeric language sql immutable as $$
  select (array[1, 1.5, 2, 3]::numeric[])[least(greatest(p_streak, 0), 3) + 1];
$$;

create function public.stake_for(p_lever int)
returns int language sql immutable as $$
  select 100 * p_lever;
$$;

-- --------------------------------------------------------------------------- players --

-- Create the players row on first contact; copy the email in once it is confirmed.
create function public.ensure_player(p_player uuid)
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

create function public.get_me()
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

-- --------------------------------------------------------------------------- rounds --

-- Box rules (docs/box-plan.md, "Decisions locked"): 400 rounds per player per
-- rolling hour, and rounds.source recorded for audit only.
--
-- Self-healing for orphaned rounds: if the server dies between open and settle,
-- the round would stay 'open' forever and the unique index would lock that
-- player out with round_in_flight. A round older than 30 s can no longer be
-- honestly settled (the 5-second window is long gone), so opening a new one
-- first voids any such leftover.
create function public.open_round(p_player uuid, p_dir text, p_lever int, p_start_price numeric, p_source text default null)
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

-- round_settled carries best_streak; return it instead of a second read.
create function public.settle_round(p_round uuid, p_end_price numeric)
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
  update public.rounds set end_price = p_end_price, end_at = now(), outcome = v_outcome, delta = v_delta, mult = v_mult, status = 'settled' where id = p_round;
  return json_build_object('outcome', v_outcome, 'delta', v_delta, 'mult', v_mult, 'coins', v_coins, 'streak', v_streak,
    'record', greatest(p.record, v_coins), 'best_streak', greatest(p.best_streak, v_streak), 'start_price', r.start_price, 'end_price', p_end_price);
end $$;

-- A round whose price feed went stale: closed with no effect on coins or streak.
create function public.void_round(p_round uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.rounds set status = 'settled', outcome = 'void', end_at = now()
  where id = p_round and status = 'open';
end $$;

-- --------------------------------------------------------------------------- kiosk --

-- search_path includes `extensions` because that is where pgcrypto (crypt())
-- lives; pinning this to `public` made every kiosk call fail as unauthorized.
create function public.verify_kiosk(p_secret text)
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

-- The same orphan-round self-healing as open_round, plus the box rule that a
-- kiosk whose streak has idled for 60 s belongs to a new visitor, who starts
-- fresh.
create function public.open_kiosk_round(p_kiosk uuid, p_dir text, p_start_price numeric, p_source text default null)
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

-- Five server-validated wins in a row claims one coupon, atomically, and resets
-- the streak. An empty pool keeps the streak and reports exhausted instead of
-- silently resetting (docs/box-plan.md): the kiosk tells the staff.
create function public.settle_kiosk_round(p_round uuid, p_end_price numeric)
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

-- --------------------------------------------------------------------------- tasks --

create function public.claim_task(p_task text)
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
  -- Serialize all claims for this player: the check below and the insert run under this lock.
  perform 1 from public.players where id = v_uid for update;

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

create function public.free_refill()
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

-- --------------------------------------------------------------------- leaderboard --

-- Public leaderboard: top 10 by peak balance, email-confirmed players only,
-- safe columns only. Runs with the function owner's rights on purpose, so it
-- can read players past RLS while exposing nothing but display_name and record.
create function public.leaderboard()
returns table (display_name text, record int, rank bigint)
language sql security definer stable set search_path = public as $$
  select display_name, record, rank() over (order by record desc, updated_at asc) as rank
  from public.players
  where email is not null
  order by record desc, updated_at asc
  limit 10;
$$;

-- -------------------------------------------------------------------------- otp codes --

-- Generates an 8-digit code, stores only its hash, returns the plain code once so the caller
-- (server/otp.js) can mail it or, in dev, capture it in dev_otps.
create function public.request_otp_code(p_player uuid, p_email text)
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
create function public.verify_otp_code(p_player uuid, p_email text, p_code text)
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

-- ---------------------------------------------------------------------------- grants --
--
-- Every access rule, stated once, against the default grants the compatibility
-- layer above set up. (RLS with no policy already denies client reads and
-- writes; revoking removes any doubt.)

-- No client writes, anywhere.
revoke insert, update, delete, truncate, references, trigger
  on public.players, public.rounds, public.tasks, public.task_claims, public.kiosks, public.coupons
  from anon, authenticated;

-- kiosks and coupons: not even readable by clients. Service role only.
revoke select on public.kiosks, public.coupons from anon, authenticated;

-- dev_otps and otp_codes: service role only.
revoke all on public.dev_otps, public.otp_codes from public, anon, authenticated;

-- Client-callable, identity from the JWT (set per transaction by the server).
revoke execute on function public.get_me(), public.claim_task(text), public.free_refill() from public, anon;
grant execute on function public.get_me(), public.claim_task(text), public.free_refill() to authenticated;

-- Any visitor may read the top 10; no other role besides the two client roles
-- gets it.
revoke execute on function public.leaderboard() from public;
grant execute on function public.leaderboard() to anon, authenticated;

-- Service-role only: a client holding the anon key must not be able to call these.
revoke execute on function
  public.ensure_player(uuid),
  public.open_round(uuid, text, int, numeric, text),
  public.settle_round(uuid, numeric),
  public.void_round(uuid),
  public.verify_kiosk(text),
  public.open_kiosk_round(uuid, text, numeric, text),
  public.settle_kiosk_round(uuid, numeric),
  public.request_otp_code(uuid, text),
  public.verify_otp_code(uuid, text, text)
from public, anon, authenticated;
