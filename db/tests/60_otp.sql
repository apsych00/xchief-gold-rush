-- Invariant: login codes (db/migrations/0011_otp_codes.sql, docs/box-plan.md 1.5) - an 8-digit
-- code is stored only as a hash, five wrong guesses lock it out, an expired code cannot verify,
-- and a right code never overwrites another player's already-confirmed email.
begin;

select plan(16);

-- request_otp_code returns an 8-digit code and stores only its hash --------
select tests.create_anonymous_player() as p1 \gset

select public.request_otp_code(:'p1'::uuid, 'otp1@example.com') as code1 \gset
select ok(:'code1' ~ '^[0-9]{8}$', 'request_otp_code returns an 8-digit numeric code');
select isnt(
  (select code_hash from public.otp_codes where email = 'otp1@example.com' order by created_at desc limit 1),
  :'code1',
  'the stored row holds a hash, not the plain code'
);

-- the right code verifies, sets players.email and confirms auth.users ------
select is(public.verify_otp_code(:'p1'::uuid, 'otp1@example.com', :'code1'), 'ok', 'the right code verifies');
select is(
  (select email from public.players where id = :'p1'::uuid),
  'otp1@example.com',
  'verify_otp_code sets players.email'
);
select ok(
  (select email_confirmed_at from auth.users where id = :'p1'::uuid) is not null,
  'verify_otp_code confirms the email on auth.users'
);

-- wrong code five times in a row locks the code out ------------------------
-- (verify_otp_code returns this outcome rather than raising it, so each wrong guess's
-- attempts increment survives to the next call - see the migration's comment.)
select tests.create_anonymous_player() as p2 \gset
select public.request_otp_code(:'p2'::uuid, 'otp2@example.com') as code2 \gset

select is(
  public.verify_otp_code(:'p2'::uuid, 'otp2@example.com', '00000000'),
  'invalid_code',
  'wrong guess 1 of 5 returns invalid_code'
);
select is(
  public.verify_otp_code(:'p2'::uuid, 'otp2@example.com', '00000000'),
  'invalid_code',
  'wrong guess 2 of 5 returns invalid_code'
);
select is(
  public.verify_otp_code(:'p2'::uuid, 'otp2@example.com', '00000000'),
  'invalid_code',
  'wrong guess 3 of 5 returns invalid_code'
);
select is(
  public.verify_otp_code(:'p2'::uuid, 'otp2@example.com', '00000000'),
  'invalid_code',
  'wrong guess 4 of 5 returns invalid_code'
);
select is(
  public.verify_otp_code(:'p2'::uuid, 'otp2@example.com', '00000000'),
  'too_many_attempts',
  'the 5th wrong guess returns too_many_attempts'
);
select is(
  (select attempts from public.otp_codes where email = 'otp2@example.com' order by created_at desc limit 1),
  5,
  'attempts is 5 after the lockout'
);
select ok(
  (select used_at from public.otp_codes where email = 'otp2@example.com' order by created_at desc limit 1) is not null,
  'too_many_attempts marks the code used so it cannot be tried again'
);

-- an expired code cannot verify, even with the right digits -----------------
select tests.create_anonymous_player() as p3 \gset
select public.request_otp_code(:'p3'::uuid, 'otp3@example.com') as code3 \gset
update public.otp_codes set expires_at = now() - interval '1 second' where email = 'otp3@example.com';

select throws_like(
  $$ select public.verify_otp_code('$$ || :'p3' || $$'::uuid, 'otp3@example.com', '$$ || :'code3' || $$') $$,
  '%expired_code%',
  'a code past its expiry raises expired_code even with the right digits'
);

-- a second player verifying an email already confirmed elsewhere is refused -
select tests.create_anonymous_player() as p4 \gset
select public.request_otp_code(:'p4'::uuid, 'shared@example.com') as code4 \gset
select is(
  public.verify_otp_code(:'p4'::uuid, 'shared@example.com', :'code4'),
  'ok',
  'the first player confirms shared@example.com'
);

select tests.create_anonymous_player() as p5 \gset
select public.request_otp_code(:'p5'::uuid, 'shared@example.com') as code5 \gset
select throws_like(
  $$ select public.verify_otp_code('$$ || :'p5' || $$'::uuid, 'shared@example.com', '$$ || :'code5' || $$') $$,
  '%email_taken%',
  'a second player verifying the right code for an already-confirmed email gets email_taken'
);
select ok(
  (select email from public.players where id = :'p5'::uuid) is null,
  'email_taken changes nothing on the second player'
);

select * from finish();
rollback;
