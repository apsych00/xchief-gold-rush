-- A third tournament, running for 30 days from the moment the second one ends.
--
-- Week 2 closes 2026-09-24 00:00 +04 (the day after the expo), and nothing followed it. That
-- matters more than it looks: scores only count while a tournament window is open, so from that
-- instant every round and every reward would have counted for nothing, silently, and the
-- leaderboard would have gone empty with the game still running. This keeps the campaign scored
-- for the month after the booth.
--
-- The window starts exactly where Week 2 ends. The tournaments table excludes overlapping
-- ranges and the range is inclusive-start/exclusive-end, so this hands off with no gap and no
-- instant counted twice.
--
-- Nothing else changes. No scores, no players, no existing tournament row is touched.

insert into public.tournaments (id, title, starts_at, ends_at, prize_title, prize_image, broker_bonus)
values (
  't3',
  'Gold Rush Season',
  '2026-09-24 00:00:00+04',
  '2026-10-24 00:00:00+04',
  '$3,000 broker bonus',
  '/prizes/week3.png',
  'Credited to your xChief broker account'
)
on conflict (id) do nothing;
