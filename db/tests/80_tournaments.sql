-- Invariant: tournaments are data, not code (ticket B1, docs/tasks-marketing-lead.md A3).
-- current_tournament() resolves the window containing now() with the tstzrange default
-- '[)' semantics (inclusive start, exclusive end, so back-to-back tournaments hand off with no
-- gap and no double-count); no two tournaments' windows may overlap, refused by the database
-- itself; settle_round stamps every settled round with whichever tournament is running at its
-- own end_at, and upserts tournament_scores with the player's peak balance inside that one
-- tournament - separate from players.record, which stays the all-time peak.
--
-- This file clears the seed tournaments inside its own transaction (rolled back at the end,
-- like every other suite here) so "no tournament is running" can be tested deterministically
-- instead of depending on today's date falling outside db/seed.sql's real campaign windows.
begin;

select plan(12);

-- ---- tstzrange boundary semantics: inclusive start, exclusive end ------------------------
select ok(
  tstzrange('2026-01-01T00:00:00+04'::timestamptz, '2026-01-02T00:00:00+04'::timestamptz)
    @> '2026-01-01T00:00:00+04'::timestamptz,
  'a tournament''s own start instant falls inside its window (inclusive start)'
);
select ok(
  not (tstzrange('2026-01-01T00:00:00+04'::timestamptz, '2026-01-02T00:00:00+04'::timestamptz)
    @> '2026-01-02T00:00:00+04'::timestamptz),
  'a tournament''s own end instant falls outside its window (exclusive end) - the next one owns it'
);

delete from public.tournaments;

-- ---- current_tournament(): none running --------------------------------------------------
select is((select id from public.current_tournament()), null, 'no tournament running: current_tournament() returns no row');

-- ---- current_tournament(): one running -----------------------------------------------------
insert into public.tournaments (id, title, starts_at, ends_at, prize_title, prize_image, broker_bonus) values
  ('tt-now', 'Now', now() - interval '1 hour', now() + interval '1 hour', 'First prize', '/prizes/now.png', 'bonus text');
select is((select id from public.current_tournament()), 'tt-now', 'a tournament whose window contains now() is resolved as current');

-- ---- overlap refused by the database, not by whoever ran the insert -----------------------
select throws_ok(
  $$insert into public.tournaments (id, title, starts_at, ends_at, prize_title, prize_image)
    values ('tt-overlap', 'Overlap', now(), now() + interval '2 hours', 'Prize', '/prizes/x.png')$$,
  '23P01',
  null,
  'inserting a tournament whose window overlaps an existing one is refused (exclusion constraint)'
);

-- A window that starts exactly when tt-now ends does not overlap it (exclusive end / inclusive
-- start hand off cleanly) and is accepted.
select lives_ok(
  $$insert into public.tournaments (id, title, starts_at, ends_at, prize_title, prize_image)
    values ('tt-next', 'Next', (select ends_at from public.tournaments where id = 'tt-now'), now() + interval '3 hours', 'Prize', '/prizes/y.png')$$,
  'a tournament starting exactly when another ends is accepted - no gap, no overlap'
);

-- ---- settle_round: tournament assignment and the per-tournament record ---------------------
select tests.create_confirmed_player('tourn-a@example.com') as player_a \gset
update public.players set coins = 1000 where id = :'player_a';

select (public.open_round(:'player_a'::uuid, 'up', 1, 100)->>'round_id')::uuid as round1 \gset
-- win at streak 0 (combo_mult 1x): coins 1000 + 100 -> 1100
select public.settle_round(:'round1'::uuid, 101) as settle1 \gset
select is(
  (select tournament_id from public.rounds where id = :'round1'::uuid),
  'tt-now',
  'a settled round is stamped with the tournament running at its own end_at'
);
select is(
  (select record from public.tournament_scores where tournament_id = 'tt-now' and player_id = :'player_a'::uuid),
  1100,
  'tournament_scores holds the player''s peak balance reached inside this one tournament'
);

-- A loss straight after does not lower the stored per-tournament record (only a new peak
-- upserts it, per settle_round's ON CONFLICT ... WHERE clause).
select (public.open_round(:'player_a'::uuid, 'up', 1, 100)->>'round_id')::uuid as round2 \gset
-- loss: coins 1100 - 100 -> 1000
select public.settle_round(:'round2'::uuid, 99) as settle2 \gset
select is(
  (select record from public.tournament_scores where tournament_id = 'tt-now' and player_id = :'player_a'::uuid),
  1100,
  'a loss inside the tournament never lowers the stored per-tournament record'
);
select is(
  (select record from public.players where id = :'player_a'::uuid),
  1100,
  'players.record still holds the same all-time peak - separate storage, same number so far'
);

-- ---- settle_round: no tournament running means the round counts for nothing ---------------
-- Both settled rounds above reference tt-now/tt-next (rounds.tournament_id), so the
-- tournaments themselves cannot be deleted out from under them; clear the rows that reference
-- them first, same as a real campaign never deletes a tournament that already has play in it
-- (docs/box-deploy.md "Daily habits").
delete from public.tournament_scores;
delete from public.rounds;
delete from public.tournaments;
select tests.create_confirmed_player('tourn-b@example.com') as player_b \gset
update public.players set coins = 1000 where id = :'player_b';
select (public.open_round(:'player_b'::uuid, 'up', 1, 100)->>'round_id')::uuid as round3 \gset
select public.settle_round(:'round3'::uuid, 101) as settle3 \gset
select is(
  (select tournament_id from public.rounds where id = :'round3'::uuid),
  null,
  'a round settled with no tournament running gets no tournament_id'
);
select is(
  (select count(*)::int from public.tournament_scores where player_id = :'player_b'::uuid),
  0,
  'no tournament running means no tournament_scores row is ever created for that round'
);

select * from finish();
rollback;
