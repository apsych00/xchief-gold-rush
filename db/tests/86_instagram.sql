-- Instagram reward schema and release path (ticket B8).
-- Tests run as postgres; client-role access tests use set local role authenticated.
begin;

select plan(8);

-- The instagram_accounts table exists with the expected columns and primary key.
select has_table('public', 'instagram_accounts', 'public.instagram_accounts table exists');
select has_column('public', 'instagram_accounts', 'ig_user_id', 'instagram_accounts has ig_user_id');
select has_column('public', 'instagram_accounts', 'username', 'instagram_accounts has username');
select has_column('public', 'instagram_accounts', 'player_id', 'instagram_accounts has player_id');
select has_column('public', 'instagram_accounts', 'device_id', 'instagram_accounts has device_id');
select has_column('public', 'instagram_accounts', 'verified_at', 'instagram_accounts has verified_at');

-- release_task_reward can release the seeded instagram task server-side.
select tests.create_anonymous_player() as ig_p1 \gset
select public.release_task_reward(:'ig_p1'::uuid, 'instagram') as ig_reward \gset
select is((:'ig_reward'::json->>'reward')::int, 300, 'release_task_reward releases the instagram reward (seed: 300)');
select ok(
  exists(select 1 from public.task_claims where player_id = :'ig_p1'::uuid and task_id = 'instagram'),
  'a task_claims row is written for instagram'
);

-- The once-per-device/email duplicate behavior is covered by db/tests/80_device_identity.sql.

select * from finish();
rollback;
