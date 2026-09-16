-- Invariant (docs/layers.md C5): claim_task and free_refill both return the exact reward the
-- ledger granted, both reject a second claim/refill with their own named error, and get_tasks()
-- reports id/title/reward/claimed for the calling player - never assembled by the client.
begin;

select plan(13);

-- claim_task: a one-time task grants its reward once, then refuses a repeat -----------------

select tests.create_confirmed_player('claim-task@example.com') as claimer_id \gset
set local role authenticated;
select set_config('app.player_id', :'claimer_id', true);

select is(
  (select coins from public.players where id = :'claimer_id'),
  1000,
  'sanity: a fresh confirmed player starts at 1000 coins'
);

select (public.claim_task('email')) as claim_1 \gset
select is((:'claim_1'::json->>'reward')::int, 200, 'claim_task returns the reward it just granted (email = 200)');
select is((:'claim_1'::json->>'coins')::int, 1200, 'claim_task returns the new balance: 1000 + 200');
select is(
  (select coins from public.players where id = :'claimer_id'),
  1200,
  'the reward is actually applied to the player row, not just reported'
);

select throws_like(
  $$ select public.claim_task('email') $$,
  '%already_claimed%',
  'a second claim of the same one-time task is rejected'
);
select is(
  (select coins from public.players where id = :'claimer_id'),
  1200,
  'the rejected repeat claim grants nothing on top of the first'
);

-- get_tasks(): reward and claimed both computed here, matching claim_task exactly ----------

select is(
  (select reward from public.get_tasks() where id = 'email'),
  200,
  'get_tasks reports the same reward claim_task just paid'
);
select is(
  (select claimed from public.get_tasks() where id = 'email'),
  true,
  'get_tasks marks the claimed task as claimed for this player'
);
select is(
  (select claimed from public.get_tasks() where id = 'instagram'),
  false,
  'get_tasks marks an unclaimed task as not claimed'
);

reset role;

-- free_refill: only once eligible (coins < 100), rejects a second call regardless of balance --

select tests.create_confirmed_player('refill-task@example.com') as refill_id \gset
-- Two lever-5 (stake 500) losses take a fresh 1000-coin player to 0, the same drain
-- db/tests/55_kiosk_session.sql uses for the kiosk economy.
select (public.open_round(:'refill_id'::uuid, 'up', 5, 100)->>'round_id')::uuid as refill_loss_1 \gset
select public.settle_round(:'refill_loss_1'::uuid, 99);
select (public.open_round(:'refill_id'::uuid, 'up', 5, 100)->>'round_id')::uuid as refill_loss_2 \gset
select public.settle_round(:'refill_loss_2'::uuid, 99);
select is((select coins from public.players where id = :'refill_id'), 0, 'sanity: the drain leaves exactly 0 coins');

set local role authenticated;
select set_config('app.player_id', :'refill_id', true);

select (public.free_refill()) as refill_1 \gset
select is((:'refill_1'::json->>'reward')::int, 300, 'free_refill returns the reward it just granted (300)');
select is((:'refill_1'::json->>'coins')::int, 300, 'free_refill returns the new balance: 0 + 300');

select throws_like(
  $$ select public.free_refill() $$,
  '%already_refilled%',
  'a second free_refill is rejected as already_refilled, not the generic refill_unavailable'
);

reset role;

select * from finish();
rollback;
