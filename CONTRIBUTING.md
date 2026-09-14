# Contributing

## Setup

```bash
npm install
cp .env.example .env.local   # fill in what you need
npm run dev                  # http://localhost:5173
```

Optional price relay for multi-device play:

```bash
cd relay && npm install && FINNHUB_TOKEN=... node server.js
# then set VITE_RELAY_URL=ws://localhost:8787/ws in .env.local
```

## Checks

```bash
npm run lint          # eslint
npm run format:check  # prettier
npm test              # economy rules (node --test)
npm run build         # production bundle + dist/version.json
```

CI runs all four on every push and pull request.

## Conventions

- Branch from `main`, open a PR, keep it small. `main` auto-deploys to
  production on Vercel.
- Game rules and tunables live in `src/config.js`; do not hard-code numbers
  in components.
- All user-facing text goes through `src/i18n.js` (English is shipped,
  Persian is kept for later).
- Every screen must fit 360×640 and 390×844 without page scroll; only lists
  scroll inside their own panel.
- Never commit secrets. `.env*` is ignored; use `.env.example` to document
  new variables and set real values in Vercel.
