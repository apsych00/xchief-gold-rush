-- Invariant: public.leaderboard() exposes only display/record/rank - display is the masked
-- email (docs/layers.md C4: "never a raw address"), never display_name or the raw email - and
-- only players with a confirmed email (players.email is not null) - never a bare balance page
-- for anonymous play. (0005_lint_and_crypt.sql replaced the leaderboard view with a SECURITY
-- DEFINER function to satisfy Supabase's linter; same access model, so the invariant carries
-- over even as the ticket C4 column shape changes.)
begin;

select plan(3);

select is(
  (select proargnames from pg_proc where oid = 'public.leaderboard()'::regprocedure),
  array['display', 'record', 'rank'],
  'leaderboard() returns exactly display, record, rank'
);

select tests.create_confirmed_player('lb-confirmed@example.com', 'ConfirmedTrader') as confirmed_id \gset
update public.players set record = 9999 where id = :'confirmed_id';

select tests.create_unconfirmed_player('lb-unconfirmed@example.com') as unconfirmed_id \gset
update public.players set record = 99999 where id = :'unconfirmed_id';

set local role anon;

select ok(
  exists(select 1 from public.leaderboard() where display = 'l****d@example.com' and record = 9999),
  'a confirmed player with a record appears on the public leaderboard, masked email as display'
);

select ok(
  not exists(select 1 from public.leaderboard() where record = 99999),
  'an email-unconfirmed player never appears on the leaderboard, however high its record'
);

reset role;

select * from finish();
rollback;
