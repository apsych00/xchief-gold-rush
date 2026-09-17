-- Invariant: public.leaderboard(p_tournament) exposes only display/record/rank - display is
-- the masked email (docs/layers.md C4: "never a raw address"), never display_name or the raw
-- email - and only players with a confirmed email (players.email is not null) - never a bare
-- balance page for anonymous play. (0005_lint_and_crypt.sql replaced the leaderboard view with
-- a SECURITY DEFINER function to satisfy Supabase's linter, same access model; ticket B1 then
-- gave it its own p_tournament argument and moved the ranked column from players.record to
-- tournament_scores.record for one tournament, so this file ranks inside a tournament it makes
-- itself rather than relying on whichever one current_tournament() would otherwise resolve.)
begin;

select plan(3);

select is(
  (select proargnames from pg_proc where oid = 'public.leaderboard(text)'::regprocedure),
  array['p_tournament', 'display', 'record', 'rank'],
  'leaderboard(text) returns exactly display, record, rank (plus its own p_tournament argument)'
);

insert into public.tournaments (id, title, starts_at, ends_at, prize_title, prize_image)
values ('lbv-t1', 'LBV test tournament', '2030-01-01+00', '2030-01-02+00', 'Prize', '/prizes/t.png');

select tests.create_confirmed_player('lb-confirmed@example.com', 'ConfirmedTrader') as confirmed_id \gset
insert into public.tournament_scores (tournament_id, player_id, record) values ('lbv-t1', :'confirmed_id', 9999);

select tests.create_unconfirmed_player('lb-unconfirmed@example.com') as unconfirmed_id \gset
insert into public.tournament_scores (tournament_id, player_id, record) values ('lbv-t1', :'unconfirmed_id', 99999);

set local role anon;

select ok(
  exists(select 1 from public.leaderboard('lbv-t1') where display = 'l****d@example.com' and record = 9999),
  'a confirmed player with a record appears on that tournament''s public leaderboard, masked email as display'
);

select ok(
  not exists(select 1 from public.leaderboard('lbv-t1') where record = 99999),
  'an email-unconfirmed player never appears on the leaderboard, however high its record'
);

reset role;

select * from finish();
rollback;
