-- Invariant: session policy (docs/layers.md C3a) - players.token_version starts at 1, only
-- moves through revoke_player_sessions, and that function is service-role only exactly like
-- every other function that owns the ledger or an identity decision. (verify_otp_code's
-- re-login shape is covered in 60_otp.sql, the file that already owns the OTP invariants.)
begin;

select plan(5);

select tests.create_anonymous_player() as p1 \gset
select is(
  (select token_version from public.players where id = :'p1'::uuid),
  1,
  'a fresh player starts at token_version 1'
);

select public.revoke_player_sessions(:'p1'::uuid);
select is(
  (select token_version from public.players where id = :'p1'::uuid),
  2,
  'revoke_player_sessions bumps token_version'
);

select public.revoke_player_sessions(:'p1'::uuid);
select is(
  (select token_version from public.players where id = :'p1'::uuid),
  3,
  'revoking twice bumps it twice - it invalidates every outstanding token, not just the latest one'
);

set local role anon;
select throws_ok(
  $$ select public.revoke_player_sessions(gen_random_uuid()) $$,
  '42501', NULL,
  'anon cannot call revoke_player_sessions'
);
reset role;

set local role authenticated;
select throws_ok(
  $$ select public.revoke_player_sessions(gen_random_uuid()) $$,
  '42501', NULL,
  'authenticated cannot call revoke_player_sessions'
);
reset role;

select * from finish();
rollback;
