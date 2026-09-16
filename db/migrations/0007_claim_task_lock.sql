-- Red-team finding F1 (Low): claim_task's once-only check was serialized only as a side effect of
-- ensure_player's upsert taking the player row lock. Make it explicit: lock the player row before
-- reading prior claims, exactly as free_refill does, so two concurrent claims can never both pass.

create or replace function public.claim_task(p_task text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  t public.tasks%rowtype;
  v_last timestamptz;
  v_confirmed timestamptz;
  v_coins int;
begin
  if v_uid is null then raise exception 'unauthenticated'; end if;
  select * into t from public.tasks where id = p_task;
  if not found then raise exception 'unknown_task'; end if;

  perform public.ensure_player(v_uid);
  -- Serialize all claims for this player: the check below and the insert run under this lock.
  perform 1 from public.players where id = v_uid for update;

  if t.requires_email then
    select email_confirmed_at into v_confirmed from auth.users where id = v_uid;
    if v_confirmed is null then raise exception 'email_required'; end if;
  end if;

  select max(claimed_at) into v_last from public.task_claims
    where player_id = v_uid and task_id = p_task;
  if v_last is not null and (t.repeat_ms is null or v_last > now() - make_interval(secs => t.repeat_ms / 1000.0)) then
    raise exception 'already_claimed';
  end if;

  insert into public.task_claims (player_id, task_id, reward) values (v_uid, p_task, t.reward);
  update public.players set
    coins = coins + t.reward,
    record = greatest(record, coins + t.reward),
    updated_at = now()
  where id = v_uid
  returning coins into v_coins;

  return json_build_object('coins', v_coins, 'reward', t.reward);
end $$;

revoke execute on function public.claim_task(text) from public, anon;
grant execute on function public.claim_task(text) to authenticated;
