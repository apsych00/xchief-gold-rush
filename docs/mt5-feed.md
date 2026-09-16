# MT5 price feed - spec (card S17)

Goal: the liveliest honest gold price we can show, from the same quote the brand trades. An xChief investor (read-only) MT5 login can stream every broker tick for XAUUSD. The game architecture does not change: it becomes one more source in `server/feed.js`, at priority 0, with Finnhub and PAXG staying as fallbacks.

## What "excitingly alive" needs

Three levers, independent of each other:

1. **Tick density at the source.** Measured today (`demo/feed-compare.mjs`): Finnhub OANDA XAU gives ~2-3 msgs/s and ~9 distinct moves per 5 s; PAXG exchanges give ~0.5-1 per 5 s. A broker MT5 tick stream for XAUUSD typically delivers 5-20 ticks/s in active hours, every one a real bid/ask change. That is the biggest lever.
2. **Precision we keep.** Finnhub quotes gold to 3 decimals; the server publishes 2. Rounding collapses some real moves into "no change". Publish 3 decimals (and let the client render 2 while animating on 3) - a one-line change, free liveliness, applies to every source.
3. **Client motion between ticks.** A chart that only redraws on a tick looks stepped. Interpolating the drawn line toward the latest price over ~150 ms, and rolling the digits of the price display, makes the same data feel alive. Pure client work (marketing lead's UI); no honesty cost because the settle still uses real ticks.

MT5 is lever 1. Levers 2 and 3 are cheap and should be done regardless.

## Two ways to get MT5 ticks out

| | Buy: hosted bridge (MetaApi) | Implement: own terminal + bridge |
|---|---|---|
| What | MetaApi.cloud connects to the broker with the investor login and streams ticks over a WebSocket/SDK (`onSymbolPriceUpdated`) | A Windows (or Wine) VM runs the MT5 terminal logged in as the investor; a small Python service (`MetaTrader5` package) polls `symbol_info_tick`/`copy_ticks_from` and publishes over a WebSocket the game server subscribes to |
| Time to first tick | ~1 hour (account, add the MT5 login, run the SDK sample) | ~1 day (VM, terminal install, bridge, keep-alive) |
| Cost | Pay-per-account, on the order of $10-40/month for one account; confirm on their pricing page | The VM (~$10-20/month) plus one more thing to keep alive |
| Failure modes | MetaApi outage; broker session drop (they reconnect) | Terminal logs out, VM reboots, Wine quirks; you own the keep-alive |
| Recommendation | **Start here.** Evaluate with the trial; if tick density is what we hope, keep it for the month | Only if MetaApi is unacceptable (cost or policy) |

Either way the game server sees the same thing: a source that emits `{price, t}` ticks. Use the mid `(bid+ask)/2`, as with the exchanges, or the bid - decide once and apply to every source (mid is the current convention).

## How it slots in

- `server/feed.js`: add source `mt5` (priority 0) using the MetaApi Node SDK streaming connection (or a plain WebSocket to our own bridge). Same validation (finite, 100..100000), same 10 s demotion rule, same continuous-series offset on switch. Env: `METAAPI_TOKEN`, `METAAPI_ACCOUNT_ID` (or `MT5_BRIDGE_WS`). Nothing else changes: rounds, settlement, client are source-agnostic and the UI never shows a source name.
- `rounds.source` records `mt5` for audit.
- `/status` shows it as one more source.

## Measuring the liveness difference

`demo/feed-compare.mjs` connects to every source for N seconds and prints messages per second, distinct changes per 5 s at 3 and at 2 decimals, and inter-tick gap p50/p95/max. Run it before and after adding MT5 (`FINNHUB_TOKEN` set; stop the game server first, Finnhub allows one socket per key). Success bar for MT5: at least 3x Finnhub's distinct changes per 5 s during expo hours, p95 inter-tick gap under 1 s, and no gaps over 5 s while the market is open.

Also compare "as felt": run the kiosk on each source for a minute and watch the chart. The numbers say density; the eye says excitement, and both matter.

## What I need to build it

- An xChief investor login for MT5 (login, investor password, server name) - read-only, no trading rights. Given to me the same way as the Elastic key: straight into the box's `.env`, never chat.
- A MetaApi account (or the go-ahead to create one on the trial) and its token.
- Confirmation of the symbol name on that server (`XAUUSD`, sometimes `XAUUSD.` or `GOLD`).

## Ticket

**S17 - MT5 feed.** (1) `demo/feed-compare.mjs` gains an `mt5` source; run it for 10 minutes in expo hours, attach the table. (2) If it clears the bar, add the source to `server/feed.js` at priority 0 with unit tests (same pattern as the existing sources) and the env vars to `.env.box.example`. (3) Publish 3 decimals (lever 2) as part of the same ticket. Lever 3 (client interpolation) is a separate small UI ticket for the marketing lead's side.

## Hook-up procedure

The plumbing (`server/feed.js` priority 0, `server/feed-mt5.js` adapter, unit tests, `demo/feed-compare.mjs`) is already in place and ships without MT5 active - `mt5` simply does not appear as a source until it is configured. Turning it on is a config change, not a code change:

1. Install the SDK on the box: `npm install metaapi.cloud-sdk`. It is deliberately **not** a `package.json` dependency (its tree is large and old-pinned - socket.io v2, crypto-browserify, native bufferutil/utf-8-validate bindings); `server/feed-mt5.js` loads it with a dynamic `import()` only when an mt5 source actually connects, so every other source keeps working on a box that skips this step.
2. Set three values in the box's `.env` (see `.env.box.example`), straight into the box, never in chat or committed:
   - `METAAPI_TOKEN` - the MetaApi.cloud account token.
   - `METAAPI_ACCOUNT_ID` - the MetaApi account id carrying the xChief investor (read-only) MT5 login.
   - `METAAPI_SYMBOL` - the broker's XAU/USD symbol name (defaults to `XAUUSD` if left empty; confirm the exact spelling on that server first - some brokers use `XAUUSD.` or `GOLD`).
3. Restart the server container (`docker compose up -d --build server` or the box's equivalent) so it picks up the new environment.
4. Check `/status` (or the operator health endpoint) shows an `mt5` entry with `connected: true`. If it never connects, check the box logs for `[feed] upstream mt5` warnings - same reconnect/backoff logging as every other source.
5. Run `demo/feed-compare.mjs` for 10 minutes during expo hours (`METAAPI_TOKEN=... METAAPI_ACCOUNT_ID=... node demo/feed-compare.mjs --seconds=600`) and read the `mt5 broker XAUUSD` row against the success bar above (3x Finnhub's changes/5s, p95 gap under 1 s, no gap over 5 s).
6. Decision bar: if it clears, mt5 is already priority 0 and takes over automatically - nothing else to flip. If it does not clear, unset `METAAPI_TOKEN`/`METAAPI_ACCOUNT_ID` and restart; the feed falls back to Finnhub/PAXG exactly as it does today.
