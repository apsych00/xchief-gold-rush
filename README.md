# xChief Gold Rush

Persian-language mobile mini-game implemented from the Claude Design file
`xChief Gold Rush App.dc.html`. Predict whether gold (XAUUSD) goes up or down in
the next 5 seconds, pick a points lever (×1 / ×2 / ×5), and climb the leaderboard.

## Run

```bash
npm install
npm run dev
```

Open the printed URL (default `http://localhost:5173`). `npm run build` writes a
static bundle to `dist/`, which can be hosted on any static file server.

## Structure

- `src/App.jsx` — screens: top bar (logo, language switch, balance), Home, game Console (display + lever body), Leaderboard, bottom Nav.
- `src/useGame.js` — game state and round logic (price random walk, 5-second timer, scoring).
- `src/i18n.js` — Persian / English strings, number formatting, language context.
- `src/LeadCapture.jsx` — one-field email capture (Home card + Leaderboard slim variant).
- `src/styles.css` — all styling, translated from the design's inline styles.
- `api/lead.js` — Vercel serverless endpoint that receives leads.

## Languages

Persian (RTL, Persian digits) is the default. The pill next to the logo toggles
English (LTR, Latin digits). The choice is remembered in `localStorage`.

## Lead capture

The email form is a real `<form>` with `type="email"`, `name="email"`,
`autocomplete="email"` and `inputmode="email"`, so browsers and password
managers offer one-tap autofill. Submission is instant: the lead is saved to
`localStorage` first (the form flips to "Saved"), then POSTed to `/api/lead`
with `keepalive` so it survives a tab close.

On the server every lead is logged (Vercel → project → Logs, filter `[lead]`).
To also push leads somewhere durable, set the environment variable
`LEAD_WEBHOOK_URL` on Vercel to any HTTPS endpoint that accepts JSON: a Google
Apps Script web app writing to a Sheet, Zapier/Make, a CRM or mailing-list
webhook. The payload:

```json
{ "email": "...", "source": "home|leaderboard", "lang": "fa|en", "balance": 2400,
  "page": "/", "ua": "...", "country": "IR", "at": "2026-09-12T10:00:00.000Z" }
```

## Live gold price

`src/priceFeed.js` streams the real gold price over WebSockets. Sources are
raced in parallel and ranked by priority:

1. **XAU/USD from forex brokers (OANDA, IC Markets) via Finnhub.** Real spot
   gold, the same quote traders see. Needs `VITE_FINNHUB_TOKEN` (free key from
   finnhub.io, see `.env.example`). One key allows one open connection, so a
   second device automatically falls back to the sources below.
2. **PAXG/USD from OKX and Binance** (no key). Paxos Gold, one token = one troy
   ounce; usually within a few dollars of spot. Settles on the mid price,
   (bid + ask) / 2.
3. Kraken PAXG/USD.

The first source to deliver a price wins; if a better-ranked source starts
ticking within 12 s it takes over. If the active source drops, the race
restarts automatically.
- If no socket answers within 5 s, a REST poller (Binance, then gold-api.com
  XAU spot) takes over at 1 request/second.
- If nothing answers within 9 s, prices are simulated and the badge reads
  DEMO. The moment a real source connects, the game switches to LIVE.
- The badge in the game screen shows the current state and source.

**Quiet-market layer.** When the real quote has not changed for 3 seconds
(weekends, holidays, dead minutes), the feed simulates micro-moves (±$0.35,
mean-reverting) on top of the last real price so rounds keep settling and the
chart keeps moving. The badge turns gold and reads "QUIET MARKET · <source>".
The first real price change snaps back to the market and ends the simulation.

A round where the price is exactly unchanged after 5 seconds ends as FLAT
(no points), which with the quiet layer should be rare.

To use a broker feed instead (for example an MT5 bridge), add an entry to
`WS_SOURCES` in `src/priceFeed.js` with its URL, subscribe message and a
`parse()` that returns the price.

## Rules (as designed)

- A win pays 100 base points × the selected lever. A miss deducts nothing.
- The lever locks once a round starts and unlocks on "دور بعدی".
