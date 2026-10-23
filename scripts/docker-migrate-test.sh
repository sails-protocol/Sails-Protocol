#!/usr/bin/env bash
# scripts/docker-migrate-test.sh
#
# Builds the MIGRATION image (`docker build --target migrate`) and runs THAT image against a
# throwaway PostgreSQL. Nothing here touches any real database: the only database is the
# container this script starts, with a random password, and the script removes it on exit.
#
# What it proves (the first failing step stops the script, prints the logs, exits non-zero):
#   1. the image is minimal and safe: non-root, the pinned Node, no server code in it;
#   2. on an EMPTY database `migrate deploy` + `migrate status` apply every committed
#      migration (count == prisma/migrations/*) and the expected tables exist;
#   3. running it AGAIN is a no-op (idempotent): same exit 0, nothing re-applied, and the
#      schema fingerprint and migration checksums are identical;
#   4. it fails closed: DATABASE_URL missing/empty, database unreachable, wrong password and a
#      migration whose SQL is invalid all exit NON-ZERO (and a broken migration leaves the
#      already-applied schema untouched);
#   5. no secret reaches the logs: the database password appears in no output of any run;
#   6. the rollout gate: with a failing migration the server container is NEVER started, with a
#      good one it is (docker compose `service_completed_successfully`); and the repository's
#      real docker-compose.yml still declares that gate on `app`;
#   7. the awkward states a real database is in: malformed DATABASE_URL values, two jobs at
#      once, a partially migrated database, a schema with no migration history (what `db push`
#      leaves: refused with P3005, then baselined exactly as docs/DEPLOYMENT.md 6.0.1 says),
#      and a recorded failed migration (blocks with P3009 until resolved, then converges) —
#      each preserving data written before the run;
#   8. the Dockerfile's LAST stage is `runtime`, i.e. what a plain `docker build` (and App
#      Runner's source build) produces is the server, never the migration job.
# Everything runs on an `--internal` network: no internet at all.
#
# Usage: bash scripts/docker-migrate-test.sh        (from the repo root)
#        PG_IMAGE=postgres:18-alpine bash scripts/docker-migrate-test.sh

set -euo pipefail
cd "$(dirname "$0")/.."

