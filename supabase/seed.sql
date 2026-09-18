-- Dev seed. Production uses real coupon codes and a generated kiosk secret (see docs/switch-environment.md).

-- Task rewards mirror src/config.js. 'signup' is now a redirect task: tapping it opens the
-- xChief registration page in a new tab and a 1-hour persisted countdown releases the reward.
-- The other tasks keep their previous default kind ('manual', null url) so this seed does not
-- change their behavior; db/seed.sql is the canonical task definition for the box build.
insert into public.tasks (id, reward, repeat_ms, requires_email, kind, url) values
  ('signup',            1000, null,        false, 'redirect', 'https://my.xchief.com/registration?utm_source=goldrush&utm_campaign=goldrush'),
  ('video',             100,  300000,      false, 'manual',   null),
  ('email',             200,  null,        false, 'manual',   null),
  ('instagram',         300,  null,        false, 'manual',   null),
  ('telegram',          300,  null,        false, 'manual',   null),
  ('youtube',           300,  null,        false, 'manual',   null),
  ('story',             300,  86400000,    false, 'manual',   null),
  ('review_trustpilot', 500,  null,        false, 'manual',   null),
  ('review_google',     500,  null,        false, 'manual',   null),
  ('review_fpa',        500,  null,        false, 'manual',   null)
on conflict (id) do update set reward = excluded.reward, repeat_ms = excluded.repeat_ms, requires_email = excluded.requires_email, kind = excluded.kind, url = excluded.url;

-- 100 generated promo codes, e.g. XG-7F3A9C2B1D. Export the list for marketing with:
--   select code from public.coupons order by created_at;
insert into public.coupons (code)
select 'XG-' || upper(encode(gen_random_bytes(5), 'hex')) from generate_series(1, 100)
on conflict (code) do nothing;

-- One dev kiosk. Secret (dev only): dev-kiosk-secret-0001
insert into public.kiosks (label, secret_hash)
select 'dev-kiosk', crypt('dev-kiosk-secret-0001', gen_salt('bf'))
where not exists (select 1 from public.kiosks where label = 'dev-kiosk');
