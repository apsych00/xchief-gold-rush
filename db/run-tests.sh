#!/usr/bin/env bash
# Box database harness: apply every migration in db/migrations/ (filename order) plus
# db/seed.sql on a throwaway STOCK postgres:16 container (not the supabase image, not the
# Supabase dev project), then run every pgTAP suite in db/tests/ with pg_prove.
#
#   npm run db:test        from the repo root
#   bash db/run-tests.sh   also runs directly from Git Bash on Windows or Linux/macOS bash
#
# Exit code is pg_prove's. The container is removed on every exit path.

set -euo pipefail

DB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Work from the repo root so every docker argument is a relative path: the absolute Windows
# path here contains a space ("Kayhan Azadi") and spaces break native-path handling.
cd "$DB_DIR/.."

IMAGE="goldrush-box-db-test"
NAME="goldrush-box-test-$$-${RANDOM}"
PORT=55432

# pgcrypto was installed into the `extensions` schema by 0000_compat (mirroring Supabase) and
# seed.sql calls crypt()/gen_salt() unqualified, so sessions need extensions on the path.
# pgTAP itself then installs into plain `public`, where 0000_compat's default table privileges
# let the `anon` role record assertions inside the "set local role anon" suites.
PGOPTIONS="-c search_path=public,extensions"

command -v docker >/dev/null 2>&1 || { echo "docker is required but not on PATH" >&2; exit 1; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> building $IMAGE (db/Dockerfile)"
docker build -q -t "$IMAGE" db >/dev/null

echo "==> starting throwaway container $NAME on host port $PORT"
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

echo "==> applying db/migrations/*.sql in filename order"
for f in db/migrations/*.sql; do
  echo "    $f"
  docker exec -i -e PGOPTIONS="$PGOPTIONS" "$NAME" \
    psql -v ON_ERROR_STOP=1 -U postgres -q < "$f"
done

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

exit "$rc"
