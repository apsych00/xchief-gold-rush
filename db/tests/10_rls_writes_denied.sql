-- Invariant: anon and authenticated can never write players, rounds, kiosks or coupons.
-- Every mutation must go through a SECURITY DEFINER function or the service role.
begin;

select plan(24);

-- players -------------------------------------------------------------------
set local role anon;
select throws_ok($$ insert into public.players (id) values (gen_random_uuid()) $$, '42501', NULL, 'anon cannot insert players');
select throws_ok($$ update public.players set display_name = 'x' where false $$, '42501', NULL, 'anon cannot update players');
select throws_ok($$ delete from public.players where false $$, '42501', NULL, 'anon cannot delete players');
reset role;

set local role authenticated;
select throws_ok($$ insert into public.players (id) values (gen_random_uuid()) $$, '42501', NULL, 'authenticated cannot insert players');
select throws_ok($$ update public.players set display_name = 'x' where false $$, '42501', NULL, 'authenticated cannot update players');
select throws_ok($$ delete from public.players where false $$, '42501', NULL, 'authenticated cannot delete players');
reset role;

-- rounds ----------------------------------------------------------------------
set local role anon;
select throws_ok($$ insert into public.rounds (dir, lever, start_price, kiosk_id) values ('up', 1, 100, gen_random_uuid()) $$, '42501', NULL, 'anon cannot insert rounds');
select throws_ok($$ update public.rounds set outcome = 'win' where false $$, '42501', NULL, 'anon cannot update rounds');
select throws_ok($$ delete from public.rounds where false $$, '42501', NULL, 'anon cannot delete rounds');
reset role;

set local role authenticated;
select throws_ok($$ insert into public.rounds (dir, lever, start_price, kiosk_id) values ('up', 1, 100, gen_random_uuid()) $$, '42501', NULL, 'authenticated cannot insert rounds');
select throws_ok($$ update public.rounds set outcome = 'win' where false $$, '42501', NULL, 'authenticated cannot update rounds');
select throws_ok($$ delete from public.rounds where false $$, '42501', NULL, 'authenticated cannot delete rounds');
reset role;

-- kiosks ------------------------------------------------------------------------
set local role anon;
select throws_ok($$ insert into public.kiosks (label, secret_hash) values ('x', 'y') $$, '42501', NULL, 'anon cannot insert kiosks');
select throws_ok($$ update public.kiosks set status = 'revoked' where false $$, '42501', NULL, 'anon cannot update kiosks');
select throws_ok($$ delete from public.kiosks where false $$, '42501', NULL, 'anon cannot delete kiosks');
reset role;

set local role authenticated;
select throws_ok($$ insert into public.kiosks (label, secret_hash) values ('x', 'y') $$, '42501', NULL, 'authenticated cannot insert kiosks');
select throws_ok($$ update public.kiosks set status = 'revoked' where false $$, '42501', NULL, 'authenticated cannot update kiosks');
select throws_ok($$ delete from public.kiosks where false $$, '42501', NULL, 'authenticated cannot delete kiosks');
reset role;

-- coupons -----------------------------------------------------------------------
set local role anon;
select throws_ok($$ insert into public.coupons (code) values ('anon-forged-code') $$, '42501', NULL, 'anon cannot insert coupons');
select throws_ok($$ update public.coupons set status = 'claimed' where false $$, '42501', NULL, 'anon cannot update coupons');
select throws_ok($$ delete from public.coupons where false $$, '42501', NULL, 'anon cannot delete coupons');
reset role;

set local role authenticated;
select throws_ok($$ insert into public.coupons (code) values ('auth-forged-code') $$, '42501', NULL, 'authenticated cannot insert coupons');
select throws_ok($$ update public.coupons set status = 'claimed' where false $$, '42501', NULL, 'authenticated cannot update coupons');
select throws_ok($$ delete from public.coupons where false $$, '42501', NULL, 'authenticated cannot delete coupons');
reset role;

select * from finish();
rollback;
