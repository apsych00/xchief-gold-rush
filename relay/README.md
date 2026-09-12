# Gold price relay

One small always-on Node service that keeps a single upstream connection per
price source and broadcasts every tick to any number of browsers. It exists
because a Finnhub key allows only one open socket, and because everyone at the
booth should see exactly the same quote.

## Run locally

```bash
cd relay
npm install
FINNHUB_TOKEN=your_key node server.js
# ws://localhost:8787/ws   http://localhost:8787/health
```

Then in the app's `.env.local`:

```
VITE_RELAY_URL=ws://localhost:8787/ws
```

## Deploy (pick one)

- **Fly.io** (no sleep, ~free): `cd relay && fly launch --copy-config --no-deploy`,
  `fly secrets set FINNHUB_TOKEN=...`, `fly deploy`. URL: `wss://<app>.fly.dev/ws`.
- **Render**: New → Blueprint → this repo (uses `render.yaml`). Set
  `FINNHUB_TOKEN`. URL: `wss://<service>.onrender.com/ws`. Use the Starter plan
  so it never sleeps during the event.
- **Any VPS / Docker**: `docker build -t gold-relay relay && docker run -p 8787:8787 -e FINNHUB_TOKEN=... gold-relay`
  behind an HTTPS reverse proxy (the app is served over HTTPS, so the relay
  must be `wss://`).

After deploying, set `VITE_RELAY_URL` on Vercel (Production + Preview) to the
`wss://.../ws` address and redeploy the app. The browser feed treats the relay
as the top-priority source and still falls back to public exchange sockets if
the relay is unreachable.

## Endpoints

- `GET /health` — `{ ok, clients, price, symbol, source, sources[] }`
- `GET /price` — last published price
- `WS /ws` — `hello` on connect, then `price` frames, `status` on source
  change, `ping` every 25 s
