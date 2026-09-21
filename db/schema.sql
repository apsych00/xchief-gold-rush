-- xChief Gold Rush: the complete box database schema, in one file.
--
-- This is the entire database that migrations 0000..0011 used to add up to,
-- written as if designed in one pass: each table once with its final columns,
-- each function once with its final body and signature, each grant and revoke
-- stated once, at the end. Apply this file once to a fresh PostgreSQL 16, then
-- db/seed.sql. server/migrate.mjs and db/run-tests.sh do exactly that.
--
-- This file is ONLY what a brand-new database gets. Production and every dev
-- database already exist, and server/migrate.mjs never re-runs this file
-- against them (recorded once in public.schema_migrations, then skipped
-- forever) - so editing it alone changes nothing anywhere but a database that
-- has not been created yet. A change here needs a matching file added under
-- db/migrations/ that carries an already-running database to the same state.
-- See db/migrations/README.md before you change anything below.
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

-- Physical or browser devices (docs/tickets/b5-device-identity.md, ticket B5). One row per
-- opaque device token a web client holds in localStorage - not tied to any one player, since
-- signing out keeps the device token and the next anonymous player picks it back up.
-- last_seen_at and first_ip are updated on every auth (server/index.js); ua only on first
-- sight, since a device's user agent does not change visit to visit the way its IP might.
create table public.devices (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  first_ip inet,
  ua text
);

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
  -- Set once, at creation, from the device token the socket presented (ticket B5): never
  -- overwritten on a later auth, so a player's device stays whichever one first created them.
  -- Null for a player whose first auth carried no device token (an old client, or storage
  -- unavailable) - such a player is its own device of one (db/tests/80_device_identity.sql).
  device_id uuid references public.devices (id),
  -- Session policy (docs/layers.md C3a): the player token carries this value, and verifyToken
  -- (server/index.js) requires an exact match. revoke_player_sessions() below bumps it, which
  -- is the only way it ever changes - every token issued before the bump stops verifying.
  token_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The campaign runs as a series of tournaments, not one long contest (docs/tasks-marketing-lead.md
-- A3, ticket B1): each has its own window, prize and broker bonus, adjusted only by SQL
-- (docs/box-deploy.md "Daily habits") - never a code change or a restart. No two tournaments'
-- windows may overlap, enforced here rather than trusted to whoever runs the next insert.
create table public.tournaments (
  id text primary key,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  prize_title text not null,
  prize_image text not null,
  broker_bonus text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  exclude using gist (tstzrange(starts_at, ends_at) with &&)
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
  -- The tournament running at this round's end_at, set by settle_round from now() (ticket B1);
  -- null when no tournament is running, so the round counts for nothing. Kiosk rounds never get
  -- one - a kiosk has no email and is never ranked, so settle_kiosk_round does not set it.
  tournament_id text references public.tournaments (id),
  check (player_id is not null or kiosk_id is not null)
);

-- A player's peak balance reached inside one tournament (ticket B1) - separate from
-- players.record, which stays the all-time peak across every tournament and none. Upserted by
-- settle_round whenever a settled round's resulting coins exceed the stored record.
create table public.tournament_scores (
  tournament_id text not null references public.tournaments (id),
  player_id uuid not null references public.players (id) on delete cascade,
  record int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tournament_id, player_id)
);

create index tournament_scores_board on public.tournament_scores (tournament_id, record desc, updated_at asc);

-- Who actually won a tournament, frozen at the moment its window closed.
--
-- The board itself is not an answer to that question. It is a live view over tournament_scores,
-- and those rows keep moving: a player's balance carries into the next tournament, so reading a
-- closed tournament's standings later is reading whatever the table says now, with nothing
-- marking the result as the one the prize was owed against. Week 1 ended with a $3,000 prize and
-- no record at all of who took it.
--
-- One row per prize-winning place, written once by settle_tournaments() and never updated.
-- record is copied rather than joined so the result stands on its own even if the score table
-- moves underneath it. player_id rather than an email: who to pay is a lookup, and copying the
-- address here would put a second raw copy of it outside the masking the leaderboard exists to
-- enforce.
--
-- rank comes from the same ranking the board uses, so a tie for first is recorded as the board
-- showed it: two rows at rank 1 and no rank 2. That means a tournament can have more than three
-- rows, which is the honest answer rather than an arbitrary tiebreak invented at payout time.
create table public.tournament_results (
  tournament_id text not null references public.tournaments (id),
  player_id uuid not null references public.players (id) on delete cascade,
  rank int not null,
  record int not null,
  settled_at timestamptz not null default now(),
  primary key (tournament_id, player_id)
);

create index tournament_results_rank on public.tournament_results (tournament_id, rank);

-- Badge tiers (ticket B3, docs/tasks-marketing-lead.md A3): the rule that assigns a tier to a
-- leaderboard rank, stored with the rank rather than the player - a player's tier changes as
-- other players' scores move past them, so there is nothing to store on public.players. Ranges
-- are inclusive; max_rank null means "and everyone below" (the player tier, 101+).
create table public.badge_tiers (
  tier text primary key,
  title text not null,
  min_rank int not null,
  max_rank int,
  icon text not null,
  sort int not null,
  check (max_rank is null or max_rank >= min_rank)
);

insert into public.badge_tiers (tier, title, min_rank, max_rank, icon, sort) values
  ('gold', 'Gold', 1, 1, '/badges/gold.svg', 1),
  ('silver', 'Silver', 2, 2, '/badges/silver.svg', 2),
  ('bronze', 'Bronze', 3, 3, '/badges/bronze.svg', 3),
  ('top10', 'Top 10', 4, 10, '/badges/top10.svg', 4),
  ('top100', 'Top 100', 11, 100, '/badges/top100.svg', 5),
  ('player', 'Player', 101, null, '/badges/player.svg', 6)
on conflict (tier) do update set
  title = excluded.title, min_rank = excluded.min_rank, max_rank = excluded.max_rank,
  icon = excluded.icon, sort = excluded.sort;

-- Task definitions (docs/layers.md C5): id, title and reward are the server's own, never
-- duplicated as numbers in src/ - get_tasks() below is what the client's tasks screen renders
-- from. title is plain English; the client's own i18n (src/i18n.js) still owns the localized
-- copy keyed by id, the same way it already does for every other piece of task copy.
-- kind (ticket B6+B7+B9, docs/tickets/b6-b7-b9-rewards.md decision 1) drives which release path a
-- task takes and what the client renders: 'video' (B6, progress-reported, released by the server
-- at 90%), 'redirect' (B7, task_start/task_return window; signup is a redirect task with a
-- persisted 1-hour window and the broker registration URL), 'email' (B9, released by
-- verify_otp_code on the socket that verified), 'instagram' (K3, released by verify_instagram
-- once the server proves the follow through BoxAPI), 'manual' (the
-- only kind claim_task still accepts from the client - none seeded, kept for future use). url is
-- the redirect destination; null for every other kind.
create table public.tasks (
  id text primary key,
  title text not null,
  reward int not null,
  repeat_ms bigint, -- null = one-time
  requires_email boolean not null default false,
  kind text not null default 'manual'
    check (kind in ('video', 'youtube', 'redirect', 'email', 'signup', 'instagram', 'manual')),
  url text
);

