-- Ticket C1: the kiosk visitor session. start_kiosk_session and reset_kiosk_session directly;
-- the same behaviour built inline into open_kiosk_round (idle-triggered fresh session, the
-- 'won'/'broke' terminal states refusing further play) and settle_kiosk_round (the web economy
-- applied to session_coins, the empty-coupon-pool rule leaving the session playing).
-- Runs in one transaction and rolls back, so the seeded 100 coupons are untouched afterwards.
begin;

select plan(41);

-- start_kiosk_session: a fresh session, playing, full coins, no streak ---------------------
select tests.create_kiosk('session-start', 'session-start-secret-00000') as k_start \gset
update public.kiosks set session_coins = 250, streak = 2, session_state = 'won' where id = :'k_start';
select public.start_kiosk_session(:'k_start'::uuid) as start_json \gset
select is((:'start_json'::json->>'coins')::int, 1000, 'start_kiosk_session resets coins to 1000');
select is((:'start_json'::json->>'streak')::int, 0, 'start_kiosk_session resets streak to 0');
select is((:'start_json'::json->>'state'), 'playing', 'start_kiosk_session leaves the session playing');
select is(
  (select session_state from public.kiosks where id = :'k_start'),
  'playing',
  'the kiosk row itself reflects the started session'
);

-- reset_kiosk_session: the kiosk_reset frame (Claim/Done) - back to attract mode -----------
select public.reset_kiosk_session(:'k_start'::uuid) as reset_json \gset
select is((:'reset_json'::json->>'coins')::int, 1000, 'reset_kiosk_session reports coins 1000');
select is((:'reset_json'::json->>'streak')::int, 0, 'reset_kiosk_session reports streak 0');
select is((:'reset_json'::json->>'state'), 'idle', 'reset_kiosk_session leaves the session idle');
select is(
  (select session_state from public.kiosks where id = :'k_start'),
  'idle',
  'the kiosk row itself is back to idle'
);

-- play down to broke: two lever-5 (stake 500) losses take a fresh session from 1000 to 0 ---
select tests.create_kiosk('session-broke', 'session-broke-secret-0000') as k_broke \gset
select (public.open_kiosk_round(:'k_broke'::uuid, 'up', 100, null, 5)->>'round_id')::uuid as rd_broke_1 \gset
select public.settle_kiosk_round(:'rd_broke_1'::uuid, 99) as settle_broke_1 \gset
select is((:'settle_broke_1'::json->>'outcome'), 'lose', 'first stake-500 round is a loss');
select is((:'settle_broke_1'::json->>'coins')::int, 500, '1000 - stake(500)');
select is((:'settle_broke_1'::json->>'state'), 'playing', '500 coins left: still playing');

select (public.open_kiosk_round(:'k_broke'::uuid, 'up', 100, null, 5)->>'round_id')::uuid as rd_broke_2 \gset
select public.settle_kiosk_round(:'rd_broke_2'::uuid, 99) as settle_broke_2 \gset
select is((:'settle_broke_2'::json->>'coins')::int, 0, '500 - stake(500) floors at 0');
select is((:'settle_broke_2'::json->>'state'), 'broke', 'under 100 coins ends the session as broke');

select throws_like(
  $$ select public.open_kiosk_round('$$ || :'k_broke' || $$'::uuid, 'up', 100) $$,
  '%session_over%',
  'a broke session refuses another round until it is reset'
);

-- insufficient_coins: a stake bigger than the session's coins marks it broke and reports the
-- error via the return value rather than raising - a plain raise here would undo the mark in
-- the same statement, exactly like verify_otp_code's documented case ----------------------
select tests.create_kiosk('session-insufficient', 'session-insufficient-secret') as k_insuf \gset
update public.kiosks set session_coins = 150, session_state = 'playing' where id = :'k_insuf';
select public.open_kiosk_round(:'k_insuf'::uuid, 'up', 100, null, 5) as open_insuf \gset
select is(
  (:'open_insuf'::json->>'error'),
  'insufficient_coins',
  'a stake (500) larger than the session''s coins (150) is reported as insufficient_coins'
);
select is(
  (select session_state from public.kiosks where id = :'k_insuf'),
  'broke',
  'the broke mark survives even though the call returned an error instead of raising'
);
select throws_like(
  $$ select public.open_kiosk_round('$$ || :'k_insuf' || $$'::uuid, 'up', 100) $$,
  '%session_over%',
  'a session marked broke by insufficient_coins also refuses another round until it is reset'
);

