-- Invariant: get_me() carries email_verified and display alongside every existing column
-- (docs/layers.md C3, C4) - email_verified true exactly when players.email is set, display the
-- same masked form leaderboard() shows for everyone else.
begin;

select plan(4);

select tests.create_anonymous_player() as anon_id \gset
set local role authenticated;
select set_config('app.player_id', :'anon_id', true);

select is(
  (select email_verified from public.get_me()),
  false,
  'an anonymous player is not email_verified'
);
select is((select display from public.get_me()), null, 'an anonymous player has no display (no email to mask)');

reset role;

select tests.create_confirmed_player('me-confirmed@example.com') as confirmed_id \gset
set local role authenticated;
select set_config('app.player_id', :'confirmed_id', true);

select is(
  (select email_verified from public.get_me()),
  true,
  'a player with a confirmed email is email_verified'
);
select is(
  (select display from public.get_me()),
  'me-*****med@e**.com',
  'a confirmed player''s own display is their masked email'
);

reset role;

select * from finish();
rollback;
