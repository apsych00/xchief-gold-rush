-- Leaderboard page size 20 -> 25 (commit b19436c). db/schema.sql already defines
-- public.leaderboard() at 25 per page, so a fresh database never needs this file - it only
-- matters to a database that has db/schema.sql recorded as applied from before that commit.
--
-- create or replace is safe either way: the production box was already hand-patched to 25
-- (the failure this migration system exists to end), so this must be a no-op there too, not
-- an error or a second patch on top of the first.
create or replace function public.leaderboard(p_tournament text default null, p_page int default 1)
returns table (rank bigint, display text, record int, tier text)
language sql security definer stable set search_path = public as $$
  with ranked as (
    select public.mask_email(p.email) as display, ts.record,
      rank() over (order by ts.record desc, ts.updated_at asc) as rank
    from public.tournament_scores ts
    join public.players p on p.id = ts.player_id
    where ts.tournament_id = coalesce(p_tournament, (select id from public.current_tournament()))
      and p.email is not null
  )
  select rank, display, record, public.tier_for_rank(rank) as tier
  from ranked
  order by rank
  limit 25 offset (greatest(coalesce(p_page, 1), 1) - 1) * 25;
$$;