-- play to won: the 5th win claims a coupon and ends the session as won ---------------------
update public.coupons set status = 'claimed', claimed_at = now() where status = 'available';
insert into public.coupons (code) values ('C1-TEST-CODE');
select tests.create_kiosk('session-won', 'session-won-secret-00000') as k_won \gset
update public.kiosks set streak = 4, session_state = 'playing' where id = :'k_won';
select (public.open_kiosk_round(:'k_won'::uuid, 'up', 100)->>'round_id')::uuid as rd_won \gset
select public.settle_kiosk_round(:'rd_won'::uuid, 101) as settle_won \gset
select is((:'settle_won'::json->>'coupon'), 'C1-TEST-CODE', 'the 5th win claims the one available coupon');
select is((:'settle_won'::json->>'state'), 'won', 'claiming the coupon ends the session as won');

select throws_like(
  $$ select public.open_kiosk_round('$$ || :'k_won' || $$'::uuid, 'up', 100) $$,
  '%session_over%',
  'a won session refuses another round until it is reset'
);

-- coupons_exhausted: a round already open when the pool empties still settles normally
-- (docs/layers.md C8) - open_kiosk_round now refuses a NEW round outright with an empty pool
-- (below), so this round opens while one coupon is still there, and the pool is emptied out
-- from under it before settling, same as a concurrent kiosk taking the last code mid-round.
insert into public.coupons (code) values ('C8-EXHAUST-TEMP');
select tests.create_kiosk('session-exhausted', 'session-exhausted-secret') as k_exh \gset
update public.kiosks set streak = 4, session_state = 'playing' where id = :'k_exh';
select (public.open_kiosk_round(:'k_exh'::uuid, 'up', 100)->>'round_id')::uuid as rd_exh \gset
update public.coupons set status = 'claimed', claimed_at = now() where status = 'available';
select public.settle_kiosk_round(:'rd_exh'::uuid, 101) as settle_exh \gset
select ok((:'settle_exh'::json->>'coupon') is null, 'no coupon left in the pool to claim');
select is((:'settle_exh'::json->>'coupons_exhausted'), 'true', 'reported as exhausted');
select is((:'settle_exh'::json->>'streak')::int, 5, 'the streak is kept, not reset, when the pool is empty');
select is((:'settle_exh'::json->>'state'), 'playing', 'the session keeps playing when exhausted');

-- ticket C8: codes_left rides along on start/reset_kiosk_session, and open_kiosk_round refuses
-- outright while the pool is empty, recovering by itself once staff load a coupon -----------
-- the pool is still empty here (the coupons_exhausted block above just claimed the last one)
select tests.create_kiosk('session-codes-left', 'session-codes-left-secret') as k_codes \gset
select public.start_kiosk_session(:'k_codes'::uuid) as codes_start_json \gset
select is(
  (:'codes_start_json'::json->>'codes_left')::int, 0,
  'start_kiosk_session reports codes_left 0 when the pool is empty'
);

select throws_like(
  $$ select public.open_kiosk_round('$$ || :'k_codes' || $$'::uuid, 'up', 100) $$,
  '%coupons_exhausted%',
  'open_kiosk_round refuses to open any round while the pool is empty'
);

insert into public.coupons (code) values ('C8-RESTOCK-CODE');
select public.reset_kiosk_session(:'k_codes'::uuid) as codes_reset_json \gset
select is(
  (:'codes_reset_json'::json->>'codes_left')::int, 1,
  'reset_kiosk_session reports codes_left 1 once a coupon is restocked'
);

