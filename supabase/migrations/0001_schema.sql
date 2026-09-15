-- xChief Gold Rush: core schema.
-- The server owns every outcome and every coin. Clients never write these tables directly
-- (see 0002_rls.sql); all mutations go through the functions in 0003_functions.sql.

create extension if not exists pgcrypto;

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
  created_at timestamptz not null default now()
);

-- Every round, web or kiosk. Also the audit trail: both prices and both timestamps are recorded.
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
  check (player_id is not null or kiosk_id is not null)
);

-- One round in flight per identity. This is what keeps streaks honest:
-- a second concurrent round cannot be opened to fish for a win.
create unique index uniq_open_round_per_player on public.rounds (player_id)
  where status = 'open' and player_id is not null;
create unique index uniq_open_round_per_kiosk on public.rounds (kiosk_id)
  where status = 'open' and kiosk_id is not null;
create index rounds_player_created on public.rounds (player_id, created_at desc);

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
create index task_claims_player_task on public.task_claims (player_id, task_id, claimed_at desc);

-- The $100 codes. Claimed atomically, once each.
create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null default 'available' check (status in ('available', 'claimed')),
  claimed_by_kiosk uuid references public.kiosks (id),
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create index coupons_available on public.coupons (created_at) where status = 'available';
