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

- `src/App.jsx` — screens: top bar, Home, game Console (display + lever body), Leaderboard, bottom Nav.
- `src/useGame.js` — game state and round logic (price random walk, 5-second timer, scoring).
- `src/format.js` — Persian digit / price formatting helpers.
- `src/styles.css` — all styling, translated from the design's inline styles.

## Rules (as designed)

- A win pays 100 base points × the selected lever. A miss deducts nothing.
- The lever locks once a round starts and unlocks on "دور بعدی".
- Prices are simulated locally (random walk around 2500, clamped to ±1).
