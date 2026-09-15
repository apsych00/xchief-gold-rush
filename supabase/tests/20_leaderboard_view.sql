-- Invariant: the leaderboard exposes only display_name/record/rank, and only players with
-- a confirmed email (players.email is not null) - never a bare balance page for anonymous play.
-- Relies on the fixture functions committed by 00_helpers.sql, which pg_prove runs first.
begin;

select plan(3);

select columns_are('public', 'leaderboard', array['display_name', 'record', 'rank'],
  'leaderboard exposes exactly display_name, record, rank');

select tests.create_confirmed_player('lb-confirmed@example.com', 'ConfirmedTrader') as confirmed_id \gset
update public.players set record = 9999 where id = :'confirmed_id';

select tests.create_unconfirmed_player('lb-unconfirmed@example.com') as unconfirmed_id \gset
update public.players set record = 99999 where id = :'unconfirmed_id';

set local role anon;

select ok(
  exists(select 1 from public.leaderboard where display_name = 'ConfirmedTrader' and record = 9999),
  'a confirmed player with a record appears on the public leaderboard'
);

select ok(
  not exists(select 1 from public.leaderboard where record = 99999),
  'an email-unconfirmed player never appears on the leaderboard, however high its record'
);

reset role;

select * from finish();
rollback;
