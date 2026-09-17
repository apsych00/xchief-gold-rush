#!/bin/bash
# Recovery for a poisoned mt5_data volume (docs/mt5-feed.md "If the bridge
# never starts"). entrypoint.sh's readiness wait (start.sh's own step 6,
# docs/reports/b15-harden.md "Second pass") stops a half-installed Python
# from ever being handed to pip or bridge.py again, but it cannot repair a
# volume that already has a broken install baked into it from before that
# fix existed - start.sh's own checks (`if [ -e "$mt5file" ]`, `if ! wine
# python --version`) see the broken files as "already installed" and skip
# reinstalling them forever. The only way out is to delete the volume and
# let start.sh run its install from scratch.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${1:-.env.box}"
PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$(pwd)")}"
VOLUME="${PROJECT}_mt5_data"

echo "[reset-volume] project: $PROJECT, env file: $ENV_FILE, volume: $VOLUME"
echo "[reset-volume] stopping the mt5 service..."
docker compose --env-file "$ENV_FILE" --profile mt5 -p "$PROJECT" down

echo "[reset-volume] removing $VOLUME (deletes the MT5 login state and every installed dependency - a full reinstall follows)..."
docker volume rm "$VOLUME"

echo "[reset-volume] bringing the mt5 service back up on a fresh volume..."
docker compose --env-file "$ENV_FILE" --profile mt5 -p "$PROJECT" up -d mt5

echo "[reset-volume] done - this is a cold boot again, follow docs/mt5-feed.md 'First login'."
