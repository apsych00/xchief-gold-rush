#!/usr/bin/env bash
# deploy/autodeploy.sh - cron entry point (installed by deploy/install.sh,
# runs every minute). Only calls deploy.sh when the deploy branch has moved;
# a flock guards against two runs overlapping if a deploy runs long.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/goldrush}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-dev}"
LOG_FILE="${LOG_FILE:-/var/log/goldrush-deploy.log}"
LOCK_FILE="${LOCK_FILE:-/tmp/goldrush-autodeploy.lock}"

exec 9>"$LOCK_FILE"
flock -n 9 || exit 0 # a previous run is still deploying; skip this tick

cd "$REPO_DIR"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if ! git fetch --prune origin "$DEPLOY_BRANCH" >/dev/null 2>&1; then
  echo "$(ts) git fetch failed, skipping this tick" >> "$LOG_FILE"
  exit 0
fi

local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse "origin/$DEPLOY_BRANCH")"

if [ "$local_head" = "$remote_head" ]; then
  echo "$(ts) up to date at ${local_head:0:12}" >> "$LOG_FILE"
  exit 0
fi

echo "$(ts) $DEPLOY_BRANCH moved ${local_head:0:12} -> ${remote_head:0:12}, deploying" >> "$LOG_FILE"
if "$REPO_DIR/deploy/deploy.sh" >> "$LOG_FILE" 2>&1; then
  echo "$(ts) deploy succeeded, now at $(git rev-parse --short HEAD)" >> "$LOG_FILE"
else
  echo "$(ts) deploy FAILED, see log lines above" >> "$LOG_FILE"
  exit 1
fi
