# Client build (docs/box-architecture.md 1b): builds the Vite bundle inside
# Docker so Node is never installed on the box, and so the bundle can never
# pick up a developer .env - `vite build` defaults to mode=production, which
# reads only .env.production (VITE_GAME_WS=auto), and .dockerignore keeps
# .env/.env.public out of the build context entirely.
#
# Extract the bundle without leaving a container behind:
#   docker build -f client.Dockerfile --output type=local,dest=dist .

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# npm install, not npm ci: the lockfile is regenerated on Windows, which prunes
# wasm-fallback optional deps that ci then reports as missing (server/Dockerfile
# has the same note).
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM scratch AS export
COPY --from=build /app/dist /
