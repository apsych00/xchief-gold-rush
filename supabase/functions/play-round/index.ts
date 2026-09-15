// Web round: verify the caller, read the relay price, hold the connection
// open for the server-owned 5s clock, then settle. The client never reports
// its own result - this function is the only place a round is decided.
import { anonClient, corsHeaders, jsonResponse, readRelayPrice, serviceClient, sleep } from "../_shared/mod.ts";

const RELAY_PRICE_URL = Deno.env.get("RELAY_PRICE_URL") ?? "";
const ROUND_WAIT_MS = 5000;

const VALID_DIRS = ["up", "down"];
const VALID_LEVERS = [1, 2, 5];

// Postgres exceptions raised inside the RPCs surface as plain messages on
// error.message (and often duplicated in error.details). Map the known codes
// to the HTTP status the spec calls for; anything else is a 500.
const ERROR_STATUS: Record<string, number> = {
  insufficient_coins: 409,
  rate_limited: 429,
  round_in_flight: 409,
  bad_dir: 400,
  bad_lever: 400,
  bad_price: 400,
  round_not_open: 409,
};

function mapPgError(err: { message?: string } | null | undefined): { status: number; code: string } | null {
  const msg = err?.message ?? "";
  for (const code of Object.keys(ERROR_STATUS)) {
    if (msg.includes(code)) return { status: ERROR_STATUS[code], code };
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) {
    return jsonResponse(401, { error: "unauthenticated" });
  }

  const anon = anonClient();
  const { data: userData, error: userErr } = await anon.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return jsonResponse(401, { error: "unauthenticated" });
  }
  const userId = userData.user.id;

  let body: { dir?: string; lever?: number };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "bad_request" });
  }

  const { dir, lever } = body;
  if (typeof dir !== "string" || !VALID_DIRS.includes(dir)) {
    return jsonResponse(400, { error: "bad_dir" });
  }
  if (typeof lever !== "number" || !VALID_LEVERS.includes(lever)) {
    return jsonResponse(400, { error: "bad_lever" });
  }

  const db = serviceClient();

  let startPrice: number;
  try {
    startPrice = (await readRelayPrice(RELAY_PRICE_URL)).price;
  } catch {
    return jsonResponse(503, { error: "feed_stale" });
  }

  const { data: openData, error: openErr } = await db.rpc("open_round", {
    p_player: userId,
    p_dir: dir,
    p_lever: lever,
    p_start_price: startPrice,
  });
  if (openErr) {
    const mapped = mapPgError(openErr);
    if (mapped) return jsonResponse(mapped.status, { error: mapped.code });
    return jsonResponse(500, { error: "open_round_failed" });
  }
  const roundId = openData?.round_id;

  // The server owns this clock. Do not tie this to req.signal - a client
  // disconnect must not dodge the round settling.
  await sleep(ROUND_WAIT_MS);

  let endPrice: number;
  try {
    endPrice = (await readRelayPrice(RELAY_PRICE_URL)).price;
  } catch {
    await db.rpc("void_round", { p_round: roundId });
    return jsonResponse(503, { error: "feed_stale" });
  }

  const { data: settleData, error: settleErr } = await db.rpc("settle_round", {
    p_round: roundId,
    p_end_price: endPrice,
  });
  if (settleErr) {
    const mapped = mapPgError(settleErr);
    if (mapped) return jsonResponse(mapped.status, { error: mapped.code });
    return jsonResponse(500, { error: "settle_round_failed" });
  }

  return jsonResponse(200, settleData);
});
