-- Invariant (ticket B5, docs/tickets/b5-device-identity.md decision 4): claim_task and
-- free_refill are once per device OR per verified email, on top of the pre-existing
-- once-per-player check - across two different players. A player with no device token
-- (device_id null) is never cross-blocked by device: "one device per player" for old clients.
--
-- The shared-email case below forces a collision that the running app can never actually
-- produce (auth.users.email is unique, so two confirmed players cannot really share one - see
-- claim_task's own comment in db/schema.sql): this suite, running as postgres, drops
-- auth.users' own unique constraint on email for the duration of this transaction so a second
-- player's email can be set to the first player's, entirely undone by this file's own
-- `rollback` at the end - it never reaches a committed schema.
begin;

select plan(13);

-- claim_task: blocked across two players sharing one device ------------------------------------

select tests.create_device() as device_shared \gset
select tests.create_anonymous_player(:'device_shared'::uuid) as claim_dev_p1 \gset
select tests.create_anonymous_player(:'device_shared'::uuid) as claim_dev_p2 \gset

set local role authenticated;
select set_config('app.player_id', :'claim_dev_p1', true);
select (public.claim_task('instagram')) as claim_dev_p1_result \gset
select is(
  (:'claim_dev_p1_result'::json->>'reward')::int, 300,
  'the first player on a shared device claims instagram normally'
);
reset role;

set local role authenticated;
select set_config('app.player_id', :'claim_dev_p2', true);
select throws_like(
  $$ select public.claim_task('instagram') $$,
  '%already_claimed%',
  'a second, different player on the same device is blocked from the same task'
);
select is(
  (select coins from public.players where id = :'claim_dev_p2'),
  1000,
  'the blocked second player was granted nothing'
);
reset role;

-- claim_task: allowed across two different devices, no email -----------------------------------

select tests.create_device() as device_a \gset
select tests.create_device() as device_b \gset
select tests.create_anonymous_player(:'device_a'::uuid) as claim_devab_p1 \gset
select tests.create_anonymous_player(:'device_b'::uuid) as claim_devab_p2 \gset

set local role authenticated;
select set_config('app.player_id', :'claim_devab_p1', true);
select is(
  ((public.claim_task('telegram'))->>'reward')::int, 300,
  'a player on device A claims telegram'
);
reset role;

set local role authenticated;
select set_config('app.player_id', :'claim_devab_p2', true);
select is(
  ((public.claim_task('telegram'))->>'reward')::int, 300,
  'a different player on device B claims the same task independently'
);
reset role;

-- claim_task: blocked across two devices sharing one verified email ----------------------------

select tests.create_device() as device_c \gset
select tests.create_device() as device_d \gset
select tests.create_confirmed_player('device-email-shared@example.com', null, :'device_c'::uuid) as claim_email_p1 \gset
select tests.create_confirmed_player('device-email-other@example.com', null, :'device_d'::uuid) as claim_email_p2 \gset
-- Force the collision claim_task's email check exists for (see the comment above): drop the
-- constraint that makes it impossible in practice, retarget auth.users.email, then let
-- ensure_player's own normal sync (claim_task calls it first) copy that email onto players -
-- updating players.email directly would not survive claim_task's own ensure_player call, which
-- re-syncs from auth.users on every invocation.
alter table auth.users drop constraint users_email_key;
update auth.users set email = 'device-email-shared@example.com' where id = :'claim_email_p2';

set local role authenticated;
select set_config('app.player_id', :'claim_email_p1', true);
select is(
  ((public.claim_task('youtube'))->>'reward')::int, 300,
  'the first player claims youtube on their own device and email'
);
reset role;

set local role authenticated;
select set_config('app.player_id', :'claim_email_p2', true);
select throws_like(
  $$ select public.claim_task('youtube') $$,
  '%already_claimed%',
  'a different player on a different device, but the same verified email, is blocked'
);
reset role;

-- claim_task: allowed across two devices and two different verified emails ---------------------

select tests.create_device() as device_e \gset
select tests.create_device() as device_f \gset
select tests.create_confirmed_player('device-email-e@example.com', null, :'device_e'::uuid) as claim_diff_p1 \gset
select tests.create_confirmed_player('device-email-f@example.com', null, :'device_f'::uuid) as claim_diff_p2 \gset

set local role authenticated;
select set_config('app.player_id', :'claim_diff_p1', true);
select is(
  ((public.claim_task('review_google'))->>'reward')::int, 500,
  'a player on device E, own email, claims review_google'
);
reset role;

set local role authenticated;
select set_config('app.player_id', :'claim_diff_p2', true);
select is(
  ((public.claim_task('review_google'))->>'reward')::int, 500,
  'a different player on device F, a different email, claims the same task independently'
);
reset role;

-- free_refill: blocked across two players sharing one device -----------------------------------

select tests.create_device() as device_refill \gset
select tests.create_anonymous_player(:'device_refill'::uuid) as refill_dev_p1 \gset
select tests.create_anonymous_player(:'device_refill'::uuid) as refill_dev_p2 \gset

-- Drain both to below 100 coins the same way db/tests/75_tasks_and_refill.sql does.
select (public.open_round(:'refill_dev_p1'::uuid, 'up', 5, 100)->>'round_id')::uuid as r1 \gset
select public.settle_round(:'r1'::uuid, 99);
select (public.open_round(:'refill_dev_p1'::uuid, 'up', 5, 100)->>'round_id')::uuid as r2 \gset
select public.settle_round(:'r2'::uuid, 99);
select (public.open_round(:'refill_dev_p2'::uuid, 'up', 5, 100)->>'round_id')::uuid as r3 \gset
select public.settle_round(:'r3'::uuid, 99);
select (public.open_round(:'refill_dev_p2'::uuid, 'up', 5, 100)->>'round_id')::uuid as r4 \gset
select public.settle_round(:'r4'::uuid, 99);

set local role authenticated;
select set_config('app.player_id', :'refill_dev_p1', true);
select is(
  ((public.free_refill())->>'reward')::int, 300,
  'the first broke player on a shared device gets the free refill'
);
reset role;

set local role authenticated;
select set_config('app.player_id', :'refill_dev_p2', true);
select throws_like(
  $$ select public.free_refill() $$,
  '%already_refilled%',
  'a second, different broke player on the same device is refused'
);
reset role;

-- free_refill: two players with no device token at all never cross-block -----------------------

select tests.create_anonymous_player() as refill_null_p1 \gset
select tests.create_anonymous_player() as refill_null_p2 \gset

select (public.open_round(:'refill_null_p1'::uuid, 'up', 5, 100)->>'round_id')::uuid as r5 \gset
select public.settle_round(:'r5'::uuid, 99);
select (public.open_round(:'refill_null_p1'::uuid, 'up', 5, 100)->>'round_id')::uuid as r6 \gset
select public.settle_round(:'r6'::uuid, 99);
select (public.open_round(:'refill_null_p2'::uuid, 'up', 5, 100)->>'round_id')::uuid as r7 \gset
select public.settle_round(:'r7'::uuid, 99);
select (public.open_round(:'refill_null_p2'::uuid, 'up', 5, 100)->>'round_id')::uuid as r8 \gset
select public.settle_round(:'r8'::uuid, 99);

set local role authenticated;
select set_config('app.player_id', :'refill_null_p1', true);
select is(
  ((public.free_refill())->>'reward')::int, 300,
  'a broke player with no device token gets the free refill'
);
reset role;

set local role authenticated;
select set_config('app.player_id', :'refill_null_p2', true);
select is(
  ((public.free_refill())->>'reward')::int, 300,
  'a second, unrelated broke player with no device token is not cross-blocked by the first'
);
reset role;

select * from finish();
rollback;
