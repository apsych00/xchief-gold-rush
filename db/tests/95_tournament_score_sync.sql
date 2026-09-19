-- Invariant (score-desync fix): tournament_scores - the table the public leaderboard and
-- my_rank() actually rank on - must stay in step with players.coins no matter which path raised
-- it, not only settle_round. Before this fix, release_task_reward (claim_task, report_video_
-- progress, return_task_visit, instagram_check, and the email/signup grant inside verify_otp)
-- and free_refill updated players.coins/record and stopped there: a player who verified their
-- email or claimed a mission reward saw their own balance move but never appeared - or moved -
-- on the tournament board until they next played a round. db/tests/80_tournaments.sql already
-- covers settle_round's own half of this (tournament assignment, the "only a new peak upserts"
-- rule, "no tournament running" being a no-op); this file covers the other callers of the same
-- shared path, public.bump_tournament_score.
--
-- Clears the seed tournaments inside its own transaction (rolled back at the end, like every
-- other suite here), same reasoning as 80_tournaments.sql: "no tournament running" has to be
-- testable deterministically, not left depending on today's date falling inside db/seed.sql's
-- real campaign windows.
begin;

select plan(9);

insert into public.tasks (id, title, reward, kind) values
  ('test_manual_95', 'Test manual task', 250, 'manual'),
  ('test_manual_95b', 'Small reward', 10, 'manual'),
  ('test_manual_95c', 'No tournament reward', 50, 'manual');

delete from public.tournaments;
insert into public.tournaments (id, title, starts_at, ends_at, prize_title, prize_image, broker_bonus) values
  ('tt-sync', 'Sync', now() - interval '1 hour', now() + interval '1 hour', 'Prize', '/prizes/sync.png', 'bonus text');

-- ---- release_task_reward (claim_task): a task claim now bumps tournament_scores too --------

select tests.create_confirmed_player('sync-claim@example.com') as claimer_id \gset
select is(
  (select count(*)::int from public.tournament_scores where player_id = :'claimer_id'::uuid),
  0,
  'sanity: a fresh player has no tournament_scores row before claiming anything'
);

set local role authenticated;
select set_config('app.player_id', :'claimer_id', true);
select (public.claim_task('test_manual_95')) as claim_1 \gset
reset role;

select is(
  (select coins from public.players where id = :'claimer_id'::uuid),
  1250,
  'sanity: the task reward landed on players.coins (1000 + 250)'
);
select is(
  (select record from public.tournament_scores where tournament_id = 'tt-sync' and player_id = :'claimer_id'::uuid),
  1250,
  'claim_task''s reward now also lands on tournament_scores for the running tournament'
);

-- ---- free_refill: same path, same fix ------------------------------------------------------
--
-- Broke via a direct update (postgres, bypassing RLS) rather than round losses: a settled round
-- would itself upsert tournament_scores through settle_round's own call, muddying which write
-- free_refill's own call is responsible for. This way tournament_scores has no row at all for
-- this player before free_refill runs, so any row appearing after it can only be free_refill's.
select tests.create_confirmed_player('sync-refill@example.com') as refiller_id \gset
update public.players set coins = 0 where id = :'refiller_id'::uuid;
select is(
  (select count(*)::int from public.tournament_scores where player_id = :'refiller_id'::uuid),
  0,
  'sanity: no tournament_scores row exists for this player before free_refill runs'
);

set local role authenticated;
select set_config('app.player_id', :'refiller_id', true);
select (public.free_refill()) as refill_1 \gset
reset role;

select is(
  (select record from public.tournament_scores where tournament_id = 'tt-sync' and player_id = :'refiller_id'::uuid),
  300,
  'free_refill''s reward also lands on tournament_scores for the running tournament'
);

-- ---- bump_tournament_score never lowers the stored peak (same ON CONFLICT guard as settle_round) --

select tests.create_confirmed_player('sync-peak@example.com') as peak_id \gset
select (public.open_round(:'peak_id'::uuid, 'up', 1, 100)->>'round_id')::uuid as peak_round \gset
-- win: 1000 + 100 -> 1100, the peak this tournament now holds for this player
select public.settle_round(:'peak_round'::uuid, 101);
select is(
  (select record from public.tournament_scores where tournament_id = 'tt-sync' and player_id = :'peak_id'::uuid),
  1100,
  'sanity: the win set the tournament peak to 1100'
);
-- A reward release still lands even though it does not clear the round-settled peak: the sync
-- fix must reflect players.coins as-is, never guard it against overwriting a HIGHER number with
-- a lower one the way settle_round's WHERE clause does for a plain loss - release_task_reward
-- and free_refill only ever add coins, so their own call always raises coins, but a player who
-- claims a small reward right after a big round win still has a coins total below that tournament
-- peak, and the shared ON CONFLICT WHERE guard (excluded.record > stored) is exactly what keeps
-- that from silently lowering the board.
set local role authenticated;
select set_config('app.player_id', :'peak_id', true);
select (public.claim_task('test_manual_95b')) as small_claim \gset
reset role;
select is(
  (select coins from public.players where id = :'peak_id'::uuid),
  1110,
  'sanity: the small reward landed on players.coins (1100 + 10 = 1110), below nothing - this is still the new peak'
);
select is(
  (select record from public.tournament_scores where tournament_id = 'tt-sync' and player_id = :'peak_id'::uuid),
  1110,
  'the reward-raised balance becomes the new tournament peak, same guard as a round win'
);

-- ---- no tournament running: bump_tournament_score is a no-op, same as settle_round's own ----

delete from public.tournament_scores;
delete from public.rounds;
delete from public.tournaments;
select tests.create_confirmed_player('sync-none@example.com') as none_id \gset
set local role authenticated;
select set_config('app.player_id', :'none_id', true);
select (public.claim_task('test_manual_95c')) as none_claim \gset
reset role;
select is(
  (select count(*)::int from public.tournament_scores where player_id = :'none_id'::uuid),
  0,
  'no tournament running means a task reward creates no tournament_scores row either, same as settle_round'
);

select * from finish();
rollback;
