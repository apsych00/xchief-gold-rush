-- Invariant: the Nth consecutive kiosk win (public.settings 'kiosk_streak_target', ticket C9)
-- applies the same economy as settle_round to the kiosk's session_coins, RESERVES exactly one
-- coupon atomically and opens its one-time claim_links row, resets the kiosk streak to 0, and
-- ends the session ('won'). A coupon already reserved can never be handed to a second kiosk;
-- when the pool is empty, the box rule (docs/box-plan.md) keeps the streak, reports
-- coupons_exhausted, and leaves the session 'playing'.
begin;

select plan(25);

-- Leave exactly one coupon available so the "no double reservation" case is unambiguous.
insert into public.coupons (code) values ('TEST-0001') on conflict (code) do nothing;
update public.coupons set status = 'claimed', claimed_at = now() where code <> 'TEST-0001';
update public.coupons set status = 'available', claimed_at = null where code = 'TEST-0001';

select tests.create_kiosk('kiosk-one', 'kiosk-one-secret-0000000000') as kiosk_one \gset
select tests.create_kiosk('kiosk-two', 'kiosk-two-secret-0000000000') as kiosk_two \gset
-- Preset each kiosk one win short of the seeded default streak target (public.settings
-- 'kiosk_streak_target', db/seed.sql, currently 3) rather than a hardcoded number, so this file
-- exercises whatever the seeded default actually is.
select public.get_setting_int('kiosk_streak_target', 3)::int - 1 as streak_before \gset
update public.kiosks set streak = :streak_before, session_state = 'playing', session_coins = 1000
  where id in (:'kiosk_one', :'kiosk_two');

-- Both kiosks open their Nth-win round (N = the streak target) while the one coupon is still
-- available (docs/layers.md C8: open_kiosk_round now refuses a NEW round outright once the pool
-- is empty, so kiosk two's round has to be opened here, before kiosk one's settle below reserves
-- the only code - a round already open when the pool empties still settles normally, which is
-- exactly what this file is testing for kiosk two).
select (public.open_kiosk_round(:'kiosk_one'::uuid, 'up', 100)->>'round_id')::uuid as round_one_id \gset
select (public.open_kiosk_round(:'kiosk_two'::uuid, 'up', 100)->>'round_id')::uuid as round_two_id \gset

-- Kiosk one's Nth win reserves the one remaining coupon, opens its claim link, resets its
-- streak, and ends the session.
select public.settle_kiosk_round(:'round_one_id'::uuid, 101) as settle_one \gset
select is((:'settle_one'::json->>'outcome'), 'win', 'kiosk one wins its Nth round in a row');
select is((:'settle_one'::json->>'streak')::int, 0, 'the coupon win resets kiosk one''s streak to 0');
select is(
  (:'settle_one'::json->>'mult')::numeric, public.combo_mult(:streak_before),
  'the Nth win pays combo_mult(streak_before) (mult applies to the streak BEFORE this round)'
);
select is(
  (:'settle_one'::json->>'delta')::int, round(100 * public.combo_mult(:streak_before))::int,
  'delta is round(stake 100 x mult)'
);
select is(
  (:'settle_one'::json->>'coins')::int, 1000 + round(100 * public.combo_mult(:streak_before))::int,
  'session_coins carries the win'
);
select is((:'settle_one'::json->>'state'), 'won', 'a reserved coupon ends the session as won');
select ok((:'settle_one'::json->>'claim_token') is not null, 'the win returns a claim token, never a code');
select ok((:'settle_one'::json->>'claim_expires_at') is not null, 'the win returns the claim link''s expiry');
-- The gift card is a 30-day card: server/otp.js stamps the emailed expiry 30 days out and the
-- email copy says so. The link that turns a reserved coupon into that card used to lapse after
-- 24 hours, which meant a visitor who did not enter their email the same day lost the prize
-- outright. The two windows must agree, so this pins the one the database owns.
select ok(
  (:'settle_one'::json->>'claim_expires_at')::timestamptz between now() + interval '29 days' and now() + interval '31 days',
  'the claim link is good for 30 days, matching the gift card''s own validity'
);
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

-- Kiosk two also reaches its Nth win, but no coupon is left: it must not get kiosk one's
-- reservation. Per the box rule, an empty pool keeps the streak, reports coupons_exhausted, and
-- the session stays playing (the visitor keeps the coins they just won). Its round was already
-- opened above, alongside kiosk one's, while the coupon was still there.
select public.settle_kiosk_round(:'round_two_id'::uuid, 101) as settle_two \gset
select is((:'settle_two'::json->>'outcome'), 'win', 'kiosk two also wins its Nth round in a row');
select is(
  (:'settle_two'::json->>'streak')::int, :streak_before + 1,
  'kiosk two''s streak is kept at the reached target when the pool is empty (box rule)'
);
select is((:'settle_two'::json->>'coupons_exhausted'), 'true', 'an empty pool is reported as coupons_exhausted');
select ok((:'settle_two'::json->>'claim_token') is null, 'kiosk two gets no claim token: nothing left to reserve');

-- The pool is empty after kiosk one and two above; open_kiosk_round refuses ANY new round while
-- it is empty (docs/layers.md C8), so the two cases below need a coupon in the pool again even
-- though neither of them actually reaches the streak target and consumes it.
insert into public.coupons (code) values ('TEST-0002') on conflict (code) do nothing;

-- A win that lands one short of the streak target must not release a coupon (the boundary the
-- kiosk-streak-3 change is really about: nothing releases early).
select tests.create_kiosk('kiosk-three', 'kiosk-three-secret-000000') as kiosk_three \gset
update public.kiosks set streak = greatest(:streak_before - 1, 0), session_state = 'playing', session_coins = 1000
  where id = :'kiosk_three';
select (public.open_kiosk_round(:'kiosk_three'::uuid, 'up', 100)->>'round_id')::uuid as round_three_id \gset
select public.settle_kiosk_round(:'round_three_id'::uuid, 101) as settle_three \gset
select is((:'settle_three'::json->>'outcome'), 'win', 'kiosk three wins one round short of the streak target');
select is(
  (:'settle_three'::json->>'streak')::int, :streak_before,
  'the streak advances but stays below the target'
);
select ok(
  (:'settle_three'::json->>'claim_token') is null,
  'no coupon is reserved before the streak target is reached'
);
select is(
  (:'settle_three'::json->>'coupons_exhausted'), 'false',
  'the pool is not reported exhausted: reservation was never attempted'
);

-- A loss resets the streak to 0 even one win short of the target, and never reserves a coupon.
select tests.create_kiosk('kiosk-four', 'kiosk-four-secret-0000000') as kiosk_four \gset
update public.kiosks set streak = :streak_before, session_state = 'playing', session_coins = 1000
  where id = :'kiosk_four';
select (public.open_kiosk_round(:'kiosk_four'::uuid, 'up', 100)->>'round_id')::uuid as round_four_id \gset
select public.settle_kiosk_round(:'round_four_id'::uuid, 99) as settle_four \gset
select is((:'settle_four'::json->>'outcome'), 'lose', 'kiosk four loses the round');
select is(
  (:'settle_four'::json->>'streak')::int, 0,
  'a loss resets the streak to 0, even one win short of the target'
);
select ok((:'settle_four'::json->>'claim_token') is null, 'a loss never reserves a coupon');

select * from finish();
rollback;
