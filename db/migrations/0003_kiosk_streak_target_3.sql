-- Kiosk prize threshold 5-in-a-row -> 3 (commit 54b8033). Two independent places carried the
-- old default, both fixed here:
--
--   1. public.settle_kiosk_round's own fallback (public.get_setting_int('kiosk_streak_target', 3))
--      only matters when public.settings has no row for the key, but db/schema.sql already
--      defines the function at 3, so a database that has schema.sql recorded as applied from
--      before commit 54b8033 still has the function body call site reading 5 - create or
--      replace brings it to the same text a fresh database gets.
--   2. The public.settings row itself, seeded once by db/seed.sql and never re-run. An adopted
--      database already has a 'kiosk_streak_target' row holding the OLD default, '5', because
--      that is what db/seed.sql inserted before commit 54b8033.
--
-- The settings row update only touches a row whose value is still exactly the old default,
-- '5'. An operator can tune this value at any time with a plain SQL update (ticket C9 decision
-- 1, docs/box-deploy.md "Daily habits") - a row holding anything other than '5' (including an
-- operator who explicitly chose 5 again after this migration already ran once) is left alone,
-- since there is no way to tell that apart from a deliberate choice, and every other operator
-- override in this file follows the same rule: never stomp a value nobody but this migration
-- could have produced.
create or replace function public.settle_kiosk_round(p_round uuid, p_end_price numeric)
returns json language plpgsql security definer set search_path = public as $$
declare
  r public.rounds%rowtype;
  k public.kiosks%rowtype;
  v_outcome text;
  v_mult numeric := 1;
  v_delta int := 0;
  v_coins int;
  v_streak int;
  v_target int;
  v_coupon_id uuid;
  v_token text;
  v_claim_expires_at timestamptz;
  v_exhausted boolean := false;
  v_state text;
begin
  if p_end_price is null or p_end_price <= 0 then raise exception 'bad_price'; end if;

  select * into r from public.rounds where id = p_round for update;
  if not found or r.status <> 'open' or r.kiosk_id is null then
    raise exception 'round_not_open';
  end if;
  select * into k from public.kiosks where id = r.kiosk_id for update;

  if p_end_price = r.start_price then
    v_outcome := 'flat';
  elsif (r.dir = 'up' and p_end_price > r.start_price) or (r.dir = 'down' and p_end_price < r.start_price) then
    v_outcome := 'win';
  else
    v_outcome := 'lose';
  end if;

  v_coins := k.session_coins;
  v_streak := k.streak;

  if v_outcome = 'win' then
    v_mult := public.combo_mult(k.streak);
    v_delta := round(r.stake * v_mult)::int;
    v_coins := k.session_coins + v_delta;
    v_streak := k.streak + 1;
    v_target := public.get_setting_int('kiosk_streak_target', 3);
    if v_streak >= v_target then
      update public.coupons set status = 'reserved', claimed_by_kiosk = k.id
      where id = (
        select id from public.coupons where status = 'available'
        order by created_at limit 1 for update skip locked
      )
      returning id into v_coupon_id;
      if v_coupon_id is null then
        -- pool empty: keep the streak so the visitor is not robbed; the kiosk tells the staff
        v_exhausted := true;
        raise warning 'coupons_exhausted: kiosk % reached a %-win streak with no codes left', k.id, v_target;
      else
        -- 32 base64url characters from 24 random bytes (ticket C9 decision 2): 24 bytes encodes
        -- to exactly 32 base64 characters with no padding, so translate() alone (+/ -> -_) is
        -- enough - there is never a trailing '=' to strip.
        v_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
        v_claim_expires_at := now() + interval '24 hours';
        -- coupon_id is unique on this table (one row is this coupon's whole claim history, ticket
        -- C9 decision 2): a coupon the sweep already released once carries an old, expired row
        -- here already, so a later win on the very same coupon reopens that same row for its new
        -- cycle instead of colliding with it - the prior cycle's own email/claimed_at/expired_at
        -- are cleared, since they belong to the visitor who let the earlier link lapse, not this
        -- one.
        insert into public.claim_links (token, coupon_id, kiosk_id, expires_at)
        values (v_token, v_coupon_id, k.id, v_claim_expires_at)
        on conflict (coupon_id) do update set
          token = excluded.token, kiosk_id = excluded.kiosk_id, created_at = now(),
          expires_at = excluded.expires_at, email = null, claimed_at = null, claimed_ip = null, expired_at = null;
        v_streak := 0;
      end if;
    end if;
  elsif v_outcome = 'lose' then
    v_delta := -r.stake;
    v_coins := greatest(0, k.session_coins - r.stake);
    v_streak := 0;
  end if;

  if v_token is not null then
    v_state := 'won';
  elsif v_coins < 100 then
    v_state := 'broke';
  else
    v_state := 'playing';
  end if;

  update public.kiosks set session_coins = v_coins, streak = v_streak, session_state = v_state, last_round_at = now()
  where id = k.id;
  update public.rounds set end_price = p_end_price, end_at = now(), outcome = v_outcome, delta = v_delta, mult = v_mult, status = 'settled'
  where id = p_round;

  return json_build_object('outcome', v_outcome, 'delta', v_delta, 'mult', v_mult, 'coins', v_coins, 'streak', v_streak,
    'claim_token', v_token, 'claim_expires_at', v_claim_expires_at, 'coupons_exhausted', v_exhausted, 'state', v_state,
    'start_price', r.start_price, 'end_price', p_end_price);
end $$;

insert into public.settings (key, value) values ('kiosk_streak_target', '3')
on conflict (key) do update set value = '3', updated_at = now()
where public.settings.value = '5';
