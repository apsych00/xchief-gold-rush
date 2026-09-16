-- Invariant: public.mask_email() is the one place the masked-email shape shown on the
-- leaderboard and in get_me()'s own `display` is computed (docs/layers.md C3, C4; product
-- default: "masked email keeps the first and last character of the local part and the full
-- domain, at least three asterisks between them; a one- or two-character local part shows the
-- first character and asterisks").
begin;

select plan(9);

select is(public.mask_email(null), null, 'a null email masks to null');

-- one- and two-character local parts: first character only, no distinct last character -------
select is(public.mask_email('a@x.com'), 'a***@x.com', 'a one-character local part shows the first character and asterisks');
select is(public.mask_email('ab@x.com'), 'a***@x.com', 'a two-character local part shows only the first character, not the second');

-- three-plus character local parts: first and last kept, at least three asterisks between ----
select is(public.mask_email('abc@x.com'), 'a***c@x.com', 'a three-character local part still gets at least three asterisks between first and last');
select is(
  public.mask_email('kayani@gmail.com'),
  'k****i@gmail.com',
  'a six-character local part shows its true middle length in asterisks (product default example)'
);

-- plus-addresses: the '+' is just another local-part character, not special-cased ------------
select is(public.mask_email('k+lb@gmail.com'), 'k***b@gmail.com', 'a plus-address masks like any other local part');
select is(
  public.mask_email('a+very-long-tag@example.com'),
  'a*************g@example.com',
  'a long plus-address keeps its true middle length'
);

-- case is left exactly as given - masking never normalizes it ---------------------------------
select is(public.mask_email('KAYANI@GMAIL.COM'), 'K****I@GMAIL.COM', 'masking preserves case on both local part and domain');

-- the full domain always survives untouched ----------------------------------------------------
select is(
  public.mask_email('k@sub.example.co.uk'),
  'k***@sub.example.co.uk',
  'the full domain, including subdomains, is never masked'
);

select * from finish();
rollback;
