-- Ticket K1: open kiosk provisioning. create_open_kiosk mints a label, hashes the secret,
-- and enforces a cap on active open kiosks. Runs in one transaction and rolls back so the
-- seeded kiosk is untouched afterwards.
begin;

select plan(9);

-- A fresh open kiosk has the expected label shape and a 32-char base64url secret ------------
select public.create_open_kiosk(50) as created \gset
select matches(
  :'created'::json->>'label',
  '^open-' || to_char(now(), 'YYYYMMDD') || '-[A-Za-z0-9_-]{4}$',
  'label starts with open-YYYYMMDD- and has a 4-char suffix'
);
select is(
  length(:'created'::json->>'secret'),
  32,
  'secret is 32 characters'
);
select matches(
  :'created'::json->>'secret',
  '^[A-Za-z0-9_-]{32}$',
  'secret is base64url (no padding, no plus, no slash)'
);

-- The secret returned authenticates the kiosk row (it was stored hashed, not plain) ----------
select is(
  public.verify_kiosk(:'created'::json->>'secret'),
  (:'created'::json->>'id')::uuid,
  'verify_kiosk resolves the newly created kiosk from its raw secret'
);

-- The row exists and is active ---------------------------------------------------------------
select is(
  (select status from public.kiosks where id = (:'created'::json->>'id')::uuid),
  'active',
  'the new kiosk row is active'
);

-- The secret hash is not the plain secret ----------------------------------------------------
select isnt(
  (select secret_hash from public.kiosks where id = (:'created'::json->>'id')::uuid),
  :'created'::json->>'secret',
  'secret_hash column does not contain the plain secret'
);

-- Cap: with p_max=1, a second call raises kiosk_cap ------------------------------------------
-- Revoke the first kiosk so the cap tests start from zero active open kiosks.
update public.kiosks set status = 'revoked' where id = (:'created'::json->>'id')::uuid;
select public.create_open_kiosk(1) as capped \gset
select throws_like(
  $$ select public.create_open_kiosk(1) $$,
  '%kiosk_cap%',
  'create_open_kiosk(1) refuses a second open kiosk'
);

-- A revoked open kiosk no longer counts toward the cap ---------------------------------------
update public.kiosks set status = 'revoked' where id = (:'capped'::json->>'id')::uuid;
select lives_ok(
  $$ select public.create_open_kiosk(1) $$,
  'revoking the only open kiosk frees the cap for one more'
);

-- Seeded (non-open) kiosks do not count toward the open cap ----------------------------------
-- Clear any open kiosks created by the cap tests so the only remaining active kiosk is seeded.
update public.kiosks set status = 'revoked' where label like 'open-%';
select tests.create_kiosk('seeded-cap-check', 'seeded-cap-check-secret-0000') as seeded_id \gset
select lives_ok(
  $$ select public.create_open_kiosk(1) $$,
  'a seeded kiosk does not count against the open-kiosk cap'
);

select * from finish();
rollback;
