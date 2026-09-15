// Current gold price for the round functions, in the relay's own shape: { price, t, source }.
//
// Tries the Fly relay first (the broker XAU/USD feed). If the relay is down or stale, falls
// back to public PAXG/USDT quotes (one PAXG token = one troy ounce of gold), the same
// sources the relay itself uses as backups. The round functions point RELAY_PRICE_URL at
// this function, so a relay outage degrades the price source instead of stopping the game.
import { corsHeaders, jsonResponse } from "../_shared/mod.ts";

const RELAY_URL = Deno.env.get("RELAY_UPSTREAM_URL") ?? ""; // e.g. https://<app>.fly.dev/price
const RELAY_MAX_AGE_MS = 3000;
const FETCH_TIMEOUT_MS = 2500;

interface Quote {
  price: number;
  t: number;
  source: string;
}

const isValid = (p: unknown): p is number =>
  typeof p === "number" && Number.isFinite(p) && p > 100 && p < 100000;

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return await res.json();
}

async function fromRelay(): Promise<Quote> {
  if (!RELAY_URL) throw new Error("no_relay");
  const d = (await fetchJson(RELAY_URL)) as { price?: unknown; t?: unknown; source?: unknown };
  if (!isValid(d.price) || typeof d.t !== "number" || Date.now() - d.t > RELAY_MAX_AGE_MS) {
    throw new Error("relay_stale");
  }
  return { price: d.price, t: d.t, source: typeof d.source === "string" ? d.source : "Relay" };
}

async function fromOkx(): Promise<Quote> {
  const d = (await fetchJson("https://www.okx.com/api/v5/market/ticker?instId=PAXG-USDT")) as {
    data?: Array<{ bidPx?: string; askPx?: string }>;
  };
  const q = d.data?.[0];
  const price = (Number(q?.bidPx) + Number(q?.askPx)) / 2;
  if (!isValid(price)) throw new Error("okx_bad");
  return { price, t: Date.now(), source: "OKX" };
}

async function fromBinance(): Promise<Quote> {
  const d = (await fetchJson("https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=PAXGUSDT")) as {
    bidPrice?: string;
    askPrice?: string;
  };
  const price = (Number(d.bidPrice) + Number(d.askPrice)) / 2;
  if (!isValid(price)) throw new Error("binance_bad");
  return { price, t: Date.now(), source: "Binance" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  for (const attempt of [fromRelay, fromOkx, fromBinance]) {
    try {
      const q = await attempt();
      return jsonResponse(200, { symbol: "XAU/USD", ...q });
    } catch {
      // try the next source
    }
  }
  return jsonResponse(503, { error: "no_price_source" });
});
