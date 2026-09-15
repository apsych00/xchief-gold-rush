// Web round: verify the caller, read the relay price, hold the connection
// open for the server-owned 5s clock, then settle. The client never reports
// its own result - this function is the only place a round is decided.
import { anonClient, corsHeaders, jsonResponse, readRelayPrice, serviceClient, sleep } from "../_shared/mod.ts";
import { mapPgError } from "../_shared/errors.ts";

const RELAY_PRICE_URL = Deno.env.get("RELAY_PRICE_URL") ?? "";
const ROUND_WAIT_MS = 5000;

const VALID_DIRS = ["up", "down"];
const VALID_LEVERS = [1, 2, 5];

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

  // The server owns this clock. The wait-and-settle is registered with the runtime as
  // background work so it runs to completion even if the client disconnects mid-round:
  // a reload or a dropped connection can never dodge a loss.
  const settle = (async () => {
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
  })();
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(settle);
  return await settle;
});
