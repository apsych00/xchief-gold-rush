-- Invariant: the Nth consecutive kiosk win (public.settings 'kiosk_streak_target', ticket C9)
-- applies the same economy as settle_round to the kiosk's session_coins, RESERVES exactly one
-- coupon atomically and opens its one-time claim_links row, resets the kiosk streak to 0, and
-- ends the session ('won'). A coupon already reserved can never be handed to a second kiosk;
-- when the pool is empty, the box rule (docs/box-plan.md) keeps the streak, reports
-- coupons_exhausted, and leaves the session 'playing'.
begin;

select plan(17);

-- Leave exactly one coupon available so the "no double reservation" case is unambiguous.
insert into public.coupons (code) values ('TEST-0001') on conflict (code) do nothing;
update public.coupons set status = 'claimed', claimed_at = now() where code <> 'TEST-0001';
update public.coupons set status = 'available', claimed_at = null where code = 'TEST-0001';

select tests.create_kiosk('kiosk-one', 'kiosk-one-secret-0000000000') as kiosk_one \gset
select tests.create_kiosk('kiosk-two', 'kiosk-two-secret-0000000000') as kiosk_two \gset
update public.kiosks set streak = 4, session_state = 'playing', session_coins = 1000
  where id in (:'kiosk_one', :'kiosk_two');

-- Both kiosks open their 5th-win round while the one coupon is still available (docs/layers.md
-- C8: open_kiosk_round now refuses a NEW round outright once the pool is empty, so kiosk two's
-- round has to be opened here, before kiosk one's settle below reserves the only code - a round
-- already open when the pool empties still settles normally, which is exactly what this file
-- is testing for kiosk two).
select (public.open_kiosk_round(:'kiosk_one'::uuid, 'up', 100)->>'round_id')::uuid as round_one_id \gset
select (public.open_kiosk_round(:'kiosk_two'::uuid, 'up', 100)->>'round_id')::uuid as round_two_id \gset

-- Kiosk one's 5th win reserves the one remaining coupon, opens its claim link, resets its
-- streak, and ends the session.
select public.settle_kiosk_round(:'round_one_id'::uuid, 101) as settle_one \gset
select is((:'settle_one'::json->>'outcome'), 'win', 'kiosk one wins its 5th round in a row');
select is((:'settle_one'::json->>'streak')::int, 0, 'the coupon win resets kiosk one''s streak to 0');
select is(
  (:'settle_one'::json->>'mult')::numeric, 3::numeric,
  'the 5th win pays the streak-3+ multiplier (mult applies to the streak BEFORE this round)'
);
select is((:'settle_one'::json->>'delta')::int, 300, 'delta is round(stake 100 x mult 3)');
select is((:'settle_one'::json->>'coins')::int, 1300, 'session_coins carries the win');
select is((:'settle_one'::json->>'state'), 'won', 'a reserved coupon ends the session as won');
select ok((:'settle_one'::json->>'claim_token') is not null, 'the win returns a claim token, never a code');
select ok((:'settle_one'::json->>'claim_expires_at') is not null, 'the win returns the claim link''s expiry');
select is(
  (select status from public.coupons where code = 'TEST-0001'),
  'reserved',
  'the coupon is reserved, not claimed, at the moment of the win'
);
select is(
  (select claimed_by_kiosk from public.coupons where code = 'TEST-0001'),
  :'kiosk_one'::uuid,
  'the coupon row records kiosk one as the reserving kiosk'
);
select is(
  (select cl.token from public.claim_links cl join public.coupons c on c.id = cl.coupon_id where c.code = 'TEST-0001'),
  (:'settle_one'::json->>'claim_token'),
  'the claim_links row''s token matches the one returned to the kiosk'
);
select is(
  (select kiosk_id from public.claim_links cl join public.coupons c on c.id = cl.coupon_id where c.code = 'TEST-0001'),
  :'kiosk_one'::uuid,
  'the claim link records which kiosk earned it'
);
select is(
  (select session_state from public.kiosks where id = :'kiosk_one'),
  'won',
  'the kiosk row itself is left in the won state'
);

-- Kiosk two also reaches a 5th win, but no coupon is left: it must not get kiosk one's
-- reservation. Per the box rule, an empty pool keeps the streak, reports coupons_exhausted, and
-- the session stays playing (the visitor keeps the coins they just won). Its round was already
-- opened above, alongside kiosk one's, while the coupon was still there.
select public.settle_kiosk_round(:'round_two_id'::uuid, 101) as settle_two \gset
select is((:'settle_two'::json->>'outcome'), 'win', 'kiosk two also wins its 5th round in a row');
select is((:'settle_two'::json->>'streak')::int, 5, 'kiosk two''s streak is kept at 5 when the pool is empty (box rule)');
select is((:'settle_two'::json->>'coupons_exhausted'), 'true', 'an empty pool is reported as coupons_exhausted');
select ok((:'settle_two'::json->>'claim_token') is null, 'kiosk two gets no claim token: nothing left to reserve');

select * from finish();
rollback;
