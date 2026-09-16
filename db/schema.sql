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
  -- Session policy (docs/layers.md C3a): the player token carries this value, and verifyToken
  -- (server/index.js) requires an exact match. revoke_player_sessions() below bumps it, which
  -- is the only way it ever changes - every token issued before the bump stops verifying.
  token_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Physical booth devices. The raw secret is never stored, only its bcrypt hash.
--
-- A kiosk runs one visitor session at a time (ticket C1, docs/layers.md): session_coins is
-- the server-owned pot for the visitor currently in front of the machine, session_state
-- tracks where that session is (idle between visitors; playing; ended by a win or by going
-- broke), and session_started_at is when the current session began. streak and
-- last_round_at already existed and keep their meaning: streak is consecutive wins within
-- the session, last_round_at drives the 60 s idle reset.
create table public.kiosks (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  secret_hash text not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  streak int not null default 0, -- consecutive server-validated wins on this kiosk
  session_coins int not null default 1000,
  session_started_at timestamptz,
  session_state text not null default 'idle' check (session_state in ('idle', 'playing', 'won', 'broke')),
  created_at timestamptz not null default now(),
  last_round_at timestamptz -- drives the 60 s idle session reset (docs/box-plan.md)
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

-- Task definitions (docs/layers.md C5): id, title and reward are the server's own, never
-- duplicated as numbers in src/ - get_tasks() below is what the client's tasks screen renders
-- from. title is plain English; the client's own i18n (src/i18n.js) still owns the localized
-- copy keyed by id, the same way it already does for every other piece of task copy.
create table public.tasks (
  id text primary key,
  title text not null,
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
--       request_otp_code, verify_otp_code, revoke_player_sessions
--   * callable by a signed-in client (identity taken from auth.uid(), never from
--       arguments): get_me, claim_task, free_refill, get_tasks
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

-- ---------------------------------------------------------------------------- masking --

-- The masked form of an email shown to anyone but its owner (docs/layers.md C3, C4;
-- product default recorded there: "masked email keeps the first and last character of the
-- local part and the full domain"). Computed once here and reused for both get_me()'s own
-- `display` and leaderboard()'s row `display`, so the client's "is this my row" check is a
-- plain string comparison, never its own masking logic.
--
-- Local part length 1-2: only the first character survives ("a" -> "a***", "ab" -> "a***") -
-- there is no room for a distinct last character. Length 3+: first and last character are
-- kept, with at least three and at most four asterisks between them ("kay" -> "k***y",
-- "kayani" -> "k****i", "kayhanazadi" -> "k****i"). The cap keeps a long address from pushing
-- the score off a leaderboard row; the true length of the local part is not revealed.
create function public.mask_email(p_email text)
returns text language sql immutable as $$
  select case
    when p_email is null or position('@' in p_email) = 0 then null
    else
      (case
        when length(split_part(p_email, '@', 1)) <= 2
          then left(split_part(p_email, '@', 1), 1) || repeat('*', 3)
        else
          left(split_part(p_email, '@', 1), 1)
          || repeat('*', least(greatest(length(split_part(p_email, '@', 1)) - 2, 3), 4))
          || right(split_part(p_email, '@', 1), 1)
      end)
      || '@' || split_part(p_email, '@', 2)
  end
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

-- Every players column, plus two computed ones the client needs (docs/layers.md C3, C4):
-- email_verified (players.email is only ever set once confirmed - see ensure_player and
-- verify_otp_code) and display, this player's own masked email for the header ("playing as
-- k****i@gmail.com") and for matching its own row on the leaderboard.
create function public.get_me()
returns table (
  id uuid, display_name text, email text, coins int, record int, streak int, best_streak int,
  wins int, rounds int, free_refill_used boolean, token_version int, created_at timestamptz,
  updated_at timestamptz, email_verified boolean, display text
) language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;
  perform public.ensure_player(auth.uid());
  return query
    select p.id, p.display_name, p.email, p.coins, p.record, p.streak, p.best_streak, p.wins,
           p.rounds, p.free_refill_used, p.token_version, p.created_at, p.updated_at,
           (p.email is not null) as email_verified,
           public.mask_email(p.email) as display
    from public.players p
    where p.id = auth.uid();
end $$;

-- Operator tool, no UI (docs/layers.md C3a, docs/box-deploy.md "Daily habits"): log a player
-- out everywhere by bumping token_version, so every token already issued for them - however
-- many browsers hold one - stops verifying on its next use. Idempotent to call more than once;
-- a player id nobody has ever played is simply a no-op update, not an error.
create function public.revoke_player_sessions(p_player uuid)
returns void language sql security definer set search_path = public as $$
  update public.players set token_version = token_version + 1, updated_at = now() where id = p_player;
$$;

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

-- Start a fresh visitor session on this kiosk: full coins, no streak, playing. Called
-- directly for the explicit `kiosk_session` bootstrap (welcome) and inline by
-- open_kiosk_round whenever a session is idle or has idled out.
create function public.start_kiosk_session(p_kiosk uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  k public.kiosks%rowtype;
begin
  update public.kiosks
  set session_coins = 1000, streak = 0, session_state = 'playing', session_started_at = now()
  where id = p_kiosk and status = 'active'
  returning * into k;
  if not found then raise exception 'kiosk_unauthorized'; end if;
  return json_build_object('coins', k.session_coins, 'streak', k.streak, 'state', k.session_state);
end $$;

-- kiosk_reset frame (Claim or Done pressed, or the idle sweep in server/kiosk.js): back to
-- attract mode. Coins and streak are cleared with it so nothing is ever owed to a walked-away
-- visitor - the next start_kiosk_session (or the idle-triggered reset inside
-- open_kiosk_round) is what actually begins their session.
create function public.reset_kiosk_session(p_kiosk uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  k public.kiosks%rowtype;
begin
  update public.kiosks
  set session_coins = 1000, streak = 0, session_state = 'idle', session_started_at = now()
  where id = p_kiosk and status = 'active'
  returning * into k;
  if not found then raise exception 'kiosk_unauthorized'; end if;
  return json_build_object('coins', k.session_coins, 'streak', k.streak, 'state', k.session_state);
end $$;

-- The same orphan-round self-healing as open_round, plus the box rule that a session that has
-- idled for 60 s, or was never started (session_state 'idle'), belongs to a new visitor: it is
-- restarted fresh before this round is considered. A session already ended (won its coupon or
-- went broke) refuses further play until it is reset - the client's win/exit modal owns that
-- moment, not another round slipping in first.
--
-- The insufficient_coins case marks the session broke and reports insufficient_coins, and both
-- must survive: a plain `raise exception` aborts the whole call, undoing the UPDATE that just
-- ran in the same statement (the same issue verify_otp_code's comment documents). So that one
-- case returns {error: 'insufficient_coins'} instead of raising; server/ledger.js's
-- openKioskRound() turns it into the same thrown-Error-with-.code shape every other case here
-- produces by raising directly.
create function public.open_kiosk_round(p_kiosk uuid, p_dir text, p_start_price numeric, p_source text default null, p_lever int default 1)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_stake int;
  k public.kiosks%rowtype;
begin
  if p_dir not in ('up', 'down') then raise exception 'bad_dir'; end if;
  if p_start_price is null or p_start_price <= 0 then raise exception 'bad_price'; end if;
  if p_lever not in (1, 2, 5) then raise exception 'bad_lever'; end if;

  select * into k from public.kiosks where id = p_kiosk and status = 'active' for update;
  if not found then raise exception 'kiosk_unauthorized'; end if;

  if k.session_state = 'idle'
     or (k.last_round_at is not null and k.last_round_at < now() - interval '60 seconds') then
    update public.kiosks
    set session_coins = 1000, streak = 0, session_state = 'playing', session_started_at = now()
    where id = p_kiosk
    returning * into k;
  end if;

  if k.session_state in ('won', 'broke') then
    raise exception 'session_over';
  end if;

  update public.kiosks set last_round_at = now() where id = p_kiosk;

  update public.rounds set status = 'settled', outcome = 'void', end_at = now()
  where kiosk_id = p_kiosk and status = 'open' and start_at < now() - interval '30 seconds';

  v_stake := public.stake_for(p_lever);
  if k.session_coins < v_stake then
    update public.kiosks set session_state = 'broke' where id = p_kiosk;
    return json_build_object('error', 'insufficient_coins');
  end if;

  begin
    insert into public.rounds (kiosk_id, dir, lever, stake, start_price, source)
    values (p_kiosk, p_dir, p_lever, v_stake, p_start_price, p_source)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'round_in_flight';
  end;
  return json_build_object('round_id', v_id, 'start_price', p_start_price);
end $$;

-- Applies the same economy as settle_round to the kiosk's session_coins, then five
-- server-validated wins in a row claims one coupon, atomically, and resets the streak. An
-- empty pool keeps the streak and reports exhausted instead of silently resetting
-- (docs/box-plan.md): the kiosk tells the staff, and the session keeps playing. A coupon
-- actually claimed ends the session ('won'); otherwise dropping under 100 coins ends it
-- ('broke') - both are terminal until the next kiosk_reset or idle timeout.
create function public.settle_kiosk_round(p_round uuid, p_end_price numeric)
returns json language plpgsql security definer set search_path = public as $$
declare
  r public.rounds%rowtype;
  k public.kiosks%rowtype;
  v_outcome text;
  v_mult numeric := 1;
  v_delta int := 0;
  v_coins int;
  v_streak int;
  v_code text;
  v_exhausted boolean := false;
  v_state text;
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

  v_coins := k.session_coins;
  v_streak := k.streak;

  if v_outcome = 'win' then
    v_mult := public.combo_mult(k.streak);
    v_delta := round(r.stake * v_mult)::int;
    v_coins := k.session_coins + v_delta;
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
    v_delta := -r.stake;
    v_coins := greatest(0, k.session_coins - r.stake);
    v_streak := 0;
  end if;

  if v_code is not null then
    v_state := 'won';
  elsif v_coins < 100 then
    v_state := 'broke';
  else
    v_state := 'playing';
  end if;

  update public.kiosks set session_coins = v_coins, streak = v_streak, session_state = v_state, last_round_at = now()
  where id = k.id;
  update public.rounds set end_price = p_end_price, end_at = now(), outcome = v_outcome, delta = v_delta, mult = v_mult, status = 'settled'
  where id = p_round;

  return json_build_object('outcome', v_outcome, 'delta', v_delta, 'mult', v_mult, 'coins', v_coins, 'streak', v_streak,
    'coupon', v_code, 'coupons_exhausted', v_exhausted, 'state', v_state,
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
  -- Two distinct reasons this refuses, so the caller can tell "you already used yours" from
  -- "you don't need it yet" (docs/layers.md C5: a second free_refill is `already_refilled`).
  if p.free_refill_used then raise exception 'already_refilled'; end if;
  if p.coins >= 100 then raise exception 'refill_unavailable'; end if;
  update public.players set
    coins = coins + 300,
    record = greatest(record, coins + 300),
    free_refill_used = true,
    updated_at = now()
  where id = v_uid
  returning coins into v_coins;
  return json_build_object('coins', v_coins, 'reward', 300);
end $$;

-- Task definitions plus this player's own claim state (docs/layers.md C5): reward and claimed
-- both come from here, never from client-side config, so the tasks screen can never show a
-- number the ledger did not actually grant. The `claimed` predicate mirrors claim_task's own
-- eligibility check exactly (repeat_ms null = one-time; otherwise still inside the cooldown
-- window since the last claim) so the two can never disagree.
create function public.get_tasks()
returns table (id text, title text, reward int, claimed boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'unauthenticated'; end if;
  perform public.ensure_player(v_uid);
  return query
    select
      t.id,
      t.title,
      t.reward,
      exists (
        select 1 from public.task_claims c
        where c.player_id = v_uid and c.task_id = t.id
          and (t.repeat_ms is null or c.claimed_at > now() - make_interval(secs => t.repeat_ms / 1000.0))
      ) as claimed
    from public.tasks t
    order by t.reward desc, t.id;
end $$;

-- --------------------------------------------------------------------- leaderboard --

-- Public leaderboard: top 10 by peak balance, email-confirmed players only,
-- safe columns only. Runs with the function owner's rights on purpose, so it
-- can read players past RLS while exposing nothing but a masked email and record
-- (docs/layers.md C4: "never a raw address" - display_name is not returned any more since it
-- would defeat the point of masking).
create function public.leaderboard()
returns table (display text, record int, rank bigint)
language sql security definer stable set search_path = public as $$
  select public.mask_email(email) as display, record, rank() over (order by record desc, updated_at asc) as rank
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
-- confirms the email on this player - unless another player already holds it confirmed, in
-- which case that IS the returning player logging back in (docs/layers.md C3a: "re-login by
-- OTP"): the code already proved they own the email, so the caller returns 'logged_in:<uuid>'
-- of the owning player instead of raising email_taken, and server/index.js switches the
-- socket's identity there. Nothing on either player row changes in that branch - no merge, no
-- delete - only the otp_codes row is marked used, same as a normal verify.
--
-- Returns text, not the boolean the spec sketch names, for a reason worth recording: a plain
-- `raise exception` aborts the whole calling statement, undoing any UPDATE made earlier in the
-- same call (verified live against this database - see the ticket 4 handoff report). So a wrong
-- guess cannot both durably increment `attempts` AND raise in the same call; the increment would
-- never survive to the next guess and too_many_attempts could never be reached. Only the one
-- outcome with nothing left to lose (no live code at all) still raises, exactly as every other
-- function in this file does. A wrong guess, and the re-login case, instead return a status
-- text so their updates commit normally; ledger.js turns the remaining failure text into the
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
revoke execute on function public.get_me(), public.claim_task(text), public.free_refill(), public.get_tasks() from public, anon;
grant execute on function public.get_me(), public.claim_task(text), public.free_refill(), public.get_tasks() to authenticated;

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
  public.start_kiosk_session(uuid),
  public.reset_kiosk_session(uuid),
  public.open_kiosk_round(uuid, text, numeric, text, int),
  public.settle_kiosk_round(uuid, numeric),
  public.request_otp_code(uuid, text),
  public.verify_otp_code(uuid, text, text),
  public.revoke_player_sessions(uuid)
from public, anon, authenticated;
