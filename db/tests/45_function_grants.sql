-- Invariant: every server-clock function - the ones that own the coin ledger and coupon
-- claim - is revoked from anon and authenticated. Only the service role may call them.
begin;

select plan(22);

set local role anon;
select throws_ok($$ select public.ensure_player(gen_random_uuid()) $$, '42501', NULL, 'anon cannot call ensure_player');
select throws_ok($$ select public.open_round(gen_random_uuid(), 'up', 1, 100::numeric) $$, '42501', NULL, 'anon cannot call open_round');
select throws_ok($$ select public.settle_round(gen_random_uuid(), 100::numeric) $$, '42501', NULL, 'anon cannot call settle_round');
select throws_ok($$ select public.void_round(gen_random_uuid()) $$, '42501', NULL, 'anon cannot call void_round');
select throws_ok($$ select public.verify_kiosk('irrelevant-secret') $$, '42501', NULL, 'anon cannot call verify_kiosk');
select throws_ok($$ select public.start_kiosk_session(gen_random_uuid()) $$, '42501', NULL, 'anon cannot call start_kiosk_session');
select throws_ok($$ select public.reset_kiosk_session(gen_random_uuid()) $$, '42501', NULL, 'anon cannot call reset_kiosk_session');
select throws_ok($$ select public.open_kiosk_round(gen_random_uuid(), 'up', 100::numeric) $$, '42501', NULL, 'anon cannot call open_kiosk_round');
select throws_ok($$ select public.settle_kiosk_round(gen_random_uuid(), 100::numeric) $$, '42501', NULL, 'anon cannot call settle_kiosk_round');
select throws_ok($$ select public.claim_prize('irrelevant-token', 'x@example.com', null::inet) $$, '42501', NULL, 'anon cannot call claim_prize');
select throws_ok($$ select public.release_expired_claims() $$, '42501', NULL, 'anon cannot call release_expired_claims');
reset role;

set local role authenticated;
select throws_ok($$ select public.ensure_player(gen_random_uuid()) $$, '42501', NULL, 'authenticated cannot call ensure_player');
select throws_ok($$ select public.open_round(gen_random_uuid(), 'up', 1, 100::numeric) $$, '42501', NULL, 'authenticated cannot call open_round');
select throws_ok($$ select public.settle_round(gen_random_uuid(), 100::numeric) $$, '42501', NULL, 'authenticated cannot call settle_round');
select throws_ok($$ select public.void_round(gen_random_uuid()) $$, '42501', NULL, 'authenticated cannot call void_round');
select throws_ok($$ select public.verify_kiosk('irrelevant-secret') $$, '42501', NULL, 'authenticated cannot call verify_kiosk');
select throws_ok($$ select public.start_kiosk_session(gen_random_uuid()) $$, '42501', NULL, 'authenticated cannot call start_kiosk_session');
select throws_ok($$ select public.reset_kiosk_session(gen_random_uuid()) $$, '42501', NULL, 'authenticated cannot call reset_kiosk_session');
select throws_ok($$ select public.open_kiosk_round(gen_random_uuid(), 'up', 100::numeric) $$, '42501', NULL, 'authenticated cannot call open_kiosk_round');
select throws_ok($$ select public.settle_kiosk_round(gen_random_uuid(), 100::numeric) $$, '42501', NULL, 'authenticated cannot call settle_kiosk_round');
select throws_ok($$ select public.claim_prize('irrelevant-token', 'x@example.com', null::inet) $$, '42501', NULL, 'authenticated cannot call claim_prize');
select throws_ok($$ select public.release_expired_claims() $$, '42501', NULL, 'authenticated cannot call release_expired_claims');
reset role;

select * from finish();
rollback;
