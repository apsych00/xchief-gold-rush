-- round_settled carries best_streak; return it from settle_round instead of a second read.
create or replace function public.settle_round(p_round uuid, p_end_price numeric)
returns json language plpgsql security definer set search_path = public as $$
declare
  r public.rounds%rowtype;
  p public.players%rowtype;
  v_outcome text;
  v_mult numeric := 1;
  v_delta int := 0;
  v_coins int;
  v_streak int;
begin
  if p_end_price is null or p_end_price <= 0 then raise exception 'bad_price'; end if;
  select * into r from public.rounds where id = p_round for update;
  if not found or r.status <> 'open' or r.player_id is null then raise exception 'round_not_open'; end if;
  select * into p from public.players where id = r.player_id for update;
  if p_end_price = r.start_price then v_outcome := 'flat';
  elsif (r.dir = 'up' and p_end_price > r.start_price) or (r.dir = 'down' and p_end_price < r.start_price) then v_outcome := 'win';
  else v_outcome := 'lose'; end if;
  v_coins := p.coins; v_streak := p.streak;
  if v_outcome = 'win' then
    v_mult := public.combo_mult(p.streak);
    v_delta := round(r.stake * v_mult)::int;
    v_coins := p.coins + v_delta; v_streak := p.streak + 1;
    update public.players set coins = v_coins, record = greatest(record, v_coins), streak = v_streak,
      best_streak = greatest(best_streak, v_streak), wins = wins + 1, rounds = rounds + 1, updated_at = now() where id = p.id;
  elsif v_outcome = 'lose' then
    v_delta := -r.stake; v_coins := greatest(0, p.coins - r.stake); v_streak := 0;
    update public.players set coins = v_coins, streak = 0, rounds = rounds + 1, updated_at = now() where id = p.id;
  else
    update public.players set rounds = rounds + 1, updated_at = now() where id = p.id;
  end if;
  update public.rounds set end_price = p_end_price, end_at = now(), outcome = v_outcome, delta = v_delta, mult = v_mult, status = 'settled' where id = p_round;
  return json_build_object('outcome', v_outcome, 'delta', v_delta, 'mult', v_mult, 'coins', v_coins, 'streak', v_streak,
    'record', greatest(p.record, v_coins), 'best_streak', greatest(p.best_streak, v_streak), 'start_price', r.start_price, 'end_price', p_end_price);
end $$;
revoke execute on function public.settle_round(uuid, numeric) from public, anon, authenticated;