select lives_ok(
  $$ select public.open_kiosk_round('$$ || :'k_codes' || $$'::uuid, 'up', 100) $$,
  'open_kiosk_round opens again once a coupon is available'
);

-- the 60 s idle rule resets the whole session, coins included, not only the streak --------
select tests.create_kiosk('session-idle', 'session-idle-secret-00000') as k_idle \gset
update public.kiosks set session_coins = 300, streak = 2, session_state = 'playing',
  last_round_at = now() - interval '61 seconds' where id = :'k_idle';
select (public.open_kiosk_round(:'k_idle'::uuid, 'up', 100)->>'round_id')::uuid as rd_idle \gset
select is(
  (select session_coins from public.kiosks where id = :'k_idle'),
  1000,
  'an idle-triggered session reset restores coins to 1000, not only the streak'
);
select is(
  (select streak from public.kiosks where id = :'k_idle'),
  0,
  'an idle-triggered session reset also clears the streak'
);
select is(
  (select session_state from public.kiosks where id = :'k_idle'),
  'playing',
  'the fresh session is playing'
);

-- D1 (docs/reports/redteam.md): reset_kiosk_session and start_kiosk_session void any round
-- still open for that kiosk, so a late settle can never re-base its delta onto the next
-- session's fresh pot or drag the screen back out of attract mode -------------------------
select tests.create_kiosk('session-d1-reset', 'session-d1-reset-secret00') as k_d1_reset \gset
update public.kiosks set session_coins = 200, streak = 0, session_state = 'playing',
  last_round_at = now() where id = :'k_d1_reset';
select (public.open_kiosk_round(:'k_d1_reset'::uuid, 'up', 100)->>'round_id')::uuid as rd_d1_reset \gset
select public.reset_kiosk_session(:'k_d1_reset'::uuid) as reset_d1_json \gset
select is(
  (select status from public.rounds where id = :'rd_d1_reset'),
  'settled',
  'reset_kiosk_session voids the round it was standing on'
);
select is(
  (select outcome from public.rounds where id = :'rd_d1_reset'),
  'void',
  'the voided round''s outcome is void'
);
select is(
  (select session_coins from public.kiosks where id = :'k_d1_reset'),
  1000,
  'the reset itself still applies its own fresh-session coins'
);
select throws_like(
  $$ select public.settle_kiosk_round('$$ || :'rd_d1_reset' || $$'::uuid, 101) $$,
  '%round_not_open%',
  'a late settle on the voided round raises round_not_open, exactly like any other settled round'
);
select is(
  (select session_coins from public.kiosks where id = :'k_d1_reset'),
  1000,
  'the failed late settle changed no coins - the reset''s fresh pot is untouched'
);
select is(
  (select session_state from public.kiosks where id = :'k_d1_reset'),
  'idle',
  'the failed late settle did not drag the session back out of attract mode'
);

select tests.create_kiosk('session-d1-start', 'session-d1-start-secret00') as k_d1_start \gset
update public.kiosks set session_coins = 700, streak = 2, session_state = 'playing',
  last_round_at = now() where id = :'k_d1_start';
select (public.open_kiosk_round(:'k_d1_start'::uuid, 'up', 100)->>'round_id')::uuid as rd_d1_start \gset
select public.start_kiosk_session(:'k_d1_start'::uuid) as start_d1_json \gset
select is(
  (select status from public.rounds where id = :'rd_d1_start'),
  'settled',
  'start_kiosk_session also voids the round it was standing on'
);
select is(
  (select outcome from public.rounds where id = :'rd_d1_start'),
  'void',
  'the voided round''s outcome is void'
);
select throws_like(
  $$ select public.settle_kiosk_round('$$ || :'rd_d1_start' || $$'::uuid, 101) $$,
  '%round_not_open%',
  'a late settle after start_kiosk_session also raises round_not_open'
);
select is(
  (select session_coins from public.kiosks where id = :'k_d1_start'),
  1000,
  'the failed late settle changed no coins on the freshly started session'
);

select * from finish();
rollback;
