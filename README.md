# xChief Gold Rush

Mobile mini-game implemented from the Claude Design file
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

## Afghanistan landing (`/af/`)

`af/index.html` is a second Vite entry (see `vite.config.js`) that renders the
welcome-bonus landing page for Afghan traders, implemented from the Figma Make
design "Redesign with Real Images" in both its mobile and desktop layouts:

- `src/af/Landing.jsx` — sections (nav, hero, steps, features, FAQ, final CTA) and
  the fixed registration bars (full-width mobile bar / 80 px desktop bar). Copy
  lives in the `STEPS`, `FEATURES` and `FAQS` arrays at the top of the file.
- `src/af/landing.css` — plain CSS translated from the design's Tailwind theme
  (background `#0f1115`, card `#181b21`, primary emerald `#10b981`, Vazirmatn).
- `public/af/` — hero images (desktop 1672×941, mobile 941×1672, re-encoded from
  the design's PNGs as JPEG) and `presenter.jpg`, a 4:3 crop of the presenter
  photo used in the features section.

Every CTA points to `VITE_AF_REGISTER_URL` (defaults to the campaign link from the
design). After `npm run build` the page is at `dist/af/index.html`, so on Vercel it
is served at `https://<domain>/af/`.

## Branding

`public/logo.svg` is the official xChief wordmark (from xchief.com) with the
dark strokes recoloured white for the dark UI; `public/logo-dark.svg` is the
untouched original for light backgrounds. `src/Logo.jsx` renders it in the top
bar and falls back to `public/logo.png` (if you add one) or a small inline SVG.
`public/favicon.svg` is the X-mark tab icon.

## Languages

The UI ships **English only** for now (`ENABLED_LANGS = ['en']` in
`src/i18n.js`). The Persian strings are kept in the same file; to re-enable
the language pill and RTL layout set `ENABLED_LANGS = ['fa', 'en']` and, if
Persian should be the default, `DEFAULT_LANG = 'fa'`.

## Updates in Telegram / Instagram in-app browsers

In-app browsers cache the app shell hard and have no reload button, so
visitors who opened an old link kept seeing the old build. Three layers fix
this:

- `vercel.json` sends `no-store` for `/`, `index.html`, `version.json` and the
  manifest, and long-lived `immutable` caching only for hashed `/assets/*`.
- Every build gets an id (`__BUILD_ID__`, from the Vercel commit SHA) and
  writes `dist/version.json`. `src/UpdateBanner.jsx` polls that file every
  minute and on tab focus; when the deployed id differs it shows "A new
  version of the game is ready · Update", which reloads with a cache-busting
  query.
- When sharing the link in Telegram, append a query such as `?v=2` after each
  deploy so Telegram's link preview cache is bypassed as well.

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

0. **The price relay** (`relay/`, see its README) when `VITE_RELAY_URL` is
   set. One always-on service holds the single Finnhub connection and fans the
   broker XAU/USD quote out to every player, so any number of devices can play
   at once and all see the same price. This is the setup for the expo.
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

## Game economy

Everything below is tunable in `src/config.js` (links, PIN and video also via
env vars, see `.env.example`).

- **Coins.** Every player starts with 1,000. Each round stakes 100 × lever
  (×1 = 100, ×2 = 200, ×5 = 500). A correct call wins the stake, a wrong call
  loses it, an unchanged price (FLAT) returns it. Levers you cannot afford are
  locked; below 100 coins the console shows "out of coins" and points to the
  tasks screen.
- **Streaks.** The 3rd and 4th consecutive win pay ×1.5, the 5th and beyond
  ×2. A loss resets the streak. First win of each day adds +100.
- **Record & levels.** The best balance ever reached is the player's record.
  The leaderboard ranks by record (losing never drops your rank). Levels by
  record: Rookie → Trader (2,000) → Pro (5,000) → Gold Chief (10,000).
- **Badges.** High Roller (win at ×5), Hot Streak (5 in a row), Comeback
  (new record right after being broke).
- **Rate limit.** 60 rounds per hour per device.

## Refill tasks

The "Coins" tab lists one-time tasks that pay coins so a broke player can come
back: 15 s promo video (+100, repeatable every 5 min), email (+200), Instagram
/ Telegram / YouTube follow (+300 each), story share (+300 daily), reviews on
Trustpilot / Google / Forex Peace Army (+500 each) and opening an xChief demo
account (+1,000, featured last as the "fast way back").

Link tasks open the target in a new tab; the "Done" button unlocks after 15 s.
With `VITE_TASK_VERIFY=pin` (expo mode) booth staff must also enter
`VITE_STAFF_PIN` before coins are granted. Claims are stored per device in
`localStorage` (`xchief.profile.v1`). A shared, server-side leaderboard and
profile store is the next step if the game runs on several devices at once.

## Layout

The UI is a fixed, non-scrolling app shell (`position: fixed` root, safe-area
insets, PWA manifest for "Add to Home Screen"). Screens use flex/clamp sizing;
the console's fixed-pixel lever art is scaled by a runtime factor computed
from the frame size (`--s`), so it fits 360×640 Androids, tall iPhones and the
desktop phone frame alike without scrolling. Only long lists (leaderboard,
tasks) scroll inside their own panel.
