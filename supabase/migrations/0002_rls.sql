-- Row Level Security: the client may read its own data and the public leaderboard, nothing else.
-- Writes are impossible from the client: privileges are revoked outright, and every mutation
-- happens inside SECURITY DEFINER functions or edge functions using the service role.

alter table public.players enable row level security;
alter table public.rounds enable row level security;
alter table public.tasks enable row level security;
alter table public.task_claims enable row level security;
alter table public.kiosks enable row level security;
alter table public.coupons enable row level security;

-- No client writes, anywhere. (RLS with no policy already denies; revoking removes any doubt.)
revoke insert, update, delete, truncate, references, trigger
  on public.players, public.rounds, public.tasks, public.task_claims, public.kiosks, public.coupons
  from anon, authenticated;

-- kiosks and coupons: not even readable by clients. Service role only.
revoke select on public.kiosks, public.coupons from anon, authenticated;

create policy players_select_own on public.players
  for select to authenticated using (id = auth.uid());

create policy rounds_select_own on public.rounds
  for select to authenticated using (player_id = auth.uid());

create policy task_claims_select_own on public.task_claims
  for select to authenticated using (player_id = auth.uid());

create policy tasks_select_all on public.tasks
  for select to anon, authenticated using (true);

-- Public leaderboard: top 10 by peak balance, email-confirmed players only, safe columns only.
-- Runs with the view owner's rights on purpose, so it can read players past RLS while
-- exposing nothing but display_name and record.
create view public.leaderboard as
  select display_name, record, rank() over (order by record desc, updated_at asc) as rank
  from public.players
  where email is not null
  order by record desc, updated_at asc
  limit 10;

grant select on public.leaderboard to anon, authenticated;
