-- Invariant: public.leaderboard(p_tournament, p_page) pages 20 rows at a time, ordered by
-- record desc then updated_at asc (earlier record wins ties); public.leaderboard_total()
-- reports the same board's full count for the client's page count; public.my_rank() resolves
-- the caller's own row by player id (ticket B2 decision 1, closes gap G3), never a masked-email
-- comparison, and returns nothing - not an error - for a caller with no verified email or no
-- score in the tournament; public.tier_for_rank() assigns the badge tier whose range contains a
-- rank (ticket B3); public.badge_legend() lists every tier in display order.
begin;

select plan(24);

-- ---- paging boundaries at 20/21 ------------------------------------------------------------
insert into public.tournaments (id, title, starts_at, ends_at, prize_title, prize_image)
values ('pg-t1', 'Paging 25 test', '2030-01-01+00', '2030-01-02+00', 'Prize', '/prizes/t.png');

select tests.create_confirmed_player('pg1-1@example.com') as pg1_top \gset
insert into public.tournament_scores (tournament_id, player_id, record) values ('pg-t1', :'pg1_top', 2999);
insert into public.tournament_scores (tournament_id, player_id, record)
select 'pg-t1', tests.create_confirmed_player('pg1-' || n || '@example.com'), 3000 - n
from generate_series(2, 25) as n;

select is(
  (select count(*) from public.leaderboard('pg-t1', 1))::int, 20,
  'page 1 of a 25-row board is exactly 20 rows'
);
select is(
  (select min(record) from public.leaderboard('pg-t1', 1)), 2980,
  'page 1''s lowest record is rank 20''s (2980) - nothing from rank 21 leaks onto it'
);
select is(
  (select count(*) from public.leaderboard('pg-t1', 2))::int, 5,
  'page 2 of a 25-row board is exactly the remaining 5 rows'
);
select ok(
  exists(select 1 from public.leaderboard('pg-t1', 2) where rank = 21 and record = 2979),
  'rank 21 (the first row past the boundary) lands on page 2, not page 1'
);

-- ---- tie order: equal record, earlier updated_at wins ---------------------------------------
insert into public.tournaments (id, title, starts_at, ends_at, prize_title, prize_image)
values ('pg-t2', 'Tie order test', '2030-01-03+00', '2030-01-04+00', 'Prize', '/prizes/t.png');
select tests.create_confirmed_player('tie-a@example.com') as tie_a \gset
select tests.create_confirmed_player('tie-b@example.com') as tie_b \gset
insert into public.tournament_scores (tournament_id, player_id, record, updated_at) values
  ('pg-t2', :'tie_a', 500, now() - interval '10 seconds'),
  ('pg-t2', :'tie_b', 500, now());

select ok(
  exists(select 1 from public.leaderboard('pg-t2', 1) where display = 't***a@e**.com' and rank = 1),
  'an equal record: the earlier update (tie_a) wins rank 1'
);
select ok(
  exists(select 1 from public.leaderboard('pg-t2', 1) where display = 't***b@e**.com' and rank = 2),
  'an equal record: the later update (tie_b) is rank 2'
);

-- ---- badge tier assignment at every boundary (ticket B3) -------------------------------------
select is(public.tier_for_rank(1), 'gold', 'rank 1 is tiered gold');
select is(public.tier_for_rank(3), 'bronze', 'rank 3 is tiered bronze');
select is(public.tier_for_rank(4), 'top10', 'rank 4 is tiered top10 (the 3-1 tiers end at rank 3)');
select is(public.tier_for_rank(10), 'top10', 'rank 10 is still tiered top10 (the top10 range''s own upper bound)');
select is(public.tier_for_rank(11), 'top100', 'rank 11 is tiered top100 (one past top10''s upper bound)');
select is(public.tier_for_rank(100), 'top100', 'rank 100 is still tiered top100 (the top100 range''s own upper bound)');
select is(public.tier_for_rank(101), 'player', 'rank 101 is tiered player (one past top100''s upper bound, the open-ended range)');

-- ---- my_rank: verified player, own row by player id (closes gap G3) -------------------------
select set_config('app.player_id', :'pg1_top', true);
select is((select rank from public.my_rank('pg-t1')), 1::bigint, 'my_rank resolves the caller''s own rank (1) by player id');
select is((select tier from public.my_rank('pg-t1')), 'gold', 'my_rank carries the caller''s own tier');
select is((select total from public.my_rank('pg-t1')), 25::bigint, 'my_rank carries the tournament''s total ranked-player count');
select set_config('app.player_id', '', true);

-- ---- my_rank: nothing to resolve is nothing back, never an error ----------------------------
select tests.create_confirmed_player('pg1-noplay@example.com') as pg1_noplay \gset
select set_config('app.player_id', :'pg1_noplay', true);
select is(
  (select count(*) from public.my_rank('pg-t1'))::int, 0,
  'a verified player with no score in this tournament: my_rank returns nothing, not an error'
);
select set_config('app.player_id', '', true);

select tests.create_unconfirmed_player('pg1-unconf@example.com') as pg1_unconf \gset
insert into public.tournament_scores (tournament_id, player_id, record) values ('pg-t1', :'pg1_unconf', 9999999);
select set_config('app.player_id', :'pg1_unconf', true);
select is(
  (select count(*) from public.my_rank('pg-t1'))::int, 0,
  'an email-unconfirmed player never gets a row from my_rank, however high its record'
);
select set_config('app.player_id', '', true);

-- ---- badge_legend(): every tier, in display order --------------------------------------------
select is(
  (select array_agg(tier order by sort) from public.badge_legend()),
  array['gold', 'silver', 'bronze', 'top10', 'top100', 'player'],
  'badge_legend() returns all six tiers, ordered by sort'
);
select is(
  (select icon from public.badge_legend() where tier = 'gold'),
  '/badges/gold.svg',
  'badge_legend() carries each tier''s icon path'
);

-- ---- leaderboard_total() -----------------------------------------------------------------
select is(
  (select public.leaderboard_total('pg-t1'))::int, 25,
  'leaderboard_total counts every ranked, confirmed-email row for that tournament (the unconfirmed row above never counts)'
);

-- ---- paging boundary at an exact multiple of 20 -----------------------------------------------
insert into public.tournaments (id, title, starts_at, ends_at, prize_title, prize_image)
values ('pg-t4', 'Paging 40 test', '2030-01-05+00', '2030-01-06+00', 'Prize', '/prizes/t.png');
insert into public.tournament_scores (tournament_id, player_id, record)
select 'pg-t4', tests.create_confirmed_player('pg4-' || n || '@example.com'), 5000 - n
from generate_series(1, 40) as n;

select is((select count(*) from public.leaderboard('pg-t4', 1))::int, 20, 'page 1 of an exactly-40-row board is 20 rows');
select is((select count(*) from public.leaderboard('pg-t4', 2))::int, 20, 'page 2 of an exactly-40-row board is the other 20 rows');
select is((select count(*) from public.leaderboard('pg-t4', 3))::int, 0, 'page 3 of an exactly-40-row board is empty, not an error');

select * from finish();
rollback;