RUN="sailsmig$$"
# A tag unique to this run: concurrent runs (and mutation testing) must never share an image.
IMAGE="${MIGRATE_IMAGE_TAG:-${RUN}-migrate:local}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
NETWORK="${RUN}_net"
DB="${RUN}-pg"
BROKEN_IMAGE="${RUN}-broken:local"
PARTIAL_IMAGE="${RUN}-partial:local"
PASSWORD="pw-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
# Inside the repo, not /tmp: the build context below must be visible to the Docker daemon
# (e.g. Docker Desktop reached from WSL cannot see the WSL /tmp). Removed on exit.
LOGS="$(mktemp -d "$PWD/.migrate-test.XXXXXX")"
STEP="starting"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo
    echo "::group::FAILED during: ${STEP} (exit ${status})"
    tail -n 40 "$LOGS"/*.log 2>/dev/null || true
    echo "::endgroup::"
  fi
  docker compose -p "${RUN}g" down -v --remove-orphans >/dev/null 2>&1 || true
  docker compose -p "${RUN}b" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$DB" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker rmi -f "$BROKEN_IMAGE" "$PARTIAL_IMAGE" "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$LOGS"
  exit "$status"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { STEP="$*"; echo; echo "=== $*"; }
pass() { echo "PASS  $*"; }
psql_q() { docker exec "$DB" psql -h 127.0.0.1 -U postgres -d sails -Atc "$1"; }
# The awkward-state scenarios each get their own database in the same throwaway server.
newdb() { docker exec "$DB" psql -h 127.0.0.1 -U postgres -d postgres -Atc "create database $1" >/dev/null; }
psql_db() { docker exec "$DB" psql -h 127.0.0.1 -U postgres -d "$1" -Atc "$2"; }
url_db() { echo "postgresql://postgres:${PASSWORD}@${DB}:5432/$1"; }
PRISMA_CLI="node_modules/prisma/build/index.js"

# run_migrate <name> <expected: 0|nonzero|N> [docker run args...]  -> $LOGS/<name>.log, sets STATUS
run_migrate() {
  local name="$1" expect="$2"
  shift 2
  STATUS=0
  timeout 180 docker run --rm --network "$NETWORK" "$@" >"$LOGS/$name.log" 2>&1 || STATUS=$?
  case "$expect" in
    0) [ "$STATUS" -eq 0 ] || fail "$name: expected exit 0, got $STATUS" ;;
    nonzero) { [ "$STATUS" -ne 0 ] && [ "$STATUS" -ne 124 ]; } || fail "$name: expected a failure exit, got $STATUS" ;;
    *) [ "$STATUS" -eq "$expect" ] || fail "$name: expected exit $expect, got $STATUS" ;;
  esac
}

URL="postgresql://postgres:${PASSWORD}@${DB}:5432/sails"
EXPECTED_MIGRATIONS=$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
[ "$EXPECTED_MIGRATIONS" -gt 0 ] || fail "no migrations found under prisma/migrations"

step "Build the migration image: docker build --target migrate"
docker build --target migrate -t "$IMAGE" .

step "Image properties"
[ "$(docker run --rm --entrypoint id "$IMAGE" -u)" != "0" ] || fail "the migration image runs as root"
pass "runs as a non-root user"
PINNED=$(grep -E '^FROM node:' Dockerfile | sed -E 's/^FROM node:([0-9]+\.[0-9]+\.[0-9]+)-.*/\1/' | sort -u)
[ "$(docker run --rm --entrypoint node "$IMAGE" -p process.versions.node)" = "$PINNED" ] || fail "Node is not the pinned $PINNED"
pass "Node $PINNED (pinned in the Dockerfile)"
docker run --rm --entrypoint sh "$IMAGE" -c 'test ! -e /app/dist && test ! -e /app/packages' || fail "server code is present in the migration image"
pass "no server code (dist/, packages/) in the image"
# libssl3 is installed unpinned on purpose (Dockerfile, `migrate` stage): the base image is
# digest-pinned, the library takes Debian security updates. Recorded here so every run says
# which one it tested; the --internal network below fails the run if Prisma cannot use it.
LIBSSL3=$(docker run --rm --entrypoint dpkg-query "$IMAGE" -W -f '${Version}' libssl3) || fail "libssl3 is not installed in the migration image: the bundled schema engine cannot load"
pass "libssl3 ${LIBSSL3}"
LAST_STAGE=$(grep -E '^FROM .* AS ' Dockerfile | tail -n 1 | sed -E 's/.* AS ([A-Za-z0-9_-]+).*/\1/')
[ "$LAST_STAGE" = "runtime" ] || fail "the Dockerfile's last stage is '$LAST_STAGE', not 'runtime': a plain docker build would not produce the server"
pass "last Dockerfile stage is runtime (a plain docker build / source build is the server)"

step "Start a throwaway PostgreSQL (${PG_IMAGE})"
# --internal: no route out. The job must not need the internet (an engine download at migration
# time would be both a hard dependency and an unpinned binary); here that would fail the run.
docker network create --internal "$NETWORK" >/dev/null
docker run -d --name "$DB" --network "$NETWORK" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=sails "$PG_IMAGE" >/dev/null
ready=0
for _ in $(seq 1 60); do
  # TCP (-h 127.0.0.1): the temporary init server only listens on the unix socket.
  if docker exec "$DB" psql -h 127.0.0.1 -U postgres -d sails -Atc 'select 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || fail "PostgreSQL did not become ready"

step "Fails closed without configuration"
run_migrate no-url 64 --entrypoint sh "$IMAGE" scripts/migrate-deploy.sh
grep -q 'DATABASE_URL is not set' "$LOGS/no-url.log" || fail "missing the explicit DATABASE_URL message"
pass "DATABASE_URL unset -> exit 64, no connection attempted"
run_migrate empty-url 64 -e DATABASE_URL= "$IMAGE"
pass "DATABASE_URL empty -> exit 64"