create table public.task_claims (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players (id) on delete cascade,
  task_id text not null references public.tasks (id),
  claimed_at timestamptz not null default now(),
  reward int not null,
  -- The claiming player's own device_id at claim time (ticket B5), null when they have none.
  -- Denormalized off players.device_id so the once-per-device check and its unique index below
  -- do not need to join players for every claim attempt.
  device_id uuid references public.devices (id),
  -- The IP the claim came from, when the server knew it (ticket B13). Null for rows created
  -- before this column existed or for calls made without setting app.client_ip.
  claimed_ip inet
);

-- Video watch progress (ticket B6, docs/tickets/b6-b7-b9-rewards.md decision 2): the client
-- reports {seconds, duration} at most every 5 s while the video plays and once on ended;
-- report_video_progress() below upserts this row and releases the task's reward itself once
-- seconds_watched crosses 90% of duration. updated_at is the anchor the too-fast check reads -
-- "since the last report", not since started_at.
create table public.video_progress (
  player_id uuid not null references public.players (id) on delete cascade,
  task_id text not null references public.tasks (id),
  seconds_watched int not null default 0,
  duration int not null,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (player_id, task_id)
);

-- Redirect-and-return visits (ticket B7, docs/tickets/b6-b7-b9-rewards.md decision 3): task_start
-- upserts started_at and clears returned_at; task_return checks the 5 s window against
-- started_at and, once past it, releases the reward and stamps returned_at. One row per
-- (player, task) is enough for the lenient B7 rule (one visit per task per device); B13 hardens.
create table public.task_visits (
  player_id uuid not null references public.players (id) on delete cascade,
  task_id text not null references public.tasks (id),
  started_at timestamptz not null default now(),
  returned_at timestamptz,
  primary key (player_id, task_id)
);

