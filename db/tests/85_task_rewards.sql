-- Invariant (ticket B6+B7+B9, docs/tickets/b6-b7-b9-rewards.md decisions 2-3): the two
-- client-callable, auth.uid()-driven functions that release a reward from state the server
-- tracked itself, never from a client assertion of success.
--
-- report_video_progress (B6): releases the video task's reward once seconds_watched crosses
-- 90% of duration (duration >= 10), refuses a jump bigger than 2x the wall-clock time since the
-- LAST REPORT with progress_too_fast, and never releases below the threshold or under a 10 s
-- duration even at 100%.
--
-- start_task_visit / return_task_visit (B7): return_task_visit answers `not_yet` (json, not an
-- exception - see the function's own comment in db/schema.sql) before 5 s have passed since
-- start_task_visit, releases once past it, then answers `already_claimed` on a repeat. Both
-- functions restrict themselves to kind='redirect' tasks with unknown_task otherwise.
--
-- The once-per-device-or-verified-email rule both of these fall through to (release_task_reward)
-- is exercised directly, against every caller, in db/tests/80_device_identity.sql - not repeated
-- here.
begin;

select plan(14);

-- report_video_progress: below 90%, no release -------------------------------------------------

select tests.create_anonymous_player() as video_p1 \gset
set local role authenticated;
select set_config('app.player_id', :'video_p1', true);

select (public.report_video_progress('video', 5, 60)) as progress_1 \gset
select is((:'progress_1'::json->>'seconds_watched')::int, 5, 'the first report stores the seconds reported');
select is(:'progress_1'::json->>'reward', null, 'no reward at 5 of 60 seconds (below 90%)');
select is(
  (select coins from public.players where id = :'video_p1'),
  1000,
  'the balance is untouched below the release threshold'
);

-- backdate updated_at to give the next report a realistic elapsed time to check its jump against
-- (a plain UPDATE, so back to postgres - the authenticated role has no write grant on this table)
reset role;
update public.video_progress set updated_at = now() - interval '10 seconds'
  where player_id = :'video_p1'::uuid and task_id = 'video';
set local role authenticated;
select set_config('app.player_id', :'video_p1', true);

select (public.report_video_progress('video', 15, 60)) as progress_2 \gset
select is((:'progress_2'::json->>'seconds_watched')::int, 15, 'a jump within 2x the elapsed wall-clock time is accepted');

-- report_video_progress: a jump faster than 2x the wall-clock time since the last report --------

select throws_like(
  $$ select public.report_video_progress('video', 55, 60) $$,
  '%progress_too_fast%',
  'a big jump immediately after the last report (near-zero elapsed time) is rejected'
);
reset role;
select is(
  (select seconds_watched from public.video_progress where player_id = :'video_p1'::uuid and task_id = 'video'),
  15,
  'the rejected jump left seconds_watched exactly where it was'
);

-- report_video_progress: crossing 90% releases the reward itself, never via claim_task ----------

update public.video_progress set updated_at = now() - interval '60 seconds'
  where player_id = :'video_p1'::uuid and task_id = 'video';
set local role authenticated;
select set_config('app.player_id', :'video_p1', true);

select (public.report_video_progress('video', 54, 60)) as progress_3 \gset
select is((:'progress_3'::json->>'reward')::int, 100, 'crossing 90% of 60s releases the video task''s reward (seed: 100)');
select is(
  (select coins from public.players where id = :'video_p1'),
  1100,
  'the released reward is applied to the balance'
);
select ok(
  exists(select 1 from public.task_claims where player_id = :'video_p1'::uuid and task_id = 'video'),
  'a task_claims row exists for the video task, the same ledger claim_task would have written'
);

-- report_video_progress: a duration under 10s never releases, even at 100% ----------------------

reset role;
insert into public.tasks (id, title, reward, kind) values ('test_short_video', 'Test short video', 999, 'video');
select tests.create_anonymous_player() as video_p2 \gset
set local role authenticated;
select set_config('app.player_id', :'video_p2', true);

select (public.report_video_progress('test_short_video', 5, 5)) as progress_short \gset
select is(
  :'progress_short'::json->>'reward', null,
  'a video under 10s duration never releases even watched to 100%'
);

reset role;

-- start_task_visit / return_task_visit: the 5 s window (ticket B7 decision 3) --------------------

select tests.create_anonymous_player() as redirect_p1 \gset
set local role authenticated;
select set_config('app.player_id', :'redirect_p1', true);

select (public.start_task_visit('telegram')) as started \gset
select is(:'started'::json->>'window_ms', '5000', 'start_task_visit answers the 5 s window');

select (public.return_task_visit('telegram')) as returned_early \gset
select is(
  :'returned_early'::json->>'error', 'not_yet',
  'returning before 5 s have passed answers not_yet, not an exception'
);

reset role;
update public.task_visits set started_at = now() - interval '6 seconds'
  where player_id = :'redirect_p1'::uuid and task_id = 'telegram';
set local role authenticated;
select set_config('app.player_id', :'redirect_p1', true);

select (public.return_task_visit('telegram')) as returned_ok \gset
select is((:'returned_ok'::json->>'reward')::int, 300, 'past the 5 s window, the reward is released (seed: telegram = 300)');

select (public.return_task_visit('telegram')) as returned_again \gset
select is(
  :'returned_again'::json->>'error', 'already_claimed',
  'returning again after the reward already landed answers already_claimed'
);

reset role;

select * from finish();
rollback;