step "Fails closed on connection problems"
run_migrate unreachable nonzero -e "DATABASE_URL=postgresql://postgres:${PASSWORD}@no-such-host.invalid:5432/sails" "$IMAGE"
pass "unreachable host -> exit ${STATUS}"
run_migrate wrong-port nonzero -e "DATABASE_URL=postgresql://postgres:${PASSWORD}@${DB}:1/sails" "$IMAGE"
pass "closed port -> exit ${STATUS}"
run_migrate wrong-password nonzero -e "DATABASE_URL=postgresql://postgres:not-the-password@${DB}:5432/sails" "$IMAGE"
pass "wrong password -> exit ${STATUS}"
[ "$(psql_q "select count(*) from information_schema.tables where table_schema='public'")" = "0" ] || fail "a failed connection changed the database"

step "Malformed DATABASE_URL values fail closed"
# Each embeds the real password: the final "No secret in any log" step scans these logs too, so a
# parser error that echoes the value back would fail the run there.
i=0
for bad in "postgres//postgres:${PASSWORD}@${DB}/sails" "mysql://postgres:${PASSWORD}@${DB}:3306/sails" "postgresql://postgres:${PASSWORD}@${DB}:notaport/sails" "${PASSWORD}"; do
  i=$((i + 1))
  run_migrate "malformed-$i" nonzero -e "DATABASE_URL=$bad" "$IMAGE"
done
pass "4 malformed values -> non-zero exit, nothing connected"

step "Empty database: migrate deploy + migrate status"
run_migrate first 0 -e "DATABASE_URL=$URL" "$IMAGE"
grep -q 'database is up to date' "$LOGS/first.log" || fail "the success marker is missing"
applied=$(psql_q "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null")
total=$(psql_q "select count(*) from _prisma_migrations")
[ "$applied" = "$EXPECTED_MIGRATIONS" ] && [ "$total" = "$EXPECTED_MIGRATIONS" ] || fail "expected $EXPECTED_MIGRATIONS applied migrations, found $applied of $total"
pass "all $EXPECTED_MIGRATIONS migrations applied and finished"
for t in users offers trades escrows disputes intents proofs idempotency_keys durable_events custody_attestations; do
  [ "$(psql_q "select to_regclass('public.${t}') is not null")" = "t" ] || fail "expected table ${t} was not created"
done
pass "expected tables exist"

fingerprint() {
  psql_q "select md5(coalesce((select string_agg(table_name||'.'||column_name||':'||data_type||':'||is_nullable, ',' order by table_name, ordinal_position) from information_schema.columns where table_schema='public'),'')) || '/' || md5(coalesce((select string_agg(migration_name||':'||checksum, ',' order by migration_name) from _prisma_migrations),''))"
}
# A job that dropped and recreated everything would reproduce the same schema; data written
# before the second run must therefore survive it. (Written BEFORE the fingerprint is taken.)
psql_q "create table migrate_test_sentinel(id int); insert into migrate_test_sentinel values (1)" >/dev/null
BEFORE=$(fingerprint)

step "Second run is idempotent"
run_migrate second 0 -e "DATABASE_URL=$URL" "$IMAGE"
grep -q 'No pending migrations to apply' "$LOGS/second.log" || fail "second run did not report 'No pending migrations to apply'"
grep -q 'Applying migration' "$LOGS/second.log" && fail "second run re-applied a migration"
[ "$(fingerprint)" = "$BEFORE" ] || fail "schema or migration checksums changed on the second run"
[ "$(psql_q 'select count(*) from migrate_test_sentinel')" = "1" ] || fail "data written before the second run did not survive it"
[ "$(psql_q 'select count(*) from _prisma_migrations')" = "$EXPECTED_MIGRATIONS" ] || fail "migration history changed on the second run"
pass "no-op: same exit, nothing applied, schema fingerprint and checksums identical"

