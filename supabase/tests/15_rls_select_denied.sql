-- Invariant: kiosks and coupons are service-role only. No client role can even read them,
-- because a leaked kiosk id/secret_hash or a peek at unclaimed codes defeats the coupon flow.
begin;

select plan(4);

set local role anon;
select throws_ok($$ select 1 from public.kiosks limit 1 $$, '42501', NULL, 'anon cannot select kiosks');
select throws_ok($$ select 1 from public.coupons limit 1 $$, '42501', NULL, 'anon cannot select coupons');
reset role;

set local role authenticated;
select throws_ok($$ select 1 from public.kiosks limit 1 $$, '42501', NULL, 'authenticated cannot select kiosks');
select throws_ok($$ select 1 from public.coupons limit 1 $$, '42501', NULL, 'authenticated cannot select coupons');
reset role;

select * from finish();
rollback;
