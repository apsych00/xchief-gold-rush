-- Invariant: the 5th consecutive kiosk win claims exactly one coupon atomically, resets the
-- kiosk streak to 0, and a coupon already claimed can never be handed to a second kiosk.
begin;

select plan(7);

-- Leave exactly one coupon available so the "no double claim" case is unambiguous.
insert into public.coupons (code) values ('TEST-0001') on conflict (code) do nothing;
update public.coupons set status = 'claimed', claimed_at = now() where code <> 'TEST-0001';

select tests.create_kiosk('kiosk-one', 'kiosk-one-secret-0000000000') as kiosk_one \gset
select tests.create_kiosk('kiosk-two', 'kiosk-two-secret-0000000000') as kiosk_two \gset
update public.kiosks set streak = 4 where id in (:'kiosk_one', :'kiosk_two');

-- Kiosk one's 5th win claims the one remaining coupon and resets its streak.
select (public.open_kiosk_round(:'kiosk_one'::uuid, 'up', 100)->>'round_id')::uuid as round_one_id \gset
select public.settle_kiosk_round(:'round_one_id'::uuid, 101) as settle_one \gset
select is((:'settle_one'::json->>'outcome'), 'win', 'kiosk one wins its 5th round in a row');
select is((:'settle_one'::json->>'streak')::int, 0, 'the coupon win resets kiosk one''s streak to 0');
select is((:'settle_one'::json->>'coupon'), 'TEST-0001', 'kiosk one claims the one available coupon');
select is(
  (select claimed_by_kiosk from public.coupons where code = 'TEST-0001'),
  :'kiosk_one'::uuid,
  'the coupon row records kiosk one as the claimant'
);

-- Kiosk two also reaches a 5th win, but no coupon is left: it must not get kiosk one's code.
select (public.open_kiosk_round(:'kiosk_two'::uuid, 'up', 100)->>'round_id')::uuid as round_two_id \gset
select public.settle_kiosk_round(:'round_two_id'::uuid, 101) as settle_two \gset
select is((:'settle_two'::json->>'outcome'), 'win', 'kiosk two also wins its 5th round in a row');
select is((:'settle_two'::json->>'streak')::int, 0, 'kiosk two''s streak still resets even with no coupon left');
select ok((:'settle_two'::json->>'coupon') is null, 'kiosk two cannot claim the code already given to kiosk one');

select * from finish();
rollback;