step "A broken migration fails the job and leaves the applied schema untouched"
BROKEN_CTX="$LOGS/broken-ctx"
mkdir -p "$BROKEN_CTX/prisma"
cp -r prisma/. "$BROKEN_CTX/prisma/"
mkdir "$BROKEN_CTX/prisma/migrations/99990101000000_broken"
echo 'SELECT * FROM a_table_that_does_not_exist;' >"$BROKEN_CTX/prisma/migrations/99990101000000_broken/migration.sql"
printf 'FROM %s\nCOPY --chown=node:node prisma /app/prisma\n' "$IMAGE" >"$BROKEN_CTX/Dockerfile"
docker build -q -t "$BROKEN_IMAGE" "${BROKEN_CTX#"$PWD"/}" >/dev/null # relative: a Windows-hosted docker cannot resolve an absolute WSL path
run_migrate broken nonzero -e "DATABASE_URL=$URL" "$BROKEN_IMAGE"
pass "invalid SQL -> exit ${STATUS}"
grep -q 'database is up to date' "$LOGS/broken.log" && fail "a failed migration printed the success marker"
[ "$(psql_q "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null")" = "$EXPECTED_MIGRATIONS" ] || fail "applied migrations changed"
[ "$(psql_q "select count(*) from _prisma_migrations where finished_at is null")" = "1" ] || fail "the failed migration was not recorded as failed"
run_migrate broken-again nonzero -e "DATABASE_URL=$URL" "$BROKEN_IMAGE"
pass "re-running while the failure is unresolved still fails (exit ${STATUS}): no silent success"
grep -q 'P3009' "$LOGS/broken-again.log" || fail "the unresolved failure was not reported as P3009"
# docs/DEPLOYMENT.md 6.1: after the operator has dealt with the cause, mark it rolled back; the
# next run must then converge (and the good image does not carry the broken migration).
run_migrate broken-resolve 0 -e "DATABASE_URL=$URL" --entrypoint node "$IMAGE" "$PRISMA_CLI" migrate resolve --rolled-back 99990101000000_broken
run_migrate recovered 0 -e "DATABASE_URL=$URL" "$IMAGE"
[ "$(psql_q "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null")" = "$EXPECTED_MIGRATIONS" ] || fail "after recovery the applied migrations are not the committed ones"
pass "P3009 blocks until resolved (--rolled-back), then the job converges: exit 0, ${EXPECTED_MIGRATIONS} applied"

step "Two migration jobs at the same time on an empty database"
newdb sails_conc
CONC_URL=$(url_db sails_conc)
( run_migrate conc-a 0 -e "DATABASE_URL=$CONC_URL" "$IMAGE" ) &
PID_A=$!
( run_migrate conc-b 0 -e "DATABASE_URL=$CONC_URL" "$IMAGE" ) &
PID_B=$!
wait "$PID_A" || fail "concurrent job A failed (see conc-a.log)"
wait "$PID_B" || fail "concurrent job B failed (see conc-b.log)"
[ "$(psql_db sails_conc "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null")" = "$EXPECTED_MIGRATIONS" ] \
  && [ "$(psql_db sails_conc "select count(*) from _prisma_migrations")" = "$EXPECTED_MIGRATIONS" ] \
  || fail "concurrent jobs left a duplicated or partial migration history"
pass "both jobs exit 0 and every migration was applied exactly once"

