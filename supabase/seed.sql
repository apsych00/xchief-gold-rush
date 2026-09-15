-- Dev seed. Production uses real coupon codes and a generated kiosk secret (see docs/switch-environment.md).

-- Task rewards mirror src/config.js. 'signup' is the email verification itself, so it needs a confirmed email.
insert into public.tasks (id, reward, repeat_ms, requires_email) values
  ('signup',            1000, null,        true),
  ('video',             100,  300000,      false),
  ('email',             200,  null,        false),
  ('instagram',         300,  null,        false),
  ('telegram',          300,  null,        false),
  ('youtube',           300,  null,        false),
  ('story',             300,  86400000,    false),
  ('review_trustpilot', 500,  null,        false),
  ('review_google',     500,  null,        false),
  ('review_fpa',        500,  null,        false)
on conflict (id) do update set reward = excluded.reward, repeat_ms = excluded.repeat_ms, requires_email = excluded.requires_email;

-- 100 generated promo codes, e.g. XG-7F3A9C2B1D. Export the list for marketing with:
--   select code from public.coupons order by created_at;
insert into public.coupons (code)
select 'XG-' || upper(encode(gen_random_bytes(5), 'hex')) from generate_series(1, 100)
on conflict (code) do nothing;

-- One dev kiosk. Secret (dev only): dev-kiosk-secret-0001
insert into public.kiosks (label, secret_hash)
select 'dev-kiosk', crypt('dev-kiosk-secret-0001', gen_salt('bf'))
where not exists (select 1 from public.kiosks where label = 'dev-kiosk');
