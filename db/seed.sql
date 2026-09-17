-- Dev seed. Production uses real coupon codes and a generated kiosk secret (see docs/switch-environment.md).

-- Task definitions the server owns (docs/layers.md C5): id, title and reward all come from
-- here, never duplicated as numbers in src/. Titles are plain English; the client's own i18n
-- (src/i18n.js, keyed by id) still owns the localized copy shown on screen. 'signup' is the
-- email verification itself, so it needs a confirmed email.
insert into public.tasks (id, title, reward, repeat_ms, requires_email) values
  ('signup',            'Create an xChief account',        1000, null,        true),
  ('video',             'xChief video',                    100,  300000,      false),
  ('email',             'Save your email',                 200,  null,        false),
  ('instagram',         'Follow Instagram',                300,  null,        false),
  ('telegram',          'Join Telegram',                   300,  null,        false),
  ('youtube',           'Subscribe on YouTube',             300,  null,        false),
  ('story',             'Share your record',                300,  86400000,    false),
  ('review_trustpilot', 'Review on Trustpilot',            500,  null,        false),
  ('review_google',     'Review on Google',                500,  null,        false),
  ('review_fpa',        'Review on Forex Peace Army',      500,  null,        false)
on conflict (id) do update set
  title = excluded.title, reward = excluded.reward, repeat_ms = excluded.repeat_ms, requires_email = excluded.requires_email;

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
