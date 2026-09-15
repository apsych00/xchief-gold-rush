-- Invariant: only one round may be open per identity at a time - the anti-fraud control that
-- keeps a player from opening a second round to fish for a better outcome.
begin;

select plan(2);

select tests.create_confirmed_player('inflight@example.com') as player_id \gset
update public.players set coins = 5000 where id = :'player_id';

select lives_ok(
  $$ select public.open_round('$$ || :'player_id' || $$'::uuid, 'up', 1, 100) $$,
  'the first open round for a player succeeds'
);

select throws_like(
  $$ select public.open_round('$$ || :'player_id' || $$'::uuid, 'up', 1, 100) $$,
  '%round_in_flight%',
  'a second concurrent open round for the same player is rejected'
);

select * from finish();
rollback;