-- Instagram follow reward (ticket K3, replacing B8's OAuth model): one row per player, holding
-- the handle they entered before being sent to Instagram to follow. verified_at is null until
-- the server proves the follow through the BoxAPI data API (server/instagram.js); handle is
-- unique so one handle can be claimed by one player only. device_id records the player's device
-- at start time. The reward itself is still granted through release_task_reward, so the
-- once-per-device/email guards apply unchanged.
-- check_attempts counts genuine BoxAPI verification attempts (ticket K3 second-try grant): the
-- server bumps it once per real read that ran past the per-player check window, and on the second
-- or later attempt grants the reward even when the read could not confirm the follow (freshness
-- lag, a private player account, or a follow sitting past the page cap). It is an
-- intentional UX-over-strictness policy - the server still decides and releases; the client never
-- asserts its own outcome.
create table public.instagram_accounts (
  player_id uuid primary key references public.players (id) on delete cascade,
  handle text not null unique,
  device_id uuid references public.devices (id),
  verified_at timestamptz,
  check_attempts int not null default 0,
  created_at timestamptz not null default now()
);

-- The $100 codes. Claimed atomically, once each.
-- 'reserved' (ticket C9, docs/tickets/c9-qr-claim.md decision 2): a coupon a 5th win just
-- earned sits here from settle_kiosk_round until claim_prize() actually claims it (or the
-- sweep releases it back to 'available' after its claim_links row expires unclaimed) -
-- claimed_by_kiosk and claimed_at are set to the reserving kiosk at reservation time, but
-- claimed_at is only ever really "claimed" once claim_prize() overwrites it.
create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null default 'available' check (status in ('available', 'reserved', 'claimed')),
  claimed_by_kiosk uuid references public.kiosks (id),
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Server-owned tunables a running box can change with one SQL update, no restart (ticket C9
-- decision 1): kiosk_streak_target is mirrored from the KIOSK_STREAK_TARGET env var at boot
-- when that var is set (server/index.js), then lives here until someone updates it directly.
-- (table created below with the safe-mode tunables, ticket S18; one row per key, value text)

-- One-time QR claim links for a kiosk's $100 prize coupon (ticket C9, docs/tickets/c9-qr-claim.md
-- decision 2). A coupon is reserved, not claimed, the moment a visitor's Nth win earns it;
-- claim_prize() is what actually claims it, once, when the visitor enters an email on the
-- /claim/<token> page the QR points at. expired_at is set by the 60 s sweep (server/kiosk.js)
-- once a reserved coupon's link goes 30 days unclaimed, which releases the coupon back to
-- 'available' - the link row itself stays, kept for the audit rather than deleted.
create table public.claim_links (
  token text primary key,
  coupon_id uuid not null unique references public.coupons (id),
  kiosk_id uuid not null references public.kiosks (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  email text,
  claimed_at timestamptz,
  claimed_ip inet,
  expired_at timestamptz
);

create index claim_links_expiry on public.claim_links (expires_at)
  where claimed_at is null and expired_at is null;

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

-- Small server-wide operator state, mirrored from memory so it survives a restart (ticket S18,
-- safe mode): server/safemode.js holds the live level in memory and polls this table every 5 s
-- for a value scripts/safe-mode.mjs wrote directly, writing it back itself whenever its own
-- automatic escalation state machine changes level. One row per key, value an opaque string (a
-- JSON blob for the 'safe_mode' key: {level, reason, at}) - never a client table, treated like
-- dev_otps and otp_codes below (service role only).
create table public.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
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
-- Per-player per-task idempotency on every release path (ticket B13): the atomic backstop
-- that makes concurrent release_task_reward / claim_task calls idempotent. A duplicate insert
-- becomes an already_claimed outcome instead of a double credit.
create unique index uniq_task_claim_per_player_task on public.task_claims (player_id, task_id);
-- Once per device per task (ticket B5, docs/tickets/b5-device-identity.md decision 4): the
-- atomic backstop claim_task relies on (catching unique_violation) so two concurrent claims
-- from the same device can never both succeed. Partial on device_id is not null so a player
-- with no device token (an old client) is never cross-blocked - see that decision's own note.
create unique index uniq_task_claim_per_device on public.task_claims (task_id, device_id)
  where device_id is not null;
-- Once per device (ticket B5 decision 4) for free_refill, which has no task_claims row to key
-- a partial index off - free_refill_used lives directly on players. Mirrors
-- uniq_task_claim_per_device's role for claim_task: free_refill catches unique_violation on the
-- same update that sets the flag, so two concurrent free_refill calls from two different
-- players sharing a device can never both succeed.
create unique index uniq_free_refill_per_device on public.players (device_id)
  where free_refill_used and device_id is not null;
create index coupons_available on public.coupons (created_at) where status = 'available';
create index dev_otps_email_created on public.dev_otps (email, created_at desc);
create index otp_codes_email_created on public.otp_codes (email, created_at desc);
create index devices_last_seen on public.devices (last_seen_at); -- /status devices24h (D1)
create index video_progress_updated on public.video_progress (updated_at);
create index task_visits_started on public.task_visits (started_at);

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
alter table public.settings enable row level security;
alter table public.devices enable row level security;
alter table public.tournaments enable row level security;
alter table public.tournament_scores enable row level security;
alter table public.tournament_results enable row level security;
alter table public.claim_links enable row level security;
alter table public.badge_tiers enable row level security;
alter table public.video_progress enable row level security;
alter table public.task_visits enable row level security;
alter table public.instagram_accounts enable row level security;

create policy players_select_own on public.players
  for select to authenticated using (id = auth.uid());

create policy rounds_select_own on public.rounds
  for select to authenticated using (player_id = auth.uid());

create policy task_claims_select_own on public.task_claims
  for select to authenticated using (player_id = auth.uid());

create policy tasks_select_all on public.tasks
  for select to anon, authenticated using (true);

-- kiosks, coupons, dev_otps, otp_codes, devices, tournaments, tournament_scores, settings,
-- claim_links, badge_tiers, video_progress and task_visits deliberately have NO client policy: service-role tables (devices per
-- ticket B5 decision 5 - "nothing identifies a device to other players"; a player's own device_id
-- rides on get_me() instead). claim_links is read/written only through claim_prize() (ticket C9) -
-- a visitor's claim proof is the token itself, not a client role.
-- The public board, the tournament header and the badge legend are exposed through the SECURITY
-- DEFINER functions public.leaderboard(), public.current_tournament() and public.badge_legend()
-- below, not a view: Supabase's linter flags SECURITY DEFINER views, and a function keeps the same
-- access model (anonymous visitors can read the board, the tournament dates/prize and the badge
-- legend, nothing else about
-- players or other tournaments' internals).

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

-- A tunable in public.settings (ticket C9 decision 1), or p_default when no row for p_key
-- exists yet - a running box can change one with a plain SQL update, no restart, no migration.
create function public.get_setting_int(p_key text, p_default int)
returns int language sql stable as $$
  select coalesce((select value::int from public.settings where key = p_key), p_default);
$$;

-- ---------------------------------------------------------------------------- tournaments --

-- The tournament whose window contains this instant, or no row when none is running (ticket
-- B1). tstzrange defaults to '[)' - inclusive start, exclusive end - so a tournament ending
-- exactly when the next one starts hands off cleanly with no gap and no double-count.
create function public.current_tournament()
returns public.tournaments
language sql stable as $$
  select * from public.tournaments where tstzrange(starts_at, ends_at) @> now() limit 1;
$$;

-- ------------------------------------------------------------------------------- badges --

-- The tier whose [min_rank, max_rank] range contains p_rank (ticket B3): security definer so
-- it still resolves correctly when called from inside another security definer function
-- (public.leaderboard(), public.my_rank()) even though badge_tiers itself carries RLS with no
-- client policy - see that table's own comment.
create function public.tier_for_rank(p_rank bigint)
returns text language sql stable security definer set search_path = public as $$
  select tier from public.badge_tiers
  where p_rank >= min_rank and (max_rank is null or p_rank <= max_rank)
  order by min_rank
  limit 1;
$$;

-- The tier legend, sort order (ticket B3, docs/tasks-marketing-lead.md A3): the client renders
-- this once per leaderboard request, never on the unsolicited live push (server/index.js).
create function public.badge_legend()
returns table (tier text, title text, min_rank int, max_rank int, icon text, sort int)
language sql security definer stable set search_path = public as $$
  select tier, title, min_rank, max_rank, icon, sort from public.badge_tiers order by sort;
$$;

-- ---------------------------------------------------------------------------- masking --

-- The masked form of an email shown to anyone but its owner (docs/layers.md C3, C4;
-- ticket K5). Computed once here and reused for get_me()'s `display`, leaderboard()'s row
-- `display`, and claim_prize's `email_masked`, so the client never applies its own masking
-- logic and a raw address never leaves the server.
--
-- Rule (do not redesign):
--   * Split at the last `@`. Local part length n:
--       n <= 2     -> first char + `***`
--       3..5       -> first char + `***` + last char
--       6..9       -> first 2 chars + `****` + last 2 chars
--       n >= 10    -> first 3 chars + `*****` + last 3 chars
--   * Domain: shown in full when it is one of the twenty most common consumer domains
--     (gmail.com, yahoo.com, outlook.com, hotmail.com, icloud.com, proton.me,
--     protonmail.com, live.com, msn.com, aol.com, mail.com, yandex.com, yandex.ru,
--     mail.ru, gmx.com, zoho.com, me.com, ymail.com, googlemail.com, hey.com).
--     Otherwise the domain's first label is masked to its first char + `**` and the rest
--     of the domain is kept (`acme-corp.co` -> `a**.co`).
create function public.mask_email(p_email text)
returns text language sql immutable as $$
  select case
    when p_email is null or position('@' in p_email) = 0 then null
    else
      (case
        when length(local) <= 2 then left(local, 1) || '***'
        when length(local) between 3 and 5 then left(local, 1) || '***' || right(local, 1)
        when length(local) between 6 and 9 then left(local, 2) || '****' || right(local, 2)
        else left(local, 3) || '*****' || right(local, 3)
      end)
      || '@'
      || case
        when lower(domain) = any (array[
          'gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com',
          'proton.me','protonmail.com','live.com','msn.com','aol.com',
          'mail.com','yandex.com','yandex.ru','mail.ru','gmx.com',
          'zoho.com','me.com','ymail.com','googlemail.com','hey.com'
        ]) then domain
        when strpos(domain, '.') > 0
          then left(label, 1) || '**' || substr(domain, length(label) + 1)
        else left(label, 1) || '**'
      end
  end
from (
  select
    (regexp_match(p_email, '^(.+)@([^@]+)$'))[1] as local,
    (regexp_match(p_email, '^(.+)@([^@]+)$'))[2] as domain
) d,
lateral (select split_part(domain, '.', 1) as label) l
$$;

-- --------------------------------------------------------------------------- players --

-- Create the players row on first contact; copy the email in once it is confirmed. p_device
-- (ticket B5) is only ever applied on the INSERT branch: a player's device_id is set once, at
-- creation, from the device token their first socket presented - a later call for the same
-- player (get_me, claim_task, free_refill all call this defensively) never overwrites it, even
-- if it passes no device or a different one.
create function public.ensure_player(p_player uuid, p_device uuid default null)
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
  insert into public.players (id, email, display_name, device_id)
  values (
    p_player,
    case when v_confirmed is not null then v_email end,
    coalesce(nullif(split_part(coalesce(v_email, ''), '@', 1), ''), 'Player'),
    p_device
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
-- device_id (ticket B5 decision 5) is this player's own only - get_me() never takes another
-- player's id as an argument, so there is no path for a client to read anyone else's.
create function public.get_me()
returns table (
  id uuid, display_name text, email text, coins int, record int, streak int, best_streak int,
  wins int, rounds int, free_refill_used boolean, token_version int, created_at timestamptz,
  updated_at timestamptz, email_verified boolean, display text, device_id uuid
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
           public.mask_email(p.email) as display,
           p.device_id
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

-- Score-desync fix: the one place that keeps a player's tournament_scores row in step with
-- players.coins. tournament_scores holds the player's peak balance reached inside the currently
-- running tournament - the number the public leaderboard and my_rank() actually rank on -
-- separately from players.record's all-time peak. Before this function existed, only
-- settle_round touched tournament_scores: every other coin-granting path (release_task_reward,
-- the email/signup grant inside verify_otp, free_refill) updated players.coins/record and
-- stopped there, so a player who verified their email or claimed a mission reward saw their own
-- balance move but never showed up - or moved - on the tournament board until they next played a
-- round. That is the real desync the client-side report traced to "the topbar": the board and
-- the balance are two different tables, and only one of the paths that can raise a balance was
-- writing to both. Every function that can change players.coins now calls this afterwards, with
-- the coins value it just wrote, so tournament_scores is never more than that one write behind
-- coins itself. A no-op when no tournament is running - a round or a reward earned outside a
-- tournament window counts for nothing on any board, same as settle_round always documented.
-- p_tournament lets settle_round pass the one tournament id it already read at the top of its
-- own call (docs/box-plan.md: the round belongs to whichever tournament is running at its own
-- end_at, read once so the whole call sees one instant) instead of this function reading
-- current_tournament() a second time and risking a different answer if a boundary falls exactly
-- between the two reads. Every other caller (release_task_reward, free_refill) has no round-
-- shaped "one instant" to pin to, so they pass null and this function resolves the currently
-- running tournament itself.
create function public.bump_tournament_score(p_player uuid, p_coins int, p_tournament text default null)
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

-- round_settled carries best_streak; return it instead of a second read.
--
-- Tournaments (ticket B1): the round belongs to whichever tournament is running at its own
-- end_at (now(), read once at the top so the whole call sees one instant), never the one
-- running when it was opened - null when no tournament is running, and the round then counts
-- for nothing on any tournament board. tournament_scores holds the player's peak balance
-- reached inside that one tournament, separately from players.record's all-time peak; bump_
-- tournament_score's own ON CONFLICT WHERE clause is what makes the upsert a no-op except when
-- this settle actually raised the record, so a plain loss inside a tournament never rewrites
-- updated_at.
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
--
-- codes_left (docs/layers.md C8) rides along on every kiosk_session-shaped reply so the
-- client can tell an empty prize pool apart from an ordinary idle kiosk without a second
-- round trip.
create function public.start_kiosk_session(p_kiosk uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  k public.kiosks%rowtype;
  v_codes_left int;
begin
  update public.kiosks
  set session_coins = 1000, streak = 0, session_state = 'playing', session_started_at = now()
  where id = p_kiosk and status = 'active'
  returning * into k;
  if not found then raise exception 'kiosk_unauthorized'; end if;
  -- D1 (docs/reports/redteam.md): void any round still open for this kiosk so a late settle
  -- (settle_kiosk_round finds status <> 'open' and raises round_not_open) can never apply its
  -- delta to the fresh session this statement just started, and can never drag the screen back
  -- out of attract mode into a stranger's verdict.
  update public.rounds set status = 'settled', outcome = 'void', end_at = now()
  where kiosk_id = p_kiosk and status = 'open';
  select count(*) into v_codes_left from public.coupons where status = 'available';
  return json_build_object('coins', k.session_coins, 'streak', k.streak, 'state', k.session_state, 'codes_left', v_codes_left);
end $$;

-- kiosk_reset frame (Claim or Done pressed, or the idle sweep in server/kiosk.js): back to
-- attract mode. Coins and streak are cleared with it so nothing is ever owed to a walked-away
-- visitor - the next start_kiosk_session (or the idle-triggered reset inside
-- open_kiosk_round) is what actually begins their session. codes_left rides along, see
-- start_kiosk_session's comment above.
create function public.reset_kiosk_session(p_kiosk uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  k public.kiosks%rowtype;
  v_codes_left int;
begin
  update public.kiosks
  set session_coins = 1000, streak = 0, session_state = 'idle', session_started_at = now()
  where id = p_kiosk and status = 'active'
  returning * into k;
  if not found then raise exception 'kiosk_unauthorized'; end if;
  -- D1 (docs/reports/redteam.md): void any round still open for this kiosk in the same
  -- statement, so a verdict that lands after this reset finds nothing to settle (round_not_open)
  -- rather than re-basing its delta onto the next visitor's fresh pot and pulling the screen
  -- back out of attract mode.
  update public.rounds set status = 'settled', outcome = 'void', end_at = now()
  where kiosk_id = p_kiosk and status = 'open';
  select count(*) into v_codes_left from public.coupons where status = 'available';
  return json_build_object('coins', k.session_coins, 'streak', k.streak, 'state', k.session_state, 'codes_left', v_codes_left);
end $$;

-- Open kiosk route (ticket K1): provision a kiosk on demand for the exhibition. The raw secret
-- is returned once to the caller and never stored; only its bcrypt hash lives in the row. The
-- label starts with 'open-' so operators can tell auto-provisioned kiosks apart from seeded
-- ones. p_max caps the total number of active open kiosks; exceeding it raises 'kiosk_cap'.
create function public.create_open_kiosk(p_max int default 50)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_secret text;
  v_id uuid;
  v_label text;
  v_suffix text;
  v_count int;
begin
  select count(*)::int into v_count
    from public.kiosks
    where status = 'active' and label like 'open-%';
  if v_count >= p_max then raise exception 'kiosk_cap'; end if;

  -- 32 base64url chars from 24 random bytes, same as the claim-link token (ticket C9).
  v_secret := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
  -- 4 base64url chars from 3 random bytes for the label suffix.
  v_suffix := translate(encode(extensions.gen_random_bytes(3), 'base64'), '+/', '-_');
  v_label := 'open-' || to_char(now(), 'YYYYMMDD') || '-' || v_suffix;

  insert into public.kiosks (label, secret_hash)
  values (v_label, extensions.crypt(v_secret, extensions.gen_salt('bf')))
  returning id into v_id;

  return json_build_object('id', v_id, 'secret', v_secret, 'label', v_label);
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
--
-- An empty prize pool is a product state, not an edge case (docs/layers.md C8): no new round
-- opens at all while no coupon is available - checked once the session itself is known playable
-- (after the idle-triggered reset settles what "the session" even means, and after a genuinely
-- terminal won/broke session has already been refused its own more specific session_over) so a
-- kiosk cannot grind toward a 5th win it could never actually be paid for. A round that was
-- already open when the pool ran dry is unaffected - it keeps running and settle_kiosk_round
-- keeps its own exhausted handling below.
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

  if (select count(*) from public.coupons where status = 'available') = 0 then
    raise exception 'coupons_exhausted';
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

-- Applies the same economy as settle_round to the kiosk's session_coins, then N (public.settings
-- 'kiosk_streak_target', ticket C9 decision 1) server-validated wins in a row RESERVES one
-- coupon, atomically, opens its one-time claim_links row, and resets the streak - the code
-- itself is never in this function's own result (decision 2: claim_prize() is the only place
-- that ever reads a coupon's code back out). An empty pool keeps the streak and reports
-- exhausted instead of silently resetting (docs/box-plan.md): the kiosk tells the staff, and the
-- session keeps playing. A coupon actually reserved ends the session ('won'); otherwise dropping
-- under 100 coins ends it ('broke') - both are terminal until the next kiosk_reset or idle
-- timeout.
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
  v_target int;
  v_coupon_id uuid;
  v_token text;
  v_claim_expires_at timestamptz;
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
    v_target := public.get_setting_int('kiosk_streak_target', 3);
    if v_streak >= v_target then
      update public.coupons set status = 'reserved', claimed_by_kiosk = k.id
      where id = (
        select id from public.coupons where status = 'available'
        order by created_at limit 1 for update skip locked
      )
      returning id into v_coupon_id;
      if v_coupon_id is null then
        -- pool empty: keep the streak so the visitor is not robbed; the kiosk tells the staff
        v_exhausted := true;
        raise warning 'coupons_exhausted: kiosk % reached a %-win streak with no codes left', k.id, v_target;
      else
        -- 32 base64url characters from 24 random bytes (ticket C9 decision 2): 24 bytes encodes
        -- to exactly 32 base64 characters with no padding, so translate() alone (+/ -> -_) is
        -- enough - there is never a trailing '=' to strip.
        v_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
        v_claim_expires_at := now() + interval '30 days';
        -- coupon_id is unique on this table (one row is this coupon's whole claim history, ticket
        -- C9 decision 2): a coupon the sweep already released once carries an old, expired row
        -- here already, so a later win on the very same coupon reopens that same row for its new
        -- cycle instead of colliding with it - the prior cycle's own email/claimed_at/expired_at
        -- are cleared, since they belong to the visitor who let the earlier link lapse, not this
        -- one.
        insert into public.claim_links (token, coupon_id, kiosk_id, expires_at)
        values (v_token, v_coupon_id, k.id, v_claim_expires_at)
        on conflict (coupon_id) do update set
          token = excluded.token, kiosk_id = excluded.kiosk_id, created_at = now(),
          expires_at = excluded.expires_at, email = null, claimed_at = null, claimed_ip = null, expired_at = null;
        v_streak := 0;
      end if;
    end if;
  elsif v_outcome = 'lose' then
    v_delta := -r.stake;
    v_coins := greatest(0, k.session_coins - r.stake);
    v_streak := 0;
  end if;

  if v_token is not null then
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
    'claim_token', v_token, 'claim_expires_at', v_claim_expires_at, 'coupons_exhausted', v_exhausted, 'state', v_state,
    'start_price', r.start_price, 'end_price', p_end_price);
end $$;

-- ------------------------------------------------------------------------ prize claim links --

-- One-time claim (ticket C9, docs/tickets/c9-qr-claim.md decision 4). Called directly with
-- call() like verify_kiosk: the token itself is the caller's proof, there is no player session
-- to set app.player_id for. p_email is validated by the caller (server/index.js, the same
-- EMAIL_RE every other email entry point uses) before this ever runs.
create function public.claim_prize(p_token text, p_email text, p_ip inet)
returns json language plpgsql security definer set search_path = public as $$
declare
  cl public.claim_links%rowtype;
  v_code text;
begin
  -- Distinct, unambiguous exception text (not the bare 'invalid'/'expired' the wire contract
  -- shows the client): mapError (server/ledger.js) matches by substring, and a raw Postgres
  -- error can legitimately contain the word "invalid" (e.g. "invalid input syntax") - D9's own
  -- regression (docs/reports/redteam.md) is exactly a raw SQLSTATE leaking past that matcher.
  -- server/index.js translates these to the ticket's public state names.
  select * into cl from public.claim_links where token = p_token for update;
  if not found then raise exception 'claim_invalid'; end if;
  if cl.claimed_at is not null then raise exception 'already_claimed'; end if;
  if cl.expired_at is not null or cl.expires_at <= now() then raise exception 'claim_link_expired'; end if;

  update public.claim_links set claimed_at = now(), email = p_email, claimed_ip = p_ip
  where token = p_token;

  update public.coupons set status = 'claimed', claimed_at = now()
  where id = cl.coupon_id
  returning code into v_code;

  return json_build_object('code', v_code);
end $$;

-- Freeze the podium of every tournament that has closed and has no result recorded yet, and
-- return how many rows were written. Called by the 60 s sweep (server/kiosk.js), so the podium
-- is captured within a minute of the handoff rather than whenever someone remembers to look.
--
-- Deliberately not driven by the handoff itself: there is no moment in the code where a
-- tournament "ends" - the current one is simply whichever window contains now(), so the rollover
-- is an absence of an event. A sweep that asks "is there a closed tournament nobody has settled"
-- needs no such event, survives the server being down at the exact boundary, and settles a
-- backlog of them if it was down for a week.
--
-- Idempotent by construction: the NOT EXISTS makes a tournament with any result row invisible to
-- this, and the ON CONFLICT covers two sweeps racing on the same instant. Once written, a result
-- is never revised - that is the whole point of recording it.
--
-- Only players with an email are ranked, matching public.leaderboard() exactly: the podium has
-- to be the board the players themselves saw, not a different ranking computed later.
create function public.settle_tournaments()
returns int language plpgsql security definer set search_path = public as $$
declare
  v_written int := 0;
  v_rows int;
  t record;
begin
  for t in
    select id from public.tournaments
    where ends_at <= now()
      and not exists (select 1 from public.tournament_results r where r.tournament_id = id)
    order by ends_at
  loop
    insert into public.tournament_results (tournament_id, player_id, rank, record)
    select t.id, ranked.player_id, ranked.rank, ranked.record
    from (
      select ts.player_id, ts.record,
        rank() over (order by ts.record desc, ts.updated_at asc) as rank
      from public.tournament_scores ts
      join public.players p on p.id = ts.player_id
      where ts.tournament_id = t.id and p.email is not null
    ) ranked
    where ranked.rank <= 3
    on conflict (tournament_id, player_id) do nothing;
    get diagnostics v_rows = row_count;
    v_written := v_written + v_rows;
  end loop;
  return v_written;
end $$;

-- The 60 s kiosk sweep (server/kiosk.js) calls this every tick alongside its idle-session reset:
-- any claim link whose 30-day window ran out with nobody claiming it releases its coupon back to
-- 'available'. The link row itself is kept, expired_at marking it for the audit (ticket C9).
create function public.release_expired_claims()
returns int language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  with expired as (
    update public.claim_links
    set expired_at = now()
    where claimed_at is null and expired_at is null and expires_at <= now()
    returning coupon_id
  )
  update public.coupons set status = 'available'
  where id in (select coupon_id from expired);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- --------------------------------------------------------------------------- tasks --

-- Once per device OR per verified email (ticket B5, docs/tickets/b5-device-identity.md
-- decision 4), on top of the pre-existing once-per-player check: uniq_task_claim_per_device
-- (db/schema.sql, indexes section) is the atomic backstop for the device_id side, caught below
-- exactly like open_round catches round_in_flight; the email side has no such index (two
-- confirmed players can never really share an email - auth.users.email is unique - so it is
-- a plain existence check, defence in depth rather than a race anyone can hit in practice).
--
-- A player with no device token (v_device_id null) is excluded from the unique index's own
-- predicate, so they can never cross-block or be cross-blocked by device - "one device per
-- player" for old clients, per that decision.
--
-- Caveat carried into the report rather than solved here: this is a hard per-device ceiling
-- with no time dimension, so a *repeating* task (video, story) can only ever be claimed once
-- on a given device, by whichever player claims it first - not once per repeat_ms window as
-- the per-player check alone would allow. The ticket's decision does not carve out an
-- exception for repeat_ms tasks and this file does not redesign the decision to add one.
create function public.claim_task(p_task text)
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

-- Once per device OR per verified email (ticket B5 decision 4), same rule claim_task enforces:
-- the device side is atomic via uniq_free_refill_per_device (index section above) and a caught
-- unique_violation, exactly like claim_task's own device backstop; the email side is a plain
-- existence check, defence in depth rather than a race anyone can hit in practice, since
-- auth.users.email is unique so two confirmed players cannot really share one (same reasoning
-- as claim_task's email check - see that function's comment).
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

-- Task definitions plus this player's own claim state (docs/layers.md C5): reward and claimed
-- both come from here, never from client-side config, so the tasks screen can never show a
-- number the ledger did not actually grant. The `claimed` predicate mirrors claim_task's own
-- eligibility check exactly (repeat_ms null = one-time; otherwise still inside the cooldown
-- window since the last claim) so the two can never disagree. kind and url (ticket B6+B7+B9) are
-- what the client renders from - it keeps no task table of its own any more.
create function public.get_tasks()
returns table (id text, title text, reward int, claimed boolean, kind text, url text)
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
      ) as claimed,
      t.kind,
      t.url
    from public.tasks t
    order by t.reward desc, t.id;
end $$;

-- ------------------------------------------------------------------ server-released rewards --
--
-- ticket B6+B7+B9 (docs/tickets/b6-b7-b9-rewards.md): every reward below is granted from state
-- the server tracked itself, never from a client assertion of its own success.

-- Shared release path (service-role only, identity given as an argument like ensure_player):
-- the same once-per-device-or-verified-email rule claim_task enforces, but idempotent rather
-- than raising - every caller below (report_video_progress, return_task_visit, the verify_otp
-- handler) already knows whether it is allowed to grant this task and just wants "did it land",
-- not an exception to catch. Returns null, never an error, when the reward was already claimed
-- on this device or by this verified email - the caller decides what that means for its own
-- response shape.
create function public.release_task_reward(p_player uuid, p_task text)
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

-- Instagram follow reward, step 1 (ticket K3): the player enters their handle before being sent
-- to Instagram to follow. Stores the handle on the player's own row with verified_at still null;
-- the follow is proven later by the server through BoxAPI, never asserted by the client. A handle
-- already held by another player is refused (instagram_handle_taken - the unique index makes this
-- atomic under concurrent claims), and a player who already verified cannot switch to a different
-- handle (instagram_already_verified). Re-entering the same handle, verified or not, is a no-op.
create function public.start_instagram(p_player uuid, p_handle text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_existing public.instagram_accounts%rowtype;
  v_device uuid;
begin
  perform public.ensure_player(p_player);
  perform 1 from public.players where id = p_player for update;

  select device_id into v_device from public.players where id = p_player;
  select * into v_existing from public.instagram_accounts where player_id = p_player;

  if found and v_existing.verified_at is not null then
    if v_existing.handle <> p_handle then
      raise exception 'instagram_already_verified';
    end if;
    return json_build_object('handle', v_existing.handle, 'verified', true);
  end if;

  begin
    insert into public.instagram_accounts (player_id, handle, device_id)
      values (p_player, p_handle, v_device)
    on conflict (player_id) do update set handle = excluded.handle;
  exception when unique_violation then
    raise exception 'instagram_handle_taken';
  end;

  return json_build_object('handle', p_handle, 'verified', false);
end $$;

-- Instagram follow reward, step 2 (ticket K3): the server has just proven the follow through
-- BoxAPI (server/instagram.js) and now records it and releases the reward - one atomic step, so
-- the client can never wedge itself half-verified. Marks verified_at (idempotent: a second call
-- once verified releases nothing more) and returns whatever release_task_reward granted, which
-- is null when the once-per-player/device/email guards already covered it.
create function public.verify_instagram(p_player uuid, p_handle text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_release json;
begin
  perform 1 from public.players where id = p_player for update;

  update public.instagram_accounts
    set verified_at = coalesce(verified_at, now()), handle = p_handle
    where player_id = p_player;

  v_release := public.release_task_reward(p_player, 'instagram');
  return json_build_object(
    'coins', case when v_release is not null then (v_release->>'coins')::int else null end,
    'reward', case when v_release is not null then (v_release->>'reward')::int else null end
  );
end $$;

-- Instagram second-try grant bookkeeping (ticket K3): atomically increments and returns this
-- player's genuine-check-attempt count. server/index.js calls this once per real BoxAPI
-- verification (past the per-player check window) and uses the returned count to apply the
-- owner's second-try grant policy - on the second or later genuine attempt the reward is granted
-- even when the read could not confirm the follow. Returns null when no instagram row exists yet
-- (start_instagram creates it before any check, so a real check always has one).
create function public.bump_instagram_attempt(p_player uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  update public.instagram_accounts
    set check_attempts = check_attempts + 1
    where player_id = p_player
    returning check_attempts into v_count;
  return v_count;
end $$;

-- Video watch progress (ticket B6 decision 2), client-callable via auth.uid(). Progress never
-- moves backwards in storage (a rewind is a silent no-op, not an error - only the touched
-- updated_at moves) and is capped at duration + 5. The one hard rejection is a jump faster than
-- 2x the wall-clock time since the LAST REPORT (not since started_at, so the very first report
-- of a mid-video seconds value is never mistaken for a fast-forward): a client cannot claim to
-- have watched more than it could have in the time between two reports. The release threshold
-- depends on the kind: the hosted 'video' task releases at 90% of its own duration (ticket B6),
-- while a 'youtube' mission video (ticket K4 rework) releases at a fixed 30 s of validated watch -
-- "watch for 30 seconds or more to get the reward" - regardless of the clip's full length. Both
-- still require a duration of at least 10 s, so a near-zero-length "video" cannot be claimed
-- instantly, and both release through release_task_reward - never through claim_task, which
-- refuses this task's kind.
create function public.report_video_progress(p_task text, p_seconds int, p_duration int)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  t public.tasks%rowtype;
  vp public.video_progress%rowtype;
  v_elapsed numeric;
  v_capped int;
  v_release json;
begin
  if v_uid is null then raise exception 'unauthenticated'; end if;
  select * into t from public.tasks where id = p_task;
  if not found or t.kind not in ('video', 'youtube') then raise exception 'unknown_task'; end if;
  if p_duration is null or p_duration <= 0 or p_seconds is null or p_seconds < 0 then
    raise exception 'bad_progress';
  end if;

  perform public.ensure_player(v_uid);

  select * into vp from public.video_progress
    where player_id = v_uid and task_id = p_task for update;

  v_capped := least(p_seconds, p_duration + 5);

  if not found then
    insert into public.video_progress (player_id, task_id, seconds_watched, duration, started_at, updated_at)
    values (v_uid, p_task, v_capped, p_duration, now(), now());
  elsif v_capped > vp.seconds_watched then
    v_elapsed := greatest(extract(epoch from (now() - vp.updated_at)), 0.001);
    if (v_capped - vp.seconds_watched) > 2 * v_elapsed then
      raise exception 'progress_too_fast';
    end if;
    update public.video_progress set seconds_watched = v_capped, duration = p_duration, updated_at = now()
      where player_id = v_uid and task_id = p_task;
  else
    v_capped := vp.seconds_watched;
    update public.video_progress set updated_at = now() where player_id = v_uid and task_id = p_task;
  end if;

  if p_duration >= 10 and (
       (t.kind = 'youtube' and v_capped >= 30)
       or (t.kind = 'video' and v_capped >= 0.9 * p_duration)
     ) then
    v_release := public.release_task_reward(v_uid, p_task);
  end if;

  return json_build_object('seconds_watched', v_capped, 'reward', case when v_release is not null then (v_release->>'reward')::int else null end);
end $$;

-- Redirect and return (ticket B7 decision 3), client-callable via auth.uid(). task_start opens
-- the window; task_return only releases once at least 5 s of wall-clock time have actually
-- passed since it, reported as json (never a raised exception) so the "not yet, try again in
-- N ms" and "already claimed" cases can carry their own data the same way open_kiosk_round's
-- insufficient_coins case does - a raise here would undo the UPDATE in the same statement.
create function public.start_task_visit(p_task text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  t public.tasks%rowtype;
begin
  if v_uid is null then raise exception 'unauthenticated'; end if;
  select * into t from public.tasks where id = p_task;
  if not found or t.kind <> 'redirect' then raise exception 'unknown_task'; end if;

  perform public.ensure_player(v_uid);

  insert into public.task_visits (player_id, task_id, started_at, returned_at)
  values (v_uid, p_task, now(), null)
  on conflict (player_id, task_id) do update set started_at = now(), returned_at = null;

  return json_build_object('task', p_task, 'window_ms', 5000);
end $$;

create function public.return_task_visit(p_task text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  t public.tasks%rowtype;
  v_visit public.task_visits%rowtype;
  v_elapsed_ms numeric;
  v_release json;
begin
  if v_uid is null then raise exception 'unauthenticated'; end if;
  select * into t from public.tasks where id = p_task;
  if not found or t.kind <> 'redirect' then raise exception 'unknown_task'; end if;

  perform public.ensure_player(v_uid);

  select * into v_visit from public.task_visits where player_id = v_uid and task_id = p_task for update;
  if not found then
    return json_build_object('error', 'not_yet', 'retry_ms', 5000);
  end if;

  if exists (select 1 from public.task_claims where player_id = v_uid and task_id = p_task) then
    return json_build_object('error', 'already_claimed');
  end if;

  v_elapsed_ms := extract(epoch from (now() - v_visit.started_at)) * 1000;
  if v_elapsed_ms < 5000 then
    return json_build_object('error', 'not_yet', 'retry_ms', ceil(5000 - v_elapsed_ms)::int);
  end if;

  update public.task_visits set returned_at = now() where player_id = v_uid and task_id = p_task;

  v_release := public.release_task_reward(v_uid, p_task);
  if v_release is null then
    return json_build_object('error', 'already_claimed');
  end if;
  return v_release;
end $$;

-- --------------------------------------------------------------------- leaderboard --

-- Public leaderboard: one tournament's tournament_scores, email-confirmed players only, safe
-- columns only (ticket B1: the campaign is a series of tournaments, not one long contest; B2:
-- paged, 25 rows per page, each row carrying its own badge tier). p_tournament defaults to
-- whichever tournament public.current_tournament() reports; passing an explicit id (the
-- `tournament` request frame, or the `tournament` field on a `leaderboard` request,
-- server/index.js) is how a closed or upcoming tournament's own board is read back. Either
-- way, no tournament resolved (no id given and none running, or an id that names no
-- tournament) means the coalesce below is null, the tournament_id equality can never match,
-- and the result is simply empty rows - never an error. p_page is 1-based; a page past the end
-- is empty rows, same as no tournament resolved - never an error either.
-- Runs with the function owner's rights on purpose, so it can read players and
-- tournament_scores past RLS while exposing nothing but a masked email and record
-- (docs/layers.md C4: "never a raw address" - display_name is not returned any more since it
-- would defeat the point of masking).
create function public.leaderboard(p_tournament text default null, p_page int default 1)
returns table (rank bigint, display text, record int, tier text)
language sql security definer stable set search_path = public as $$
  with ranked as (
    select public.mask_email(p.email) as display, ts.record,
      rank() over (order by ts.record desc, ts.updated_at asc) as rank
    from public.tournament_scores ts
    join public.players p on p.id = ts.player_id
    where ts.tournament_id = coalesce(p_tournament, (select id from public.current_tournament()))
      and p.email is not null
  )
  select rank, display, record, public.tier_for_rank(rank) as tier
  from ranked
  order by rank
  limit 25 offset (greatest(coalesce(p_page, 1), 1) - 1) * 25;
$$;

-- The total ranked player count behind public.leaderboard(), for the client's page count
-- (server/index.js computes `pages = ceil(total / LEADERBOARD_PAGE_SIZE)`) - a separate call rather than a window
-- column on leaderboard() itself, since a page past the end would otherwise return zero rows
-- and take the total down with it.
create function public.leaderboard_total(p_tournament text default null)
returns bigint language sql security definer stable set search_path = public as $$
  select count(*) from public.tournament_scores ts
  join public.players p on p.id = ts.player_id
  where ts.tournament_id = coalesce(p_tournament, (select id from public.current_tournament()))
    and p.email is not null;
$$;

-- The caller's own row on one tournament's board (ticket B2 decision 1, closes gap G3): matched
-- by auth.uid(), never by a masked-email string comparison, so two players whose masks happen
-- to collide can never highlight each other's row. No row for a caller with no verified email
-- or no score in that tournament - not an error, just nothing returned (server/index.js's
-- ledger.myRank turns the empty result into `null`), same "resolves to nothing, never raises"
-- shape as leaderboard() itself.
create function public.my_rank(p_tournament text default null)
returns table (rank bigint, display text, record int, tier text, total bigint)
language plpgsql security definer stable set search_path = public as $$
declare
  v_tournament text;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;
  v_tournament := coalesce(p_tournament, (select id from public.current_tournament()));
  return query
    -- Column names qualified with the CTE's own alias throughout: this function's OUT
    -- parameters (rank, display, record, tier, total) shadow bare column references of the
    -- same name as PL/pgSQL variables, which read as ambiguous rather than "the CTE's column".
    with ranked as (
      select p.id as player_id, public.mask_email(p.email) as row_display, ts.record as row_record,
        rank() over (order by ts.record desc, ts.updated_at asc) as row_rank,
        count(*) over () as row_total
      from public.tournament_scores ts
      join public.players p on p.id = ts.player_id
      where ts.tournament_id = v_tournament and p.email is not null
    )
    select ranked.row_rank, ranked.row_display, ranked.row_record, public.tier_for_rank(ranked.row_rank), ranked.row_total
    from ranked
    where ranked.player_id = auth.uid();
end $$;

-- --------------------------------------------------------------------- reward audit --

-- Operator audit view for every task reward the server released (ticket B13): one row per
-- task_claims, with the player's email, the device it was claimed against, and the IP the
-- server saw at claim time. Runs with the view owner's privileges so an operator query sees
-- every row; no client policy is granted on this view.
create or replace view public.reward_audit with (security_invoker = false) as
select
  p.id as player,
  tc.device_id as device,
  p.email,
  tc.task_id as task,
  tc.reward,
  tc.claimed_at,
  tc.claimed_ip as ip
from public.task_claims tc
join public.players p on p.id = tc.player_id;

-- -------------------------------------------------------------------------- otp codes --

-- Generates a 4-digit code, stores only its hash, returns the plain code once so the caller
-- (server/otp.js) can mail it or, in dev, capture it in dev_otps. SQL cannot import
-- src/config.js's OTP_CODE_LENGTH, so this literal is the other half of that contract by hand -
-- keep both in sync, and test/integration-box/otp.test.mjs binds them by asserting the server's
-- real output matches the client constant.
create function public.request_otp_code(p_player uuid, p_email text)
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
  on public.players, public.rounds, public.tasks, public.task_claims, public.kiosks, public.coupons,
     public.tournaments, public.tournament_scores, public.settings, public.claim_links, public.badge_tiers,
     public.video_progress, public.task_visits, public.instagram_accounts
  from anon, authenticated;

-- kiosks, coupons, tournaments, tournament_scores, settings, claim_links, badge_tiers, video_progress
-- and task_visits: not even readable by clients. Service role only - the tournament header, the board
-- and the badge legend reach the client through the SECURITY DEFINER functions below, never a direct
-- table read; a claim link's own state reaches the /claim/<token> page through GET /api/claim/<token>
-- (server/index.js), never a direct table read either.
revoke select on public.kiosks, public.coupons, public.tournaments, public.tournament_scores,
  public.tournament_results,
  public.settings, public.claim_links, public.badge_tiers, public.video_progress, public.task_visits,
  public.instagram_accounts
  from anon, authenticated;

-- dev_otps, otp_codes and settings: service role only.
revoke all on public.dev_otps, public.otp_codes, public.settings from public, anon, authenticated;

-- Client-callable, identity from the JWT (set per transaction by the server). my_rank (ticket
-- B2) joins this group: it reads auth.uid() exactly like get_me, so an anonymous or
-- unauthenticated caller gets nothing from it either.
revoke execute on function
  public.get_me(), public.claim_task(text), public.free_refill(), public.get_tasks(), public.my_rank(text),
  public.report_video_progress(text, int, int), public.start_task_visit(text), public.return_task_visit(text)
from public, anon;
grant execute on function
  public.get_me(), public.claim_task(text), public.free_refill(), public.get_tasks(), public.my_rank(text),
  public.report_video_progress(text, int, int), public.start_task_visit(text), public.return_task_visit(text)
to authenticated;

-- Any visitor may read one tournament's board page (of the current tournament, or an explicit
-- one), its total row count, the tournament header and the badge legend; no other role besides
-- the two client roles gets them.
revoke execute on function public.leaderboard(text, int) from public;
grant execute on function public.leaderboard(text, int) to anon, authenticated;
revoke execute on function public.leaderboard_total(text) from public;
grant execute on function public.leaderboard_total(text) to anon, authenticated;
revoke execute on function public.current_tournament() from public;
grant execute on function public.current_tournament() to anon, authenticated;
revoke execute on function public.badge_legend() from public;
grant execute on function public.badge_legend() to anon, authenticated;

-- Service-role only: a client holding the anon key must not be able to call these.
revoke execute on function
  public.ensure_player(uuid, uuid),
  public.open_round(uuid, text, int, numeric, text),
  public.settle_round(uuid, numeric),
  public.void_round(uuid),
  public.verify_kiosk(text),
  public.start_kiosk_session(uuid),
   public.reset_kiosk_session(uuid),
   public.open_kiosk_round(uuid, text, numeric, text, int),
   public.settle_kiosk_round(uuid, numeric),
   public.create_open_kiosk(int),
  public.request_otp_code(uuid, text),
  public.verify_otp_code(uuid, text, text),
  public.revoke_player_sessions(uuid),
  public.claim_prize(text, text, inet),
  public.release_expired_claims(),
  public.get_setting_int(text, int),
  public.release_task_reward(uuid, text),
  public.start_instagram(uuid, text),
  public.verify_instagram(uuid, text),
  public.bump_instagram_attempt(uuid),
  public.bump_tournament_score(uuid, int, text)
from public, anon, authenticated;
