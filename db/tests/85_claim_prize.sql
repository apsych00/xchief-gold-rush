-- Ticket C9 (docs/tickets/c9-qr-claim.md): claim_prize() is the only place a coupon's code is
-- ever read back out, exactly once, from a claim_links token nobody but the visitor holds; the
-- 60 s sweep's release_expired_claims() is what returns a stale reservation to the pool; and
-- settle_kiosk_round reads its win-streak target from public.settings, not a hardcoded 5.
begin;

select plan(15);

-- claim_prize: happy path, then a second call on the same token is refused --------------------
insert into public.coupons (code) values ('CLAIM-TEST-0001') on conflict (code) do nothing;
select tests.create_kiosk('claim-one', 'claim-one-secret-000000000') as k_claim \gset
insert into public.claim_links (token, coupon_id, kiosk_id, expires_at)
values (
  'claim-token-happy-path-0000000000000000000000',
  (select id from public.coupons where code = 'CLAIM-TEST-0001'),
  :'k_claim'::uuid,
  now() + interval '24 hours'
);
update public.coupons set status = 'reserved', claimed_by_kiosk = :'k_claim'::uuid where code = 'CLAIM-TEST-0001';

select public.claim_prize('claim-token-happy-path-0000000000000000000000', 'winner@example.com', '203.0.113.9'::inet)
  as claim_result \gset
select is((:'claim_result'::json->>'code'), 'CLAIM-TEST-0001', 'claim_prize returns the coupon''s own code');
select is(
  (select status from public.coupons where code = 'CLAIM-TEST-0001'),
  'claimed',
  'the coupon itself is marked claimed'
);
select is(
  (select email from public.claim_links where token = 'claim-token-happy-path-0000000000000000000000'),
  'winner@example.com',
  'the claim link records the visitor''s own email'
);
select isnt(
  (select claimed_at from public.claim_links where token = 'claim-token-happy-path-0000000000000000000000'),
  null,
  'the claim link records when it was claimed'
);

select throws_like(
  $$ select public.claim_prize('claim-token-happy-path-0000000000000000000000', 'second@example.com', '203.0.113.9'::inet) $$,
  '%already_claimed%',
  'a second claim on the same token is refused'
);
select is(
  (select email from public.claim_links where token = 'claim-token-happy-path-0000000000000000000000'),
  'winner@example.com',
  'the refused second attempt does not overwrite the first claimant''s email'
);

-- claim_prize: an unknown token is invalid, never a silent success ----------------------------
select throws_like(
  $$ select public.claim_prize('this-token-was-never-issued-by-any-win', 'nobody@example.com', null::inet) $$,
  '%claim_invalid%',
  'a token that names no claim link is refused as invalid'
);

-- claim_prize: an expired link is refused, and the underlying coupon is untouched -------------
insert into public.coupons (code) values ('CLAIM-TEST-EXPIRED') on conflict (code) do nothing;
insert into public.claim_links (token, coupon_id, kiosk_id, expires_at)
values (
  'claim-token-already-expired-00000000000000000',
  (select id from public.coupons where code = 'CLAIM-TEST-EXPIRED'),
  :'k_claim'::uuid,
  now() - interval '1 hour'
);
update public.coupons set status = 'reserved', claimed_by_kiosk = :'k_claim'::uuid where code = 'CLAIM-TEST-EXPIRED';
select throws_like(
  $$ select public.claim_prize('claim-token-already-expired-00000000000000000', 'late@example.com', null::inet) $$,
  '%claim_link_expired%',
  'a link past its own expires_at is refused as expired'
);
select is(
  (select status from public.coupons where code = 'CLAIM-TEST-EXPIRED'),
  'reserved',
  'a refused expired claim leaves the coupon exactly as it was - the sweep is what releases it'
);

-- release_expired_claims: the 60 s sweep's own function releases a stale reservation ----------
insert into public.coupons (code) values ('CLAIM-TEST-SWEEP') on conflict (code) do nothing;
insert into public.claim_links (token, coupon_id, kiosk_id, expires_at)
values (
  'claim-token-for-the-sweep-000000000000000000000',
  (select id from public.coupons where code = 'CLAIM-TEST-SWEEP'),
  :'k_claim'::uuid,
  now() - interval '1 minute'
);
update public.coupons set status = 'reserved', claimed_by_kiosk = :'k_claim'::uuid where code = 'CLAIM-TEST-SWEEP';

-- CLAIM-TEST-EXPIRED above is also still reserved and past its own expires_at at this point (its
-- own claim_prize call was refused, not released - the refusal deliberately leaves the sweep as
-- the only thing that ever releases it), so one sweep pass here releases both it and this test's
-- own CLAIM-TEST-SWEEP row.
select is(public.release_expired_claims()::int, 2, 'release_expired_claims releases every stale reservation, not only this test''s own');
select is(
  (select status from public.coupons where code = 'CLAIM-TEST-SWEEP'),
  'available',
  'the released coupon is available again'
);
select isnt(
  (select expired_at from public.claim_links where token = 'claim-token-for-the-sweep-000000000000000000000'),
  null,
  'the expired link itself is kept, marked expired_at, for the audit'
);
select is(public.release_expired_claims()::int, 0, 'running the sweep again releases nothing more');
select throws_like(
  $$ select public.claim_prize('claim-token-for-the-sweep-000000000000000000000', 'toolate@example.com', null::inet) $$,
  '%claim_link_expired%',
  'the now-released link itself still refuses a claim'
);

-- settle_kiosk_round reads its streak target from public.settings, not a hardcoded 5 ----------
update public.settings set value = '2' where key = 'kiosk_streak_target';
insert into public.coupons (code) values ('CLAIM-TEST-TARGET') on conflict (code) do nothing;
update public.coupons set status = 'claimed', claimed_at = now() where status = 'available' and code <> 'CLAIM-TEST-TARGET';
select tests.create_kiosk('claim-target', 'claim-target-secret-000000') as k_target \gset
update public.kiosks set streak = 1, session_state = 'playing' where id = :'k_target';
select (public.open_kiosk_round(:'k_target'::uuid, 'up', 100)->>'round_id')::uuid as rd_target \gset
select public.settle_kiosk_round(:'rd_target'::uuid, 101) as settle_target \gset
select ok(
  (:'settle_target'::json->>'claim_token') is not null,
  'a target of 2 (public.settings) reserves the coupon on the 2nd win, not the 5th'
);
update public.settings set value = '5' where key = 'kiosk_streak_target';

select * from finish();
rollback;
