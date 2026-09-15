// Pure quote-freshness check shared by every price read. Deliberately free of
// Deno APIs and imports so plain `node --test` can import and exercise it.
// A quote is only usable when its price is a finite positive number, its
// timestamp is finite, and it is not older than maxAgeMs.

export type QuoteCheck =
  | { ok: true; price: number; t: number }
  | { ok: false; reason: "bad_price" | "bad_time" | "stale" };

export function checkQuote(data: any, nowMs: number, maxAgeMs: number): QuoteCheck {
  const price = data?.price;
  const t = data?.t;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    return { ok: false, reason: "bad_price" };
  }
  if (typeof t !== "number" || !Number.isFinite(t)) {
    return { ok: false, reason: "bad_time" };
  }
  if (nowMs - t > maxAgeMs) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true, price, t };
}
