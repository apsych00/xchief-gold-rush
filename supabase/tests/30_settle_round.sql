-- Invariant: settle_round computes the win/lose/flat economy exactly per docs/backend-spec.md,
-- floors coins at 0 on a loss, and never touches coins/streak on a flat.
begin;

select plan(10);

-- Win at lever 5 with a prior streak of 2 pays round(500 * 2) = 1000 and bumps the streak.
select tests.create_confirmed_player('settle-win@example.com') as win_id \gset
update public.players set coins = 5000, streak = 2 where id = :'win_id';
select (public.open_round(:'win_id'::uuid, 'up', 5, 100)->>'round_id')::uuid as win_round_id \gset
select public.settle_round(:'win_round_id'::uuid, 101) as win_settle \gset
select is((:'win_settle'::json->>'outcome'), 'win', 'lever-5 win with streak 2 settles as a win');
select is((:'win_settle'::json->>'delta')::int, 1000, 'win pays round(500 * combo_mult(2)) = 1000');
select is((:'win_settle'::json->>'coins')::int, 6000, 'coins reflect the 1000 payout on top of 5000');
select is((:'win_settle'::json->>'streak')::int, 3, 'streak increments from 2 to 3 on a win');

-- Loss never takes coins below 0.
select tests.create_confirmed_player('settle-loss@example.com') as loss_id \gset
update public.players set coins = 100, streak = 4 where id = :'loss_id';
select (public.open_round(:'loss_id'::uuid, 'up', 1, 100)->>'round_id')::uuid as loss_round_id \gset
select public.settle_round(:'loss_round_id'::uuid, 90) as loss_settle \gset
select is((:'loss_settle'::json->>'outcome'), 'lose', 'a price drop against an up bet settles as a loss');
select is((:'loss_settle'::json->>'coins')::int, 0, 'coins floor at 0, never negative');
select is((:'loss_settle'::json->>'streak')::int, 0, 'a loss resets the streak to 0');

-- Flat leaves coins and streak untouched.
select tests.create_confirmed_player('settle-flat@example.com') as flat_id \gset
update public.players set coins = 777, streak = 2 where id = :'flat_id';
select (public.open_round(:'flat_id'::uuid, 'up', 2, 100)->>'round_id')::uuid as flat_round_id \gset
select public.settle_round(:'flat_round_id'::uuid, 100) as flat_settle \gset
select is((:'flat_settle'::json->>'outcome'), 'flat', 'an unchanged price settles as flat');
select is((:'flat_settle'::json->>'coins')::int, 777, 'flat leaves coins unchanged');
select is((:'flat_settle'::json->>'streak')::int, 2, 'flat leaves the streak unchanged');

select * from finish();
rollback;
