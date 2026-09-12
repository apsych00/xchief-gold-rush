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

## Rules (as designed)

- A win pays 100 base points × the selected lever. A miss deducts nothing.
- The lever locks once a round starts and unlocks on "دور بعدی".
- Prices are simulated locally (random walk around 2500, clamped to ±1).
