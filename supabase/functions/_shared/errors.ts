// Maps Postgres exceptions raised inside the round RPCs (they surface as plain
// text on error.message) to the HTTP status the spec calls for. Unmatched code
// => null, and the caller falls back to a 500.
//
// This is the single source of truth shared by play-round and play-round-kiosk.
// It is the union of both flows' codes. That is safe: the RPCs each function
// calls only ever raise its own subset, and no code string is a substring of
// another, so the first-match loop resolves identically to the old per-function
// maps. Deliberately free of Deno APIs and imports so plain `node --test` can
// import and exercise it.

export const ERROR_STATUS: Record<string, number> = {
  insufficient_coins: 409,
  rate_limited: 429,
  round_in_flight: 409,
  bad_dir: 400,
  bad_lever: 400,
  bad_price: 400,
  round_not_open: 409,
  kiosk_unauthorized: 401,
};

export function mapPgError(
  err: { message?: string } | null | undefined,
): { status: number; code: string } | null {
  const msg = err?.message ?? "";
  for (const code of Object.keys(ERROR_STATUS)) {
    if (msg.includes(code)) return { status: ERROR_STATUS[code], code };
  }
  return null;
}
