-- Instagram follow reward schema and release path (ticket K3, replacing B8's OAuth model).
-- Tests run as postgres; the service-role-only guard is asserted with function_privs_are.
begin;

select plan(16);

-- The instagram_accounts table exists with the K3 columns, keyed by player.
select has_table('public', 'instagram_accounts', 'public.instagram_accounts table exists');
select has_column('public', 'instagram_accounts', 'player_id', 'instagram_accounts has player_id');
select has_column('public', 'instagram_accounts', 'handle', 'instagram_accounts has handle');
select has_column('public', 'instagram_accounts', 'device_id', 'instagram_accounts has device_id');
select has_column('public', 'instagram_accounts', 'verified_at', 'instagram_accounts has verified_at');
select has_column('public', 'instagram_accounts', 'created_at', 'instagram_accounts has created_at');
select col_is_pk('public', 'instagram_accounts', 'player_id', 'player_id is the primary key');

-- start_instagram stores the handle, unverified.
select tests.create_anonymous_player() as ig_p1 \gset
select public.start_instagram(:'ig_p1'::uuid, 'follower') as ig_started \gset
select is((:'ig_started'::json ->> 'verified')::boolean, false, 'start_instagram stores the handle unverified');
select ok(
  exists(
    select 1 from public.instagram_accounts
    where player_id = :'ig_p1'::uuid and handle = 'follower' and verified_at is null
  ),
  'a row is stored with verified_at null'
);

-- A handle already held by another player is refused (the unique index makes this atomic).
select tests.create_anonymous_player() as ig_p2 \gset
select format($$select public.start_instagram(%L::uuid, 'follower')$$, :'ig_p2') as q_taken \gset
select throws_ok(:'q_taken', 'instagram_handle_taken', 'a handle held by another player is refused');

-- verify_instagram releases the reward and marks the row verified.
select public.verify_instagram(:'ig_p1'::uuid, 'follower') as ig_verify \gset
select is((:'ig_verify'::json ->> 'reward')::int, 300, 'verify_instagram releases the instagram reward (seed: 300)');
select ok(
  exists(select 1 from public.instagram_accounts where player_id = :'ig_p1'::uuid and verified_at is not null),
  'the row is marked verified'
);
select ok(
  exists(select 1 from public.task_claims where player_id = :'ig_p1'::uuid and task_id = 'instagram'),
  'a task_claims row is written for instagram'
);

-- Once verified, the player cannot switch to a different handle.
select format($$select public.start_instagram(%L::uuid, 'someoneelse')$$, :'ig_p1') as q_verified \gset
select throws_ok(:'q_verified', 'instagram_already_verified', 'switching handle after a verify is refused');

-- Service-role only: a client holding the anon/authenticated key must not be able to call these
-- functions directly (adversarial: server-decides).
select function_privs_are(
  'public', 'start_instagram', array['uuid', 'text'], 'authenticated', array[]::text[],
  'authenticated has no execute privilege on start_instagram'
);
select function_privs_are(
  'public', 'verify_instagram', array['uuid', 'text'], 'authenticated', array[]::text[],
  'authenticated has no execute privilege on verify_instagram'
);

-- The once-per-device/email duplicate behavior is covered by db/tests/80_device_identity.sql.

select * from finish();
rollback;
