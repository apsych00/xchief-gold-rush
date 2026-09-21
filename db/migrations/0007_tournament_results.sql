-- Record who won each tournament, frozen when its window closes.
--
-- Week 1 ended on 2026-09-20 with a $3,000 prize and no record anywhere of who took it. The
-- board is not an answer to that: it is a live view over tournament_scores, and those rows keep
-- moving, so reading a closed tournament's standings later reads whatever the table says now.
--
-- This adds the table and the function that fills it, and the 60 s sweep in server/kiosk.js
-- calls it from this deploy onward. Applying this migration settles Week 1 on the next sweep,
-- using the scores as they stand - which for a closed window is what they have been since it
-- closed, since nothing outside a tournament's own window can change them.
--
-- See db/schema.sql for the full reasoning on both objects; this is the same definition.

create table if not exists public.tournament_results (
  tournament_id text not null references public.tournaments (id),
  player_id uuid not null references public.players (id) on delete cascade,
  rank int not null,
  record int not null,
  settled_at timestamptz not null default now(),
  primary key (tournament_id, player_id)
);

create index if not exists tournament_results_rank on public.tournament_results (tournament_id, rank);

alter table public.tournament_results enable row level security;
revoke select on public.tournament_results from anon, authenticated;

create or replace function public.settle_tournaments()
returns int language plpgsql security definer set search_path = public as $$
declare
  v_written int := 0;
  v_rows int;
  t record;
begin
  for t in
    select id from public.tournaments
    where ends_at <= now()
      and not exists (select 1 from public.tournament_results r where r.tournament_id = id)
    order by ends_at
  loop
    insert into public.tournament_results (tournament_id, player_id, rank, record)
    select t.id, ranked.player_id, ranked.rank, ranked.record
    from (
      select ts.player_id, ts.record,
        rank() over (order by ts.record desc, ts.updated_at asc) as rank
      from public.tournament_scores ts
      join public.players p on p.id = ts.player_id
      where ts.tournament_id = t.id and p.email is not null
    ) ranked
    where ranked.rank <= 3
    on conflict (tournament_id, player_id) do nothing;
    get diagnostics v_rows = row_count;
    v_written := v_written + v_rows;
  end loop;
  return v_written;
end $$;
