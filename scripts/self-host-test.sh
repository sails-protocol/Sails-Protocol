#!/usr/bin/env bash
# scripts/self-host-test.sh
#
# End-to-end test of the provider-agnostic self-hosting kit (deploy/self-host/): a clean install,
# an update, a failed update, rollback, backup/restore — all on this machine's Docker, in a
# throwaway Compose project with its own volumes. No cloud, no registry account, no real
# database: everything it creates is removed on exit. It exercises the real `sails-node` script.
#
# Versions (all built from this checkout):
#   t1  the current build;
#   t2  t1 + an additive migration                         (a good update);
#   t3  t2 + a migration whose SQL is invalid              (a failing update);
#   t4  t2 whose migration job never finishes              (an UNKNOWN migration result).
#
# Proven (each failing step stops the script, prints the logs, exits non-zero):
#   clean install; data persists across updates; an update is idempotent; a failed migration
#   leaves the previous server running and unchanged; a migration with an unknown result (timeout)
#   does the same; a server started by hand on an unmigrated database refuses to boot; rollback
#   works against a database that is ahead; backup + restore into an empty database; secrets
#   never reach the logs; only the loopback port is published; containers run non-root.
#
# Usage: bash scripts/self-host-test.sh          (from the repo root; needs Docker + Compose)

set -euo pipefail
cd "$(dirname "$0")/.."

