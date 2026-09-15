/**
 * Web round play and the client-callable RPCs. The server decides every
 * round; this module only carries the request and surfaces the verdict (or
 * error code) it gets back.
 */
import { enabled, supabase, supabaseAnonKey, supabaseUrl } from './client.js';

function disabledError() {
  return Object.assign(new Error('api_disabled'), { code: 'api_disabled' });
}

function rpcError(error) {
  // Postgres exceptions raised inside the SECURITY DEFINER functions surface
  // verbatim as error.message (e.g. 'already_claimed', 'email_required').
  const err = new Error(error.message);
  err.code = error.message;
  return err;
}

/** POSTs {dir, lever} to play-round. Resolves with the verdict, or throws with .code from the body's `error`. */
export async function playRound(dir, lever) {
  if (!enabled) throw disabledError();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    const err = new Error('unauthenticated');
    err.code = 'unauthenticated';
    throw err;
  }
  const res = await fetch(`${supabaseUrl}/functions/v1/play-round`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
      apikey: supabaseAnonKey,
    },
    body: JSON.stringify({ dir, lever }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || 'unknown_error');
    err.code = body.error || 'unknown_error';
    throw err;
  }
  return body;
}

export async function getMe() {
  if (!enabled) throw disabledError();
  const { data, error } = await supabase.rpc('get_me');
  if (error) throw rpcError(error);
  return data;
}

export async function claimTask(id) {
  if (!enabled) throw disabledError();
  const { data, error } = await supabase.rpc('claim_task', { p_task: id });
  if (error) throw rpcError(error);
  return data;
}

export async function freeRefill() {
  if (!enabled) throw disabledError();
  const { data, error } = await supabase.rpc('free_refill');
  if (error) throw rpcError(error);
  return data;
}

/** The public top-10, ranked by peak balance. A function, not a table. */
export async function getLeaderboard() {
  if (!enabled) throw disabledError();
  const { data, error } = await supabase.rpc('leaderboard');
  if (error) throw rpcError(error);
  return data;
}
