-- Invariant: when a tournament's window has closed, settle_tournaments() freezes its top three
-- places into tournament_results, exactly as public.leaderboard() ranked them, and never touches
-- them again. Week 1 of this campaign ended with a $3,000 prize and no record of who won it,
-- which is the gap this closes.
begin;

select plan(11);

-- A closed tournament and a running one, either side of now(). The tournaments table forbids
-- overlapping windows and the seeded campaign already covers this instant, so the seeded rows
-- come out first - safely, since this whole file runs in a transaction that is rolled back.
delete from public.tournament_scores;
delete from public.tournaments;

insert into public.tournaments (id, title, starts_at, ends_at, prize_title, prize_image)
values
  ('tr-closed', 'Closed', now() - interval '10 days', now() - interval '1 day', 'prize', '/p.png'),
  ('tr-open', 'Open', now() - interval '1 hour', now() + interval '10 days', 'prize', '/p.png');

-- Four ranked players with emails, plus one without: the board only ranks players who have an
-- email, so the podium must ignore the fifth however high it scores.
insert into auth.users (id) values
  ('aaaaaaaa-0000-0000-0000-000000000001'),
  ('aaaaaaaa-0000-0000-0000-000000000002'),
  ('aaaaaaaa-0000-0000-0000-000000000003'),
  ('aaaaaaaa-0000-0000-0000-000000000004'),
  ('aaaaaaaa-0000-0000-0000-000000000005');
insert into public.players (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'first@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'second@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'third@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'fourth@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000005', null);

insert into public.tournament_scores (tournament_id, player_id, record, updated_at) values
  ('tr-closed', 'aaaaaaaa-0000-0000-0000-000000000001', 5000, now()),
  ('tr-closed', 'aaaaaaaa-0000-0000-0000-000000000002', 4000, now()),
  ('tr-closed', 'aaaaaaaa-0000-0000-0000-000000000003', 3000, now()),
  ('tr-closed', 'aaaaaaaa-0000-0000-0000-000000000004', 2000, now()),
  -- No email: outscores everyone and must still not appear.
  ('tr-closed', 'aaaaaaaa-0000-0000-0000-000000000005', 9999, now()),
  -- The running tournament must be left completely alone.
  ('tr-open', 'aaaaaaaa-0000-0000-0000-000000000001', 7777, now());

select ok(
  (select public.settle_tournaments()) >= 3,
  'settling a closed tournament writes its podium'
);

select is(
  (select count(*)::int from public.tournament_results where tournament_id = 'tr-closed'),
  3,
  'exactly three places are recorded, not the whole board'
);
select is(
  (select player_id from public.tournament_results where tournament_id = 'tr-closed' and rank = 1),
  'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
  'first place is the highest record'
);
select is(
  (select record from public.tournament_results where tournament_id = 'tr-closed' and rank = 1),
  5000,
  'the winning record is copied, not looked up later'
);
select is(
  (select player_id from public.tournament_results where tournament_id = 'tr-closed' and rank = 3),
  'aaaaaaaa-0000-0000-0000-000000000003'::uuid,
  'third place is the third highest record'
);
select ok(
  not exists (
    select 1 from public.tournament_results
    where tournament_id = 'tr-closed' and player_id = 'aaaaaaaa-0000-0000-0000-000000000004'
  ),
  'fourth place wins nothing and is not recorded'
);
select ok(
  not exists (
    select 1 from public.tournament_results
    where tournament_id = 'tr-closed' and player_id = 'aaaaaaaa-0000-0000-0000-000000000005'
  ),
  'a player with no email is not on the podium, however high they scored'
);
select is(
  (select count(*)::int from public.tournament_results where tournament_id = 'tr-open'),
  0,
  'a tournament still running is never settled'
);

-- Idempotence is what makes it safe to call from a 60 s sweep. A second run must write nothing,
-- and must not revise a result even though the underlying score has since moved - which it can,
-- because balances carry across tournaments.
select is((select public.settle_tournaments())::int, 0, 'settling again writes nothing');
update public.tournament_scores set record = 1 where tournament_id = 'tr-closed';
select is((select public.settle_tournaments())::int, 0, 'a settled tournament is never revisited');
select is(
  (select record from public.tournament_results where tournament_id = 'tr-closed' and rank = 1),
  5000,
  'the frozen record stands even after the score behind it changed'
);

select * from finish();
rollback;
