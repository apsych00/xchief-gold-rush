-- Ticket B13 SQL guards: per-player per-task idempotency on every release path,
-- the reward audit view, and IP recording on task claims.
begin;

select plan(10);

insert into public.tasks (id, title, reward, kind) values ('b13_manual', 'B13 manual task', 250, 'manual');

-- Per-player per-task idempotency: the unique index is the atomic backstop ---------------

select tests.create_device() as device_1 \gset
select tests.create_anonymous_player(:'device_1'::uuid) as player_1 \gset

-- claim_task succeeds once.
set local role authenticated;
select set_config('app.player_id', :'player_1', true);
select public.claim_task('b13_manual') as claim_1 \gset
select is((:'claim_1'::json->>'reward')::int, 250, 'claim_task grants the manual task once');

-- A duplicate insert on the unique index would fail; claim_task raises already_claimed instead.
select throws_like(
  $$ select public.claim_task('b13_manual') $$,
  '%already_claimed%',
  'claim_task raises already_claimed on a duplicate player/task'
);
reset role;

-- release_task_reward is also idempotent: a second call returns null, not a second row.
select ok(
  public.release_task_reward(:'player_1'::uuid, 'b13_manual') is null,
  'release_task_reward returns null when the reward is already claimed'
);

select is(
  (select count(*)::int from public.task_claims where player_id = :'player_1' and task_id = 'b13_manual'),
  1,
  'only one task_claims row exists after claim_task + release_task_reward'
);

-- Reward audit view --------------------------------------------------------------------------

select has_view('public', 'reward_audit', 'reward_audit view exists');
select bag_eq(
  $$ select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'reward_audit' order by ordinal_position $$,
  $$ values
    ('player', 'uuid'),
    ('device', 'uuid'),
    ('email', 'text'),
    ('task', 'text'),
    ('reward', 'integer'),
    ('claimed_at', 'timestamp with time zone'),
    ('ip', 'inet')
  $$,
  'reward_audit exposes the expected columns and types'
);

select is(
  (select count(*)::int from public.reward_audit where player = :'player_1' and task = 'b13_manual'),
  1,
  'reward_audit includes the manual task claim'
);

-- IP recording -------------------------------------------------------------------------------

select is(
  (select claimed_ip from public.task_claims where player_id = :'player_1' and task_id = 'b13_manual'),
  null,
  'claimed_ip is null when app.client_ip was not set'
);

select set_config('app.client_ip', '203.0.113.42', true);
select tests.create_device() as device_2 \gset
select tests.create_anonymous_player(:'device_2'::uuid) as player_2 \gset

select is(
  (public.release_task_reward(:'player_2'::uuid, 'instagram')->>'reward')::int,
  300,
  'release_task_reward grants a different task to a player on a different device'
);

select is(
  (select claimed_ip from public.task_claims where player_id = :'player_2' and task_id = 'instagram'),
  '203.0.113.42'::inet,
  'release_task_reward records app.client_ip in claimed_ip'
);

select * from finish();
rollback;
