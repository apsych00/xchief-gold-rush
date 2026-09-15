// Kiosk round: no JWT, a bearer secret identifies the kiosk. Same
// server-owned 5s clock and price discipline as play-round; coins are
// cosmetic here, the kiosk is unranked and only cares about the win streak.
import { corsHeaders, jsonResponse, readRelayPrice, serviceClient, sleep } from "../_shared/mod.ts";
import { mapPgError } from "../_shared/errors.ts";

const RELAY_PRICE_URL = Deno.env.get("RELAY_PRICE_URL") ?? "";
const ROUND_WAIT_MS = 5000;

const VALID_DIRS = ["up", "down"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  let body: { secret?: string; dir?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "bad_request" });
  }

  const { secret, dir } = body;
  if (typeof secret !== "string" || !secret) {
    return jsonResponse(401, { error: "kiosk_unauthorized" });
  }
  if (typeof dir !== "string" || !VALID_DIRS.includes(dir)) {
    return jsonResponse(400, { error: "bad_dir" });
  }

  const db = serviceClient();

  const { data: kioskId, error: kioskErr } = await db.rpc("verify_kiosk", { p_secret: secret });
  if (kioskErr || !kioskId) {
    return jsonResponse(401, { error: "kiosk_unauthorized" });
  }

  let startPrice: number;
  try {
    startPrice = (await readRelayPrice(RELAY_PRICE_URL)).price;
  } catch {
    return jsonResponse(503, { error: "feed_stale" });
  }

  const { data: openData, error: openErr } = await db.rpc("open_kiosk_round", {
    p_kiosk: kioskId,
    p_dir: dir,
    p_start_price: startPrice,
  });
  if (openErr) {
    const mapped = mapPgError(openErr);
    if (mapped) return jsonResponse(mapped.status, { error: mapped.code });
    return jsonResponse(500, { error: "open_round_failed" });
  }
  const roundId = openData?.round_id;

  // Server-owned clock; do not tie this to req.signal.
  await sleep(ROUND_WAIT_MS);

  let endPrice: number;
  try {
    endPrice = (await readRelayPrice(RELAY_PRICE_URL)).price;
  } catch {
    await db.rpc("void_round", { p_round: roundId });
    return jsonResponse(503, { error: "feed_stale" });
  }

  const { data: settleData, error: settleErr } = await db.rpc("settle_kiosk_round", {
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
