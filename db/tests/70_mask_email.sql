-- Invariant: public.mask_email() is the single source of truth for the masked email shape
-- shown on the leaderboard, in get_me()'s `display`, and in claim_prize's `email_masked`
-- (docs/layers.md C3, C4; ticket K5). A raw address never leaves the server.
begin;

select plan(14);

select is(public.mask_email(null), null, 'a null email masks to null');
select is(public.mask_email('not-an-email'), null, 'an address with no @ masks to null');

-- one- and two-character local parts: first character only, no distinct last character -------
select is(public.mask_email('a@x.io'), 'a***@x**.io', 'one-char local part masks to first char + ***; non-consumer domain masks first label');
select is(public.mask_email('ab@x.io'), 'a***@x**.io', 'two-char local part shows only the first character, not the second');

-- 3..5 characters: first char + *** + last char ---------------------------------------------
select is(public.mask_email('abc@x.io'), 'a***c@x**.io', 'three-char local part keeps first and last with three asterisks');
select is(public.mask_email('farid@acme-corp.co'), 'f***d@a**.co', 'five-char local part plus a hyphenated company domain masks the first label only');

-- 6..9 characters: first 2 + **** + last 2 --------------------------------------------------
select is(public.mask_email('kayani@gmail.com'), 'ka****ni@gmail.com', 'six-char local part on a consumer domain shows full domain');
select is(public.mask_email('kayani@x.io'), 'ka****ni@x**.io', 'six-char local part on a non-consumer domain masks the first label');

-- n >= 10: first 3 + ***** + last 3 ---------------------------------------------------------
select is(
  public.mask_email('pedram.adsency@gmail.com'),
  'ped*****ncy@gmail.com',
  'long local part on a consumer domain keeps first 3, last 3, full domain'
);
select is(
  public.mask_email('a+very-long-tag@example.com'),
  'a+v*****tag@e**.com',
  'plus-address local part on a non-consumer domain masks the first label'
);

-- unicode local parts count characters, not bytes -------------------------------------------
select is(public.mask_email('用户名@x.io'), '用***名@x**.io', 'a three-character unicode local part masks by character');

-- subdomain: only the first label is masked, the rest is kept intact ------------------------
select is(public.mask_email('a@sub.example.com'), 'a***@s**.example.com', 'subdomain domain masks only its first label');

-- consumer domain matching is case-insensitive; case is preserved ---------------------------
select is(public.mask_email('KAYANI@GMAIL.COM'), 'KA****NI@GMAIL.COM', 'consumer-domain check is case-insensitive and preserves original casing');

-- edge: a domain with no dot masks its only label -------------------------------------------
select is(public.mask_email('a@localhost'), 'a***@l**', 'a domain with no dot masks its single label');

select * from finish();
rollback;
