#!/usr/bin/env bash
# deploy/rollback.sh <commit> - move the box to a known-good commit and
# deploy it. Leaves the repo in detached HEAD on purpose; deploy.sh detects
# that and skips its usual fetch/checkout of the deploy branch, so the next
# manual deploy.sh run does not silently undo the rollback.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/goldrush}"

commit="${1:-}"
[ -n "$commit" ] || { echo "usage: deploy/rollback.sh <commit>" >&2; exit 1; }

[ -d "$REPO_DIR/.git" ] || { echo "rollback.sh: $REPO_DIR is not a git checkout" >&2; exit 1; }
cd "$REPO_DIR"

git fetch --prune || { echo "rollback.sh: git fetch failed" >&2; exit 1; }
git checkout "$commit" || { echo "rollback.sh: no such commit: $commit" >&2; exit 1; }

echo "==> rolled back to $(git rev-parse --short HEAD), deploying"
exec "$REPO_DIR/deploy/deploy.sh"
