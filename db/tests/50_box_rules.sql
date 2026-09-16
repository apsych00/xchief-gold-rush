-- Box rules (0008_box.sql): the 400/hr cap, rounds.source audit column, the 60 s kiosk idle
-- streak reset, and the empty-coupon-pool rule that keeps the streak and reports exhausted.
-- Runs in one transaction and rolls back, so the seeded 100 coupons are untouched afterwards.
begin;

select plan(14);

-- 400 rounds per player per rolling hour ----------------------------------
select tests.create_confirmed_player('ratelimit@example.com') as p_rate \gset
insert into public.rounds (player_id, dir, lever, stake, start_price, status, outcome)
select :'p_rate'::uuid, 'up', 1, 0, 100, 'settled', 'void'
from generate_series(1, 399);

select lives_ok(
  $$ select public.open_round('$$ || :'p_rate' || $$'::uuid, 'up', 1, 100) $$,
  'the 400th round in the hour opens without error'
);
select throws_like(
  $$ select public.open_round('$$ || :'p_rate' || $$'::uuid, 'up', 1, 100) $$,
  '%rate_limited%',
  'the 401st round in the hour raises rate_limited'
);

-- rounds.source recorded when passed, null when not -----------------------
select tests.create_confirmed_player('src-pass@example.com') as p_src \gset
select (public.open_round(:'p_src'::uuid, 'up', 1, 100, 'finnhub')->>'round_id')::uuid as rd_src \gset
select is(
  (select source from public.rounds where id = :'rd_src'),
  'finnhub',
  'rounds.source is stored when a source is passed'
);

select tests.create_confirmed_player('src-none@example.com') as p_nosrc \gset
select (public.open_round(:'p_nosrc'::uuid, 'up', 1, 100)->>'round_id')::uuid as rd_nosrc \gset
select ok(
  (select source from public.rounds where id = :'rd_nosrc') is null,
  'rounds.source is null when no source is passed'
);

-- kiosk streak resets after 60 s idle, holds inside 60 s ------------------
select tests.create_kiosk('idle-old', 'idle-old-secret-000000000000') as k_old \gset
update public.kiosks set streak = 3, last_round_at = now() - interval '61 seconds' where id = :'k_old';
select (public.open_kiosk_round(:'k_old'::uuid, 'up', 100)->>'round_id')::uuid as rd_old \gset
select is(
  (select streak from public.kiosks where id = :'k_old'),
  0,
  'a kiosk with its last round 61 s ago starts the next visitor at streak 0'
);

select tests.create_kiosk('idle-fresh', 'idle-fresh-secret-00000000000') as k_fresh \gset
update public.kiosks set streak = 3, last_round_at = now() - interval '30 seconds' where id = :'k_fresh';
select (public.open_kiosk_round(:'k_fresh'::uuid, 'up', 100)->>'round_id')::uuid as rd_fresh \gset
select is(
  (select streak from public.kiosks where id = :'k_fresh'),
  3,
  'a kiosk with its last round 30 s ago keeps its streak of 3'
);

-- 5th win with an empty pool: keep the streak, report exhausted -----------
update public.coupons set status = 'claimed', claimed_at = now() where status = 'available';
select tests.create_kiosk('no-coupon', 'no-coupon-secret-00000000000') as k_nocoup \gset
update public.kiosks set streak = 4 where id = :'k_nocoup';
select (public.open_kiosk_round(:'k_nocoup'::uuid, 'up', 100)->>'round_id')::uuid as rd_nocoup \gset
select public.settle_kiosk_round(:'rd_nocoup'::uuid, 101) as settle_nocoup \gset
select ok(
  (:'settle_nocoup'::json->>'coupon') is null,
  'a 5th win with no coupon available returns no coupon'
);
select is(
  (:'settle_nocoup'::json->>'coupons_exhausted'),
  'true',
  'a 5th win with an empty pool reports coupons_exhausted'
);
select is(
  (select streak from public.kiosks where id = :'k_nocoup'),
  5,
  'the 5-win streak is kept (not reset) when the pool is empty'
);

-- 5th win with one coupon available: hand it over, reset the streak -------
insert into public.coupons (code) values ('BOX-TEST-CODE');
select tests.create_kiosk('has-coupon', 'has-coupon-secret-0000000000') as k_coup \gset
update public.kiosks set streak = 4 where id = :'k_coup';
select (public.open_kiosk_round(:'k_coup'::uuid, 'up', 100)->>'round_id')::uuid as rd_coup \gset
select public.settle_kiosk_round(:'rd_coup'::uuid, 101) as settle_coup \gset
select is(
  (:'settle_coup'::json->>'coupon'),
  'BOX-TEST-CODE',
  'a 5th win claims the one available coupon'
);
select is(
  (:'settle_coup'::json->>'coupons_exhausted'),
  'false',
  'a successful claim is not reported as exhausted'
);
select is(
  (select streak from public.kiosks where id = :'k_coup'),
  0,
  'a successful claim resets the streak to 0'
);
select is(
  (:'settle_coup'::json->>'start_price')::numeric,
  100::numeric,
  'the settle json carries start_price'
);
select is(
  (:'settle_coup'::json->>'end_price')::numeric,
  101::numeric,
  'the settle json carries end_price'
);

select * from finish();
rollback;
