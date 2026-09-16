# Game server image (docs/box-spec.md 1.7, ticket 6).
# Boots by applying db/schema.sql + db/seed.sql through server/migrate.mjs
# (a schema_migrations table makes re-runs a no-op), then starts the game server.
FROM node:22-alpine

WORKDIR /app

# Dependencies only, so this layer survives ordinary code changes.
# Production deps are all the server needs (pg, ws); dev tooling stays out.
# (The lockfile must be regenerated with npm on linux, not Windows: npm on
# win32 prunes wasm-fallback optional deps that `npm install --no-audit --no-fund` then misses here.)
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund
# The MetaApi SDK for the MT5 price source (docs/mt5-feed.md). Deliberately not in
# package.json (large, old-pinned tree); baked into the image so hooking MT5 up is only the
# three METAAPI_* values in .env.box and a restart. Loaded lazily by server/feed-mt5.js.
RUN npm install --omit=dev --no-save --no-audit --no-fund metaapi.cloud-sdk

COPY server/ ./server/
COPY db/ ./db/
# Ops scripts run here too: docker compose exec server node scripts/gen-kiosk.mjs ...
COPY scripts/ ./scripts/

ENV NODE_ENV=production \
    PORT=8787

EXPOSE 8787

# exec: node becomes PID 1, so docker stop/restart sends it SIGTERM directly.
CMD ["sh", "-c", "node server/migrate.mjs && exec node server/index.js"]