step "Partially migrated database: the rest is applied and existing data survives"
newdb sails_part
PART_URL=$(url_db sails_part)
KEEP=$((EXPECTED_MIGRATIONS / 2))
PART_CTX="$LOGS/part-ctx"
mkdir -p "$PART_CTX/migrations"
cp prisma/migrations/migration_lock.toml "$PART_CTX/migrations/"
for m in $(ls prisma/migrations | grep -v '\.toml$' | sort | head -n "$KEEP"); do cp -r "prisma/migrations/$m" "$PART_CTX/migrations/$m"; done
# COPY alone would merge into the image's existing directory: remove it first.
printf 'FROM %s\nRUN rm -rf /app/prisma/migrations\nCOPY --chown=node:node migrations /app/prisma/migrations\n' "$IMAGE" >"$PART_CTX/Dockerfile"
docker build -q -t "$PARTIAL_IMAGE" "${PART_CTX#"$PWD"/}" >/dev/null
run_migrate part-1 0 -e "DATABASE_URL=$PART_URL" "$PARTIAL_IMAGE"
[ "$(psql_db sails_part "select count(*) from _prisma_migrations where finished_at is not null")" = "$KEEP" ] || fail "the partial image did not stop at $KEEP migrations (the scenario would prove nothing)"
psql_db sails_part "create table migrate_test_sentinel(id int); insert into migrate_test_sentinel values (1)" >/dev/null
run_migrate part-2 0 -e "DATABASE_URL=$PART_URL" "$IMAGE"
[ "$(psql_db sails_part "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null")" = "$EXPECTED_MIGRATIONS" ] || fail "the remaining migrations were not applied"
[ "$(psql_db sails_part "select count(*) from migrate_test_sentinel")" = "1" ] || fail "data written between the two runs did not survive"
pass "from ${KEEP} applied to ${EXPECTED_MIGRATIONS}; the sentinel row survived"

step "A schema with no migration history (what db push leaves) is refused, then baselined"
newdb sails_push
PUSH_URL=$(url_db sails_push)
run_migrate push-seed 0 -e "DATABASE_URL=$PUSH_URL" "$IMAGE"
psql_db sails_push "create schema migrate_sentinel; create table migrate_sentinel.t(id int); insert into migrate_sentinel.t values (1); drop table _prisma_migrations" >/dev/null
TABLES_BEFORE=$(psql_db sails_push "select count(*) from information_schema.tables where table_schema='public'")
run_migrate push-refused nonzero -e "DATABASE_URL=$PUSH_URL" "$IMAGE"
grep -q 'P3005' "$LOGS/push-refused.log" || fail "a schema without history was not refused with P3005"
grep -q 'database is up to date' "$LOGS/push-refused.log" && fail "a schema without history printed the success marker"
[ "$(psql_db sails_push "select count(*) from information_schema.tables where table_schema='public'")" = "$TABLES_BEFORE" ] \
  && [ "$(psql_db sails_push "select count(*) from migrate_sentinel.t")" = "1" ] || fail "the refused run changed the database"
pass "schema without history -> exit ${STATUS} (P3005), database untouched"
# (The sentinel lives in its own schema: prisma diffs only `public`, and a stray table there would be drift.)
# The procedure of docs/DEPLOYMENT.md 6.0.1: the live schema must equal schema.prisma (empty diff,
# otherwise STOP), then every committed migration is marked applied, then the job runs normally.
run_migrate push-diff 0 -e "DATABASE_URL=$PUSH_URL" --entrypoint node "$IMAGE" "$PRISMA_CLI" migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
run_migrate push-baseline 0 -e "DATABASE_URL=$PUSH_URL" --entrypoint sh "$IMAGE" -c \
  "for m in \$(ls prisma/migrations | grep -v '\\.toml\$' | sort); do node $PRISMA_CLI migrate resolve --applied \"\$m\" || exit 1; done"
run_migrate push-after-baseline 0 -e "DATABASE_URL=$PUSH_URL" "$IMAGE"
grep -q 'No pending migrations to apply' "$LOGS/push-after-baseline.log" || fail "after the baseline the job should have nothing to apply"
[ "$(psql_db sails_push "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null")" = "$EXPECTED_MIGRATIONS" ] \
  && [ "$(psql_db sails_push "select count(*) from migrate_sentinel.t")" = "1" ] || fail "baseline did not leave ${EXPECTED_MIGRATIONS} applied migrations with the data intact"
pass "empty schema diff -> baseline -> the job is a no-op; ${EXPECTED_MIGRATIONS} recorded, data intact"

