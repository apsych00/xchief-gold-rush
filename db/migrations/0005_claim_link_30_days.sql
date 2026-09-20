-- The claim link a kiosk win mints is good for 30 days, not 24 hours.
--
-- The gift card itself has always been a 30-day card (the email says so, and server/otp.js
-- stamps its expiry 30 days out). The link that turns a reserved coupon into that card was
-- only good for 24 hours, so a booth visitor who did not enter their email the same day lost
-- the prize outright and the coupon went back into the pool. Those two numbers should never
-- have disagreed.
--
-- Only the window changes. The sweep in server/kiosk.js still releases a link that lapses, so
-- an unclaimed coupon is still recovered - just after 30 days instead of one.
--
-- settle_kiosk_round is replaced wholesale rather than patched, because a Postgres function has
-- no in-place edit: this is the same body as db/schema.sql's, with the interval changed.

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
        v_claim_expires_at := now() + interval '30 days';
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
