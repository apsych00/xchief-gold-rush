-- Dev seed. Production uses real coupon codes and a generated kiosk secret (see docs/switch-environment.md).

-- Task definitions the server owns (docs/layers.md C5): id, title and reward all come from
-- here, never duplicated as numbers in src/. Titles are plain English; the client's own i18n
-- (src/i18n.js, keyed by id) still owns the localized copy shown on screen. 'signup' is now a
-- redirect task: it opens the broker registration page and releases after a 1-hour window.
--
-- kind and url (ticket B6+B7+B9, decision 1) drive the release path: video's progress is
-- reported and released at 90% (B6); telegram/youtube/review_* and signup are redirect-and-return
-- (B7), their URLs moved here from src/config.js's old LINKS object rather than left as a client
-- env var, so a marketer changing a destination edits one seeded row, not a deploy; email is
-- released by verify_otp_code on the socket that verified (B9); instagram is left as its own kind
-- for B8 to fill in later. 'story' (share-your-record) fits none of B6/B7's mechanics - it has no
-- external destination to return from - so it stays 'manual', unclaimable until a later ticket
-- gives it one.
insert into public.tasks (id, title, reward, repeat_ms, requires_email, kind, url) values
  ('signup',            'Create an xChief account',        1000, null,        false, 'redirect', 'https://my.xchief.com/registration?utm_source=goldrush&utm_campaign=goldrush'),
  ('video',             'xChief video',                    100,  300000,      false, 'video',    null),
  ('email',             'Save your email',                 200,  null,        false, 'email',    null),
  ('instagram',         'Follow Instagram',                300,  null,        false, 'instagram', null),
  ('telegram',          'Join Telegram',                   300,  null,        false, 'redirect', 'https://t.me/xchief'),
  ('youtube',           'Subscribe on YouTube',            300,  null,        false, 'redirect', 'https://www.youtube.com/@xchief'),
  ('youtube_1',         'YouTube mission 1',               150,  null,        false, 'youtube',  'VIDEO_ID_1'),
  ('youtube_2',         'YouTube mission 2',               150,  null,        false, 'youtube',  'VIDEO_ID_2'),
  ('youtube_3',         'YouTube mission 3',               150,  null,        false, 'youtube',  'VIDEO_ID_3'),
  ('story',             'Share your record',               300,  86400000,    false, 'manual',   null),
  ('review_trustpilot', 'Review on Trustpilot',            500,  null,        false, 'redirect', 'https://www.trustpilot.com/review/xchief.com')
on conflict (id) do update set
  title = excluded.title, reward = excluded.reward, repeat_ms = excluded.repeat_ms, requires_email = excluded.requires_email,
  kind = excluded.kind, url = excluded.url;

-- The campaign's tournament windows (ticket B1, docs/tasks-marketing-lead.md A3). Dates given
-- in Asia/Dubai (UTC+4, no DST) and stored as timestamptz; adjusting these in production is a
-- SQL one-liner (docs/box-deploy.md "Daily habits"), never a code change.
insert into public.tournaments (id, title, starts_at, ends_at, prize_title, prize_image, broker_bonus) values
  ('t1', 'Gold Rush Week 1', '2026-09-16 00:00:00+04', '2026-09-21 00:00:00+04', 'First prize', '/prizes/week1.png', null),
  ('t2', 'Gold Rush Week 2', '2026-09-21 00:00:00+04', '2026-09-24 00:00:00+04', 'First prize', '/prizes/week2.png', null)
on conflict (id) do update set
  title = excluded.title, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
  prize_title = excluded.prize_title, prize_image = excluded.prize_image, broker_bonus = excluded.broker_bonus;

-- 100 generated promo codes, e.g. XG-7F3A9C2B1D. Export the list for marketing with:
--   select code from public.coupons order by created_at;
insert into public.coupons (code)
select 'XG-' || upper(encode(gen_random_bytes(5), 'hex')) from generate_series(1, 100)
on conflict (code) do nothing;

-- One dev kiosk. Secret (dev only): dev-kiosk-secret-0001
insert into public.kiosks (label, secret_hash)
select 'dev-kiosk', crypt('dev-kiosk-secret-0001', gen_salt('bf'))
where not exists (select 1 from public.kiosks where label = 'dev-kiosk');

-- Default streak target (ticket C9 decision 1); server/index.js mirrors KIOSK_STREAK_TARGET
-- over this at every boot when that env var is set, so a fresh box without it still gets 5.
insert into public.settings (key, value) values ('kiosk_streak_target', '5')
on conflict (key) do nothing;
