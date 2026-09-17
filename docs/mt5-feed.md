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

1. The SDK is already in the server image (`server/Dockerfile` installs `metaapi.cloud-sdk` at build time; it is deliberately not a `package.json` dependency because its tree is large and old-pinned, and `server/feed-mt5.js` loads it lazily). Nothing to install.
2. Set three values in the box's `.env` (see `.env.box.example`), straight into the box, never in chat or committed:
   - `METAAPI_TOKEN` - the MetaApi.cloud account token.
   - `METAAPI_ACCOUNT_ID` - the MetaApi account id carrying the xChief investor (read-only) MT5 login.
   - `METAAPI_SYMBOL` - the broker's XAU/USD symbol name (defaults to `XAUUSD` if left empty; confirm the exact spelling on that server first - some brokers use `XAUUSD.` or `GOLD`).
3. Restart the server container (`docker compose up -d --build server` or the box's equivalent) so it picks up the new environment.
4. Check `/status` (or the operator health endpoint) shows an `mt5` entry with `connected: true`. If it never connects, check the box logs for `[feed] upstream mt5` warnings - same reconnect/backoff logging as every other source.
5. Run `demo/feed-compare.mjs` for 10 minutes during expo hours (`METAAPI_TOKEN=... METAAPI_ACCOUNT_ID=... node demo/feed-compare.mjs --seconds=600`) and read the `mt5 broker XAUUSD` row against the success bar above (3x Finnhub's changes/5s, p95 gap under 1 s, no gap over 5 s).
6. Decision bar: if it clears, mt5 is already priority 0 and takes over automatically - nothing else to flip. If it does not clear, unset `METAAPI_TOKEN`/`METAAPI_ACCOUNT_ID` and restart; the feed falls back to Finnhub/PAXG exactly as it does today.

## Bridge route

The "Implement: own terminal + bridge" route from the table above, wired up (ticket B15): `mt5/` runs the MT5 terminal under Wine, logged in with the investor login, and `mt5/bridge.py` polls it and republishes ticks over a WebSocket on port 8765. `server/feed-mt5-bridge.js` is the client-side adapter - same `connect()/disconnect()`, `onTick`/`onState` contract as `server/feed-mt5.js`, so `server/feed.js` treats either the same way under the `mt5` source id. If both routes are configured, MetaApi wins (it is the vetted one); the bridge only takes over when `METAAPI_TOKEN` is unset.

Run it locally:

1. `cp .env.box.example .env.box` and fill in `MT5_LOGIN`, `MT5_PASSWORD` (investor), `MT5_SERVER`, and `MT5_SYMBOL` if it isn't `XAUUSD` on that broker. Leave `METAAPI_TOKEN` unset so the bridge is the one that takes the `mt5` slot. `MT5_BRIDGE_WS=ws://mt5:8765` is already set - that is the compose network address, not a public port.
2. Start the bridge alongside the rest of the box with the `mt5` compose profile: `docker compose --profile mt5 up -d --build`. It is otherwise off - a plain `docker compose up` never builds or starts it, and port 8765 is never published outside the compose network.
3. Check `/status` (or the operator health endpoint) for an `mt5` entry with `connected: true`, exactly as with the MetaApi route. If it never connects, check the bridge's own logs (`docker compose logs -f mt5`, or `/logs` on the box) - it logs every login/connect attempt and every reconnect to stdout.

Everything after that - priority, validation, the 10 s demotion rule, `/status`, `rounds.source` - is identical to the MetaApi route; the client never knows which one is behind `mt5`.

### First login

The MT5 terminal needs one manual, interactive step before it will ever connect headlessly: accepting its license dialog and logging in for the first time. `mt5/entrypoint.sh` cannot do this for you - it only waits for the terminal to exist and installs the bridge's own dependencies. Do this once per box (the state survives every rebuild and restart because it lands on the `mt5_data` volume, mounted at `/config`):

1. Bring the service up if it is not already running: `docker compose --env-file .env.box --profile mt5 up -d mt5`.
2. Watch the logs until the terminal has installed and is running (`docker compose --env-file .env.box logs -f mt5`). Look for `[4/7] File ... terminal64.exe is installed. Running MT5...` - this can take 10-20 minutes on a cold box (Mono + the MT5 installer + a Python installer, all downloaded fresh; see "Memory and CPU limits" in `docs/reports/b15-harden.md` for what to expect).
3. On the machine you are administering from (not the box, unless you are sitting at it), open `https://<box address or 127.0.0.1 if tunnelled>:3001` in a browser and accept the self-signed certificate warning. Log in with `CUSTOM_USER`/`PASSWORD` from `.env.box` (KasmVNC's own auth, unrelated to your MT5 login). Port 3001 is bound to the box's loopback interface only (`docker-compose.yml`), so reach it over an SSH tunnel if you are not on the box itself: `ssh -L 3001:127.0.0.1:3001 <box>`.
4. You are looking at the terminal's desktop. Click through the MT5 license dialog if one appears. Log in with the investor login (`MT5_LOGIN`/`MT5_PASSWORD`/`MT5_SERVER`, the same values already in `.env.box` - the terminal likely already attempted this login itself and is sitting at a failed-login or "reconnecting" state; you are only there to click past whatever it is stuck on, not to type credentials into a fresh dialog).
5. Once the terminal shows live prices for XAUUSD in its own Market Watch window, close the VNC tab. You do not need to come back here again unless the login is explicitly revoked at the broker or the `mt5_data` volume is deleted.
6. Confirm the bridge sees it: `docker compose --env-file .env.box logs -f mt5` should show `terminal connected=True` from `[bridge]`, then a stream of tick lines has started (it only logs on connect/disconnect transitions, not per tick - use `docker compose exec mt5 curl -s http://localhost:8766/healthz` to confirm ticks are actually flowing, or connect a WebSocket client to `mt5:8765` from inside the compose network).

### If the bridge never starts

`mt5/entrypoint.sh` waits for the base image's own install (`start.sh`) to
finish before touching anything, then runs `bridge.py` under a supervised
retry loop that never exits the container (`docs/reports/b15-harden.md`
"Second pass"). Because of that, the container should always reach a
running state eventually - restarts alone are not a sign of trouble, and
`/healthz` reporting `bridge: down` while it retries is expected, not a bug.

What is a real sign of trouble: the same failure repeating past what a
one-time cold install explains - `docker compose --env-file .env.box logs -f
mt5` shows `[entrypoint] pip install failed` or a Python traceback on every
restart, or `/healthz` never leaves `bridge: down` for more than a few
minutes on a box with a working network connection.

This almost always means the `mt5_data` volume itself is poisoned - a
half-installed Wine Python (or a partial pip install) landed on it before
this hardening pass existed, and `start.sh`'s own checks (`if [ -e
"$mt5file" ]`, `if ! wine python --version`) see the broken files as
"already installed" and skip reinstalling them forever, no matter how good
the readiness wait around them is. There is no in-place repair for that -
delete the volume and let `start.sh` install from scratch:

```
mt5/reset-volume.sh [.env.box]
```

This stops the `mt5` service, removes `<project>_mt5_data`, and brings it
back up on a fresh volume. Treat the result as a cold boot: follow "First
login" above again once the terminal is installed.

## Status 2026-09-17 (owner's dashboard check)

What the owner sees in the MetaApi app: one MT account created under "MT accounts" (id and tags visible), state **undeployed**, connection **disconnected**. The Deploy action asks for billing details and a deposit first.

What MetaApi's public docs say (their pricing figures are only on the JavaScript pricing widget, so numbers below are from the docs and our earlier estimate):

- Charging happens only while an account is **deployed**; an undeployed account costs nothing, and a deployed one is billed in 6-hour blocks each time it starts (FAQ).
- "API access to one MetaTrader account is free of charge" appears in the SDK read-mes, but the app still wants a payment method and a prepaid balance on file before it deploys anything; there is no card-free path to a deployed account. The earlier estimate for our load stands: one **regular** reliability account, about 30 USD a month; prepay one month.
- A MetaApi-created MT5 demo account (the scope the current token already has) does not avoid this: it also has to be deployed.

Steps in the app, in order:

1. Billing: add the payment method and top up the minimum the deposit screen offers (one month of a regular account covers the expo).
2. MT accounts, open the account, **Deploy**. Wait until state is `DEPLOYED` and connection is `CONNECTED` (a minute or two). The login used must be the **investor** (read-only) password.
3. In the same account's settings set **Quote streaming interval** to `0` (default 2.5 s is too slow for a 5 s round).
4. Copy the account **id** (a UUID, not the MT login number). That is `METAAPI_ACCOUNT_ID`.
5. Auth / Tokens: create a token whose scopes include account management **read** and real-time streaming (the token we have carries only `createMT5DemoAccount` plus streaming and is refused). That is `METAAPI_TOKEN`.
6. Confirm the broker's gold symbol name on that server (`XAUUSD`, `XAUUSD.` or `GOLD`). That is `METAAPI_SYMBOL`.
7. Follow "Hook-up procedure" above from step 2.

Local Docker alternative (B15): the "Bridge route" above is built, reviewed, hardened and merged; its clean-volume cold boot (about 12 minutes) and warm restart were verified on 2026-09-17 with no credentials configured. It needs the broker's investor login the same as MetaApi does; its advantage is no per-account fee and no streaming interval cap.
