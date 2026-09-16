#!/usr/bin/env bash
# Box database harness: apply db/schema.sql (the whole schema as one file) plus
# db/seed.sql on a throwaway STOCK postgres:16 container (not the supabase image, not the
# Supabase dev project), then run every pgTAP suite in db/tests/ with pg_prove.
#
#   npm run db:test           from the repo root
#   bash db/run-tests.sh      also runs directly from Git Bash on Windows or Linux/macOS bash
#   bash db/run-tests.sh --keep
#       leaves the container running on host port 55432 (user postgres, password test, db
#       postgres) instead of removing it on exit, and prints DATABASE_URL for a test suite
#       (e.g. test/integration-box) to target. Re-running with --keep replaces the previous
#       kept container rather than stacking new ones.
#
# Exit code is pg_prove's, except that --keep always exits 0 once the container is up and
# migrated, so a red pgTAP run does not stop you from pointing a test suite at the database.
# The container is removed on every exit path unless --keep was given.

set -euo pipefail

KEEP=""
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

DB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Work from the repo root so every docker argument is a relative path: the absolute Windows
# path here contains a space ("Kayhan Azadi") and spaces break native-path handling.
cd "$DB_DIR/.."

IMAGE="goldrush-box-db-test"
PORT=55432
if [ -n "$KEEP" ]; then
  NAME="goldrush-box-keep"
else
  NAME="goldrush-box-test-$$-${RANDOM}"
fi
DATABASE_URL="postgresql://postgres:test@localhost:${PORT}/postgres"

# pgcrypto was installed into the `extensions` schema by the compat layer in db/schema.sql
# (mirroring Supabase) and seed.sql calls crypt()/gen_salt() unqualified, so sessions need
# extensions on the path. pgTAP itself then installs into plain `public`, where schema.sql's
# default table privileges let the `anon` role record assertions inside the "set local role
# anon" suites.
PGOPTIONS="-c search_path=public,extensions"

command -v docker >/dev/null 2>&1 || { echo "docker is required but not on PATH" >&2; exit 1; }

if [ -n "$KEEP" ]; then
  # A previous --keep run left this name behind: replace it rather than fail on name collision.
  docker rm -f "$NAME" >/dev/null 2>&1 || true
else
  cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
fi

echo "==> building $IMAGE (db/Dockerfile)"
docker build -q -t "$IMAGE" db >/dev/null

echo "==> starting $([ -n "$KEEP" ] && echo "kept" || echo "throwaway") container $NAME on host port $PORT"
docker run -d --name "$NAME" -p "$PORT:5432" \
  -e POSTGRES_PASSWORD=test \
  "$IMAGE" >/dev/null

# The entrypoint runs initdb against a temporary server and restarts; answering clients during
# that window would run migrations into a server about to stop. Accept readiness only once the
# init phase is over (entrypoint marker, or the second "ready" log line) AND a query works.
echo "==> waiting for postgres to be ready"
ready=""
for _ in $(seq 1 120); do
  if [ "$(docker exec "$NAME" psql -U postgres -tAc 'select 1' 2>/dev/null || true)" = "1" ]; then
    logs="$(docker logs "$NAME" 2>&1 || true)"
    if printf '%s' "$logs" | grep -q 'ready for start up' \
      || [ "$(printf '%s' "$logs" | grep -c 'database system is ready to accept connections' || true)" -ge 2 ]; then
      ready=1
      break
    fi
  fi
  sleep 0.5
done
if [ -z "$ready" ]; then
  echo "postgres did not become ready in time" >&2
  docker logs "$NAME" >&2 || true
  exit 1
fi

echo "==> applying db/schema.sql"
docker exec -i -e PGOPTIONS="$PGOPTIONS" "$NAME" \
  psql -v ON_ERROR_STOP=1 -U postgres -q < db/schema.sql

echo "==> applying db/seed.sql"
docker exec -i -e PGOPTIONS="$PGOPTIONS" "$NAME" \
  psql -v ON_ERROR_STOP=1 -U postgres -q < db/seed.sql

echo "==> running pg_prove over db/tests/"
docker cp db/tests "$NAME:/box-tests"
# sh -c keeps the container-side absolute path inside one string so Git Bash's
# MSYS path conversion cannot rewrite it.
set +e
docker exec -e PGOPTIONS="$PGOPTIONS" "$NAME" \
  sh -c 'exec pg_prove -U postgres -d postgres --ext .sql /box-tests'
rc=$?
set -e

if [ -n "$KEEP" ]; then
  echo "==> container $NAME left running (pg_prove exit code was $rc)"
  echo "DATABASE_URL=$DATABASE_URL"
  exit 0
fi

exit "$rc"