step "No secret in any log"
if grep -rqF -- "$PASSWORD" "$LOGS"/*.log; then
  fail "the database password appears in a log: $(grep -rlF -- "$PASSWORD" "$LOGS"/*.log | xargs -n1 basename | tr '\n' ' ')"
fi
pass "the password is absent from all $(ls "$LOGS"/*.log | wc -l | tr -d ' ') run logs"

step "Rollout gate: a failing migration prevents the server from starting"
GATE="${LOGS#"$PWD"/}/gate" # relative, see the broken-image build above
mkdir -p "$GATE"
write_gate_compose() { # <migrate image>
  cat >"$GATE/docker-compose.yml" <<EOF
services:
  postgres:
    image: ${PG_IMAGE}
    environment: { POSTGRES_PASSWORD: gate, POSTGRES_DB: sails }
    healthcheck: { test: ["CMD-SHELL", "psql -h 127.0.0.1 -U postgres -d sails -c 'select 1'"], interval: 2s, retries: 30 }
  migrate:
    image: $1
    environment: { DATABASE_URL: "postgresql://postgres:gate@postgres:5432/sails" }
    depends_on: { postgres: { condition: service_healthy } }
    restart: "no"
  app:
    image: ${IMAGE}
    entrypoint: ["sh", "-c", "echo SERVER_STARTED"]
    depends_on: { migrate: { condition: service_completed_successfully } }
EOF
}
write_gate_compose "$BROKEN_IMAGE"
docker compose -f "$GATE/docker-compose.yml" config -q || fail "the generated gate compose file is invalid"
GATE_STATUS=0
docker compose -p "${RUN}b" -f "$GATE/docker-compose.yml" up -d app >"$LOGS/gate-bad.log" 2>&1 || GATE_STATUS=$?
[ "$GATE_STATUS" -ne 0 ] || fail "compose up succeeded although the migration failed"
# Non-zero alone proves nothing (an invalid compose file also exits non-zero): require evidence
# that the migrate container itself ran and failed.
MIGRATE_STATE=$(docker compose -p "${RUN}b" -f "$GATE/docker-compose.yml" ps -a --format "{{.Service}}={{.State}}:{{.ExitCode}}" 2>&1 || true)
case "$MIGRATE_STATE" in *migrate=exited:1*) ;; *) fail "the migrate container did not run and fail (got: $MIGRATE_STATE)" ;; esac
APP_LOGS=$(docker compose -p "${RUN}b" -f "$GATE/docker-compose.yml" logs app 2>&1 || true)
case "$APP_LOGS" in *SERVER_STARTED*) fail "the server started although the migration failed" ;; esac
pass "failing migration: compose exit ${GATE_STATUS}, server never started"
write_gate_compose "$IMAGE"
docker compose -p "${RUN}g" -f "$GATE/docker-compose.yml" up -d app >"$LOGS/gate-good.log" 2>&1 || fail "compose up failed with a good migration"
sleep 2
APP_LOGS=$(docker compose -p "${RUN}g" -f "$GATE/docker-compose.yml" logs app 2>&1 || true)
case "$APP_LOGS" in *SERVER_STARTED*) ;; *) fail "the server did not start after a successful migration" ;; esac
pass "successful migration: server started"

step "The repository's docker-compose.yml keeps the gate and uses this image"
docker compose config --format json | docker run --rm -i --entrypoint node "$IMAGE" -e '
  const c = JSON.parse(require("fs").readFileSync(0, "utf8")).services
  const gate = c.app.depends_on && c.app.depends_on.migrate && c.app.depends_on.migrate.condition
  if (gate !== "service_completed_successfully") { console.error("app.depends_on.migrate.condition =", gate); process.exit(1) }
  if (c.migrate.build.target !== "migrate") { console.error("migrate.build.target =", c.migrate.build.target); process.exit(1) }
' || fail "docker-compose.yml no longer gates app on a successful migrate job built from the migrate target"
pass "app waits for service_completed_successfully of the migrate target"

echo
echo "PASS: the migration image applies, re-applies idempotently, fails closed, leaks no secret and gates the rollout (${PG_IMAGE})."
