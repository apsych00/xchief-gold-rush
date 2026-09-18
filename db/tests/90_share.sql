-- Share-my-record token and public lookup (ticket U4).
-- Invariants: the token is minted once, is unique, and get_share_by_token exposes only
-- display (masked email or "Guest"), record, rank, tier and tournament_title.

begin;

select plan(13);

-- ---- fixtures ----------------------------------------------------------------------------------
select tests.create_confirmed_player('share-confirmed@example.com') as confirmed \gset
select tests.create_anonymous_player() as anonymous \gset

-- Seed a running tournament so rank/tier can resolve.
delete from public.tournaments;
insert into public.tournaments (id, title, starts_at, ends_at, prize_title, prize_image)
values ('tt-share', 'Share Test', now() - interval '1 hour', now() + interval '1 hour', 'Prize', '/prizes/share.png');

-- Give the confirmed player a tournament score.
select public.open_round(:'confirmed'::uuid, 'up', 1, 100) as opened \gset
select public.settle_round((:'opened'::jsonb->>'round_id')::uuid, 101);

-- ---- token minting -----------------------------------------------------------------------------
select public.get_or_create_share_token(:'confirmed'::uuid) as token1 \gset
select ok(:'token1' ~ '^[A-Za-z0-9_-]{12}$', 'share token is 12 base64url characters');

select public.get_or_create_share_token(:'confirmed'::uuid) as token2 \gset
select is(:'token2'::text, :'token1'::text, 'second call returns the same token - never rotated');

select public.get_or_create_share_token(:'anonymous'::uuid) as token3 \gset
select isnt(:'token3'::text, :'token1'::text, 'a different player gets a different token');

-- ---- uniqueness --------------------------------------------------------------------------------
select tests.create_anonymous_player() as other \gset
select throws_ok(
  format($f$update public.players set share_token = '%s' where id = '%s'::uuid$f$, :'token1', :'other'),
  '23505',
  null,
  'two players cannot share the same share_token'
);

-- ---- get_share_by_token for a verified player --------------------------------------------------
select public.get_share_by_token(:'token1') as payload \gset
select is((:'payload'::jsonb->>'display'), 's****d@example.com', 'verified player display is the masked email');
select ok((:'payload'::jsonb->>'record')::int > 0, 'record is included');
select is((:'payload'::jsonb->>'rank')::int, 1, 'rank is computed from the current tournament');
select ok((:'payload'::jsonb->>'tier') is not null, 'tier is included when ranked');
select is((:'payload'::jsonb->>'tournament_title'), 'Share Test', 'tournament title is included');
select ok((:'payload'::jsonb->>'email') is null, 'raw email is never exposed in the payload');

-- ---- get_share_by_token for an anonymous player ------------------------------------------------
select public.get_share_by_token(:'token3') as anon_payload \gset
select is((:'anon_payload'::jsonb->>'display'), 'Guest', 'anonymous player display is "Guest"');
select ok((:'anon_payload'::jsonb->>'rank') is null, 'anonymous player has no rank');

-- ---- get_share_by_token for an unknown token ---------------------------------------------------
select is(public.get_share_by_token('this-token-does-not-exist'), null, 'unknown token returns null');

select * from finish();
rollback;
