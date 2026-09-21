-- Rebuild the campaign as three seasons (owner's call, 2026-09-21).
--
--   Season 1  20 - 22 Sep
--   Season 2  22 - 26 Sep
--   Season 3  26 Sep - 6 Oct   (ten days)
--
-- All times are +04, the campaign's own timezone, matching db/seed.sql.
--
-- The old schedule (Week 1, Week 2, and the 30-day season that followed them) goes. Week 1's
-- standings are kept outside the database in docs/week1-podium.md, because removing the
-- tournament row removes the only live copy of who won its $3,000 prize, and nothing pays that
-- out automatically.
--
-- Scores earned in the window Season 1 now covers are carried onto Season 1 rather than thrown
-- away: those players really did earn them inside these dates, and the board should not reset
-- under a player who is mid-campaign.
--
-- The tournaments table forbids overlapping windows, so the old rows have to come out before the
-- new ones go in - hence the clear-then-insert rather than a series of updates, which would
-- collide with the constraint half way through.

-- Every settled round records the tournament it belonged to, as an audit column, so the old rows
-- cannot simply be deleted out from under them. Rounds that were played inside the window Season
-- 1 now covers are re-pointed at Season 1, since that is honestly which season they belong to;
-- everything older is set to null, which is the same thing settle_round writes for a round played
-- while no tournament is running. Round history itself is untouched either way.

-- Scores from the tournament that was running over 20-21 Sep, to re-home onto Season 1.
create temp table _carry_scores on commit drop as
select player_id, record, updated_at
from public.tournament_scores
where tournament_id = 't2';

-- Which rounds belong to Season 1's window, captured before the tournament rows disappear.
create temp table _carry_rounds on commit drop as
select id from public.rounds
where end_at >= timestamptz '2026-09-20 00:00:00+04'
  and end_at <  timestamptz '2026-09-22 00:00:00+04';

update public.rounds set tournament_id = null where tournament_id is not null;

delete from public.tournament_results;
delete from public.tournament_scores;
delete from public.tournaments;

insert into public.tournaments (id, title, starts_at, ends_at, prize_title, prize_image, broker_bonus) values
  ('s1', 'Gold Rush Season 1', '2026-09-20 00:00:00+04', '2026-09-22 00:00:00+04',
   '$3,000 broker bonus', '/prizes/week1.png', 'Credited to your xChief broker account'),
  ('s2', 'Gold Rush Season 2', '2026-09-22 00:00:00+04', '2026-09-26 00:00:00+04',
   '$3,000 broker bonus', '/prizes/week2.png', 'Credited to your xChief broker account'),
  ('s3', 'Gold Rush Season 3', '2026-09-26 00:00:00+04', '2026-10-06 00:00:00+04',
   '$3,000 broker bonus', '/prizes/week3.png', 'Credited to your xChief broker account');

insert into public.tournament_scores (tournament_id, player_id, record, updated_at)
select 's1', player_id, record, updated_at from _carry_scores
on conflict (tournament_id, player_id) do nothing;

update public.rounds set tournament_id = 's1'
where id in (select id from _carry_rounds);