RUN="sailssh$$"
export COMPOSE_PROJECT_NAME="$RUN"
export SAILS_PORT="${SAILS_TEST_PORT:-$((20000 + RANDOM % 20000))}"
export COMPOSE_PROFILES=evidence-store
# Inside the repo (not /tmp): a Windows-hosted Docker client cannot see a WSL /tmp. Removed on exit.
WORK="$(mktemp -d "$PWD/.self-host-test.XXXXXX")"
export SAILS_NODE_HOME="$WORK/home"
NODE_CMD="deploy/self-host/sails-node"
LOGS="$WORK/logs"; mkdir -p "$LOGS"
PG="${RUN}-postgres-1"
SERVER="${RUN}-server-1"
STEP="starting"
N=0

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo; echo "::group::FAILED during: ${STEP} (exit ${status})"
    tail -n 40 "$LOGS"/*.log 2>/dev/null || true
    docker logs "$SERVER" 2>&1 | tail -n 30 || true
    echo "::endgroup::"
  fi
  docker rm -f "${RUN}-migrate-job" >/dev/null 2>&1 || true
  docker compose -p "$RUN" down -v --remove-orphans >/dev/null 2>&1 || true
  for t in t1 t2 t3 t4; do docker rmi -f "sails-server:$RUN-$t" "sails-migrate:$RUN-$t" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { STEP="$*"; echo; echo "=== $*"; }
pass() { echo "PASS  $*"; }
rel() { echo "${1#"$PWD"/}"; }
sql() { docker exec "$PG" psql -h 127.0.0.1 -U sails -d sails -Atc "$1"; }
running_image() { docker inspect -f '{{.Config.Image}}' "$SERVER" 2>/dev/null || echo none; }
server_ready() { docker exec "$SERVER" node -e "require('http').get('http://127.0.0.1:3000/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" >/dev/null 2>&1; }
host_path() { if command -v wslpath >/dev/null 2>&1 && [ "$(docker version -f '{{.Client.Os}}' 2>/dev/null)" = windows ]; then wslpath -m "$1"; else echo "$1"; fi; }

# node_cmd <name> <expect: 0|nonzero> args...   -> $LOGS/<n>-<name>.log, sets STATUS
node_cmd() {
  local name="$1" expect="$2"; shift 2; N=$((N + 1)); STATUS=0
  bash "$NODE_CMD" "$@" >"$LOGS/$N-$name.log" 2>&1 || STATUS=$?
  case "$expect" in
    0) [ "$STATUS" -eq 0 ] || fail "$name: expected exit 0, got $STATUS" ;;
    nonzero) [ "$STATUS" -ne 0 ] || fail "$name: expected a failure exit, got 0" ;;
  esac
}

derived_images() { # <tag> <from-tag> <migrations-dir or ""> <migrate-entrypoint-override or "">
  local tag="$1" from="$2" mig="$3" entry="$4" ctx="$WORK/ctx-$1"
  mkdir -p "$ctx/migrations"
  [ -z "$mig" ] || cp -r "$mig"/. "$ctx/migrations/"
  printf 'FROM sails-server:%s-%s\nCOPY --chown=node:node migrations/ /app/prisma/migrations/\n' "$RUN" "$from" >"$ctx/Dockerfile.server"
  printf 'FROM sails-migrate:%s-%s\nCOPY --chown=node:node migrations/ /app/prisma/migrations/\n%s\n' "$RUN" "$from" "$entry" >"$ctx/Dockerfile.migrate"
  docker build -q -t "sails-server:$RUN-$tag" -f "$(rel "$ctx")/Dockerfile.server" "$(rel "$ctx")" >/dev/null
  docker build -q -t "sails-migrate:$RUN-$tag" -f "$(rel "$ctx")/Dockerfile.migrate" "$(rel "$ctx")" >/dev/null
}

step "Build the base version t1 with sails-node build (the images an operator builds from source)"
node_cmd build-t1 0 build "$RUN-t1"
pass "images built from the checkout"

step "Derive t2 (additive migration), t3 (invalid SQL), t4 (migration job never finishes)"
mkdir -p "$WORK/m2/99990101000001_selfhost_marker" "$WORK/m3/99990101000002_selfhost_broken"
echo 'CREATE TABLE selfhost_v2_marker (id integer PRIMARY KEY);' >"$WORK/m2/99990101000001_selfhost_marker/migration.sql"
echo 'SELECT * FROM a_table_that_does_not_exist;' >"$WORK/m3/99990101000002_selfhost_broken/migration.sql"
derived_images t2 t1 "$WORK/m2" ""
derived_images t3 t2 "$WORK/m3" ""
derived_images t4 t2 "" 'ENTRYPOINT ["sleep", "3600"]'
pass "t2, t3, t4 derived from t1"

step "init: data directory and secrets"
node_cmd init 0 init
node_cmd init-again nonzero init
# File modes can only be asserted on a filesystem that stores them (not NTFS reached through WSL).
touch "$WORK/mode-probe"; chmod 640 "$WORK/mode-probe"
if [ "$(stat -c %a "$WORK/mode-probe")" = "640" ]; then
  [ "$(stat -c %a "$SAILS_NODE_HOME/secrets/db.env")" = "600" ] || fail "db.env is not mode 600"
  [ "$(stat -c %a "$SAILS_NODE_HOME/secrets")" = "700" ] || fail "secrets/ is not mode 700"
  pass "secrets created 0600/0700; a second init refuses to overwrite them"
else
  pass "a second init refuses to overwrite the secrets (SKIPPED: file modes — this filesystem does not store POSIX modes, so 0600/0700 was NOT verified here)"
fi
PGPASS="$(cat "$SAILS_NODE_HOME/secrets/postgres_password")"
S3PASS="$(sed -n 's/^EVIDENCE_S3_SECRET_ACCESS_KEY=//p' "$SAILS_NODE_HOME/secrets/server.env" | tail -n1)"
[ -n "$PGPASS" ] && [ -n "$S3PASS" ] || fail "generated secrets are empty"

step "Clean install: update t1"
node_cmd update-t1 0 update "$RUN-t1"
[ "$(running_image)" = "sails-server:$RUN-t1" ] || fail "the running server is $(running_image)"
server_ready || fail "t1 is not ready"
sql "create table install_sentinel(id int); insert into install_sentinel values (42)" >/dev/null
[ "$(sql "select count(*) from _prisma_migrations where finished_at is not null")" -gt 30 ] || fail "the migrations were not applied"
pass "t1 installed from nothing: migrated, server ready, sentinel written"

step "The server's own evidence provider works against the bundled store (store, retrieve, delete)"
grep -q "evidence bucket ready" "$LOGS/$N-update-t1.log" || fail "update did not report the evidence bucket"
docker exec "$SERVER" node -e "
  const { S3EvidenceProvider } = require('/app/dist/src/modules/open-proof/s3-evidence-provider.js')
  const p = new S3EvidenceProvider({ endpoint: process.env.EVIDENCE_S3_ENDPOINT, region: process.env.EVIDENCE_S3_REGION, bucket: process.env.EVIDENCE_S3_BUCKET,
    accessKeyId: process.env.EVIDENCE_S3_ACCESS_KEY_ID, secretAccessKey: process.env.EVIDENCE_S3_SECRET_ACCESS_KEY, forcePathStyle: process.env.EVIDENCE_S3_FORCE_PATH_STYLE === 'true' })
  ;(async () => {
    const h = await p.health(); if (!h.healthy) throw new Error('health: ' + h.detail)
    const bytes = Buffer.from('selfhost-evidence-' + Date.now())
    const stored = await p.store(bytes, 'image/png')
    const back = Buffer.from(await p.retrieve(stored.uri))
    if (!back.equals(bytes)) throw new Error('retrieved bytes differ')
    await p.delete(stored.uri)
    console.log('roundtrip ok')
  })().catch(e => { console.error('roundtrip FAILED:', e.message); process.exit(1) })
" >"$LOGS/evidence-roundtrip.log" 2>&1 || fail "evidence provider roundtrip failed: $(tail -n 3 "$LOGS/evidence-roundtrip.log")"
pass "S3EvidenceProvider (the production code, with its SSE header) works against the bundled store"

step "Update to t2 (additive migration): data persists"
node_cmd update-t2 0 update "$RUN-t2"
[ "$(running_image)" = "sails-server:$RUN-t2" ] || fail "the running server is $(running_image)"
[ "$(sql "select id from install_sentinel")" = "42" ] || fail "the sentinel did not survive the update"
[ "$(sql "select to_regclass('public.selfhost_v2_marker') is not null")" = "t" ] || fail "the t2 migration was not applied"
ls "$SAILS_NODE_HOME"/backups/*.dump >/dev/null 2>&1 || fail "no backup was taken before the migration"
pass "t2 running, new table present, sentinel intact, a backup was taken first"

step "Update to t2 again is a no-op and keeps the rollback target"
node_cmd update-t2-again 0 update "$RUN-t2"
grep -q '^previous='"$RUN-t1"'$' "$SAILS_NODE_HOME/state" || fail "the rollback target was overwritten"
[ "$(running_image)" = "sails-server:$RUN-t2" ] || fail "the running server changed"
pass "idempotent update; previous still $RUN-t1"

step "A failing migration (t3) blocks the update and leaves t2 serving"
node_cmd update-t3 nonzero update "$RUN-t3"
grep -q 'MIGRATION FAILED' "$LOGS/$N-update-t3.log" || fail "the failure was not reported as a migration failure"
[ "$(running_image)" = "sails-server:$RUN-t2" ] || fail "the server was replaced although the migration failed: $(running_image)"
server_ready || fail "the previous server is not ready after the failed update"
[ "$(sql "select id from install_sentinel")" = "42" ] || fail "data changed"
grep -q '^current='"$RUN-t2"'$' "$SAILS_NODE_HOME/state" || fail "the recorded current version changed"
pass "exit ${STATUS}; t2 still running and ready; state and data unchanged"

step "A server started by hand on the failed database refuses to boot (the server's own migration gate)"
OUT="$LOGS/manual-boot.log"; MSTATUS=0
docker run --rm --network "${RUN}_default" --env-file "$(host_path "$SAILS_NODE_HOME/secrets/db.env")" --env-file "$(host_path "$SAILS_NODE_HOME/secrets/server.env")" -e HOST=0.0.0.0 "sails-server:$RUN-t3" >"$OUT" 2>&1 || MSTATUS=$?
[ "$MSTATUS" -ne 0 ] || fail "the t3 server booted on a database with a failed migration"
grep -q 'not verifiably migrated' "$OUT" || fail "the refusal is not the migration gate: $(tail -n 3 "$OUT")"
pass "t3 refuses to boot: exit ${MSTATUS}, 'not verifiably migrated'"

step "An UNKNOWN migration result (the job never finishes) blocks the update"
SAILS_MIGRATE_TIMEOUT=10 node_cmd update-t4 nonzero update "$RUN-t4"
grep -q 'UNKNOWN' "$LOGS/$N-update-t4.log" || fail "the timeout was not reported as an unknown result"
[ "$(running_image)" = "sails-server:$RUN-t2" ] || fail "the server was replaced on an unknown migration result"
[ -z "$(docker ps -q --filter "name=${RUN}-migrate-job")" ] || fail "the timed-out migration job is still running"
pass "t2 untouched; the stuck job was removed"

step "Rollback to the previous server while the schema is ahead"
node_cmd rollback 0 rollback
[ "$(running_image)" = "sails-server:$RUN-t1" ] || fail "rollback did not start t1: $(running_image)"
server_ready || fail "t1 is not ready on the t2 schema"
[ "$(sql "select id from install_sentinel")" = "42" ] || fail "data changed during rollback"
pass "t1 serves on a t2-migrated database (migrations are backward compatible)"
node_cmd update-t2-final 0 update "$RUN-t2"
[ "$(running_image)" = "sails-server:$RUN-t2" ] || fail "could not return to t2"

step "Backup and restore into an EMPTY database"
node_cmd backup 0 backup
BACKUP="$(ls -t "$SAILS_NODE_HOME"/backups/*.dump | head -n1)"
node_cmd restore-nonempty nonzero restore "$BACKUP"
docker rm -f "$SERVER" >/dev/null
sql "drop schema public cascade; create schema public" >/dev/null
node_cmd restore 0 restore "$BACKUP"
[ "$(sql "select id from install_sentinel")" = "42" ] || fail "the sentinel was not restored"
pass "restore refuses a non-empty database, restores an empty one, and the migrations verify"
node_cmd update-after-restore 0 update "$RUN-t2"
server_ready || fail "the server is not ready after the restore"

step "Security properties"
if grep -rqF -e "$PGPASS" -e "$S3PASS" "$LOGS"/*.log; then fail "a secret appears in a log: $(grep -rlF -e "$PGPASS" -e "$S3PASS" "$LOGS"/*.log | xargs -n1 basename | tr '\n' ' ')"; fi
pass "neither the database nor the evidence-store secret appears in any of $(ls "$LOGS"/*.log | wc -l | tr -d ' ') logs"
PUBLISHED="$(docker port "$SERVER")"
echo "$PUBLISHED" | grep -q '127.0.0.1' || fail "the server port is not bound to loopback: $PUBLISHED"
echo "$PUBLISHED" | grep -qE '0\.0\.0\.0|:::' && fail "the server port is exposed beyond loopback: $PUBLISHED"
for c in postgres redis seaweedfs; do [ -z "$(docker port "${RUN}-$c-1")" ] || fail "$c publishes a port"; done
pass "only 127.0.0.1:${SAILS_PORT} is published; postgres, redis and seaweedfs publish nothing"
[ "$(docker exec "$SERVER" id -u)" != "0" ] || fail "the server runs as root"
pass "the server runs as non-root"
! docker image inspect "sails-server:$RUN-t2" "sails-migrate:$RUN-t2" --format '{{json .Config.Env}}{{json .Config.Cmd}}' | grep -qF -e "$PGPASS" -e "$S3PASS" || fail "a secret is baked into an image"
pass "no secret is baked into the images"
COMPOSE_PROFILES=evidence-store,tls SAILS_DOMAIN=node.example.org bash -c "docker compose -f '$(host_path "$PWD/deploy/self-host/compose.yml")' config -q" >/dev/null 2>&1 \
  || SAILS_SERVER_IMAGE=x SAILS_MIGRATE_IMAGE=y SAILS_HOME_HOST="$(host_path "$SAILS_NODE_HOME")" COMPOSE_PROFILES=evidence-store,tls SAILS_DOMAIN=node.example.org docker compose -f "$(host_path "$PWD/deploy/self-host/compose.yml")" config -q \
  || fail "the tls profile does not render"
pass "the optional tls profile renders (syntax only: a real certificate needs public DNS and is NOT exercised here)"

echo
echo "PASS: clean install, update, failed update, unknown result, rollback, backup/restore and the security properties of the self-hosting kit."
