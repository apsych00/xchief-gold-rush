#!/usr/bin/env bash
# deploy/deploy.sh - one-command deploy on the box (docs/box-deploy.md).
# Run as the deploy user. Pulls the deploy branch, builds the client bundle
# inside Docker (Node never touches the host), brings the stack up, and
# waits for it to answer before declaring success. Safe to run twice in a
# row: with nothing new to pull it still rebuilds (cheap, layer-cached),
# restarts nothing that does not need it, and prints status.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/goldrush}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-dev}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1/health}"
STATUS_URL="${STATUS_URL:-http://127.0.0.1/status}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"

fail() {
  echo "deploy.sh: FAILED - $1" >&2
  telegram_alert_deploy_failed
  exit 1
}

[ -d "$REPO_DIR/.git" ] || fail "$REPO_DIR is not a git checkout (run deploy/install.sh first)"
cd "$REPO_DIR"

# Load optional Telegram credentials so deploy alerts can use the same bot as the server.
if [ -f .env.box ]; then
  set -a
  # shellcheck source=/dev/null
  . .env.box
  set +a
fi

telegram_alert() {
  local text="$1"
  local token="${TELEGRAM_BOT_TOKEN:-}"
  local chat_id="${TELEGRAM_CHAT_ID:-}"
  [ -n "$token" ] && [ -n "$chat_id" ] || return 0
  curl -s -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    -d "chat_id=${chat_id}" \
    -d 'parse_mode=HTML' \
    -d 'disable_web_page_preview=true' \
    -d "text=${text}" > /dev/null 2>&1 || true
}

telegram_alert_deploy_done() {
  local sha
  sha="$(git rev-parse --short HEAD)"
  telegram_alert "<b>[info] Gold Rush</b>%0ADeploy complete: ${sha}"
}

telegram_alert_deploy_failed() {
  telegram_alert '<b>[critical] Gold Rush</b>%0ADeploy failed%0A<i>Do:</i> Run deploy/rollback.sh'
}

# rollback.sh leaves the repo on a detached commit on purpose; re-syncing to
# the branch tip here would silently undo the rollback. Only fetch/checkout
# when we are actually tracking the deploy branch.
current_ref="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_ref" = "HEAD" ]; then
  echo "==> detached HEAD at $(git rev-parse --short HEAD) - skipping fetch/pull (rollback in progress)"
else
  echo "==> fetching $DEPLOY_BRANCH"
  git fetch --prune || fail "git fetch failed"
  git checkout "$DEPLOY_BRANCH" || fail "git checkout $DEPLOY_BRANCH failed"
  git pull --ff-only || fail "git pull --ff-only failed - the box has local commits or diverged history, which this script never merges"
fi

echo "==> building the client bundle inside Docker (client.Dockerfile)"
tmp_dist="$(mktemp -d)"
if ! docker build -f client.Dockerfile --output "type=local,dest=$tmp_dist" .; then
  rm -rf "$tmp_dist"
  fail "client image build failed"
fi
[ -f "$tmp_dist/index.html" ] || { rm -rf "$tmp_dist"; fail "client build produced no index.html"; }
rm -rf dist
mv "$tmp_dist" dist

echo "==> building and starting the box (docker compose)"
docker compose --env-file .env.box up -d --build || fail "docker compose up failed"

echo "==> waiting for $HEALTH_URL (up to ${HEALTH_TIMEOUT}s)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
until curl -fsS "$HEALTH_URL" > /dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    fail "$HEALTH_URL did not answer within ${HEALTH_TIMEOUT}s - check: docker compose --env-file .env.box logs server"
  fi
  sleep 2
done

echo "==> healthy. current status ($STATUS_URL):"
curl -fsS "$STATUS_URL" || fail "server answered $HEALTH_URL but not $STATUS_URL"
echo
telegram_alert_deploy_done
echo "==> deploy complete, $(git rev-parse --short HEAD) is live"
