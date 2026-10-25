#!/usr/bin/env bash
# scripts/self-host-backup-test.sh
#
# Adversarial test of the backup, restore, verification and key-rotation commands of the self-hosting kit
# (deploy/self-host/sails-node): sha256 sidecars, a truncated or replaced backup, atomic restore, a half-restored
# evidence store, verify-evidence, rotate-evidence-key and the hardening of the migration service.
# Throwaway Compose project with its own volumes; everything it creates is removed on exit; no real data, no cloud.
# It exercises the real `sails-node` script. It does NOT prove that backups are tamper-evident (a sha256 sidecar is not).
#
# Usage: bash scripts/self-host-backup-test.sh        (repo root; Docker + Compose)
#        SAILS_BACKUP_TEST_TAG=<tag> bash ...          reuse already built sails-server:<tag> / sails-migrate:<tag>
set -euo pipefail
cd "$(dirname "$0")/.."

RUN="sailsbk$$"
export COMPOSE_PROJECT_NAME="$RUN"
export SAILS_PORT="${SAILS_TEST_PORT:-$((20000 + RANDOM % 20000))}"
export COMPOSE_PROFILES=evidence-store
WORK="$(mktemp -d "$PWD/.self-host-backup-test.XXXXXX")"
export SAILS_NODE_HOME="$WORK/home"
NODE_CMD="deploy/self-host/sails-node"
LOGS="$WORK/logs"; mkdir -p "$LOGS"
PG="${RUN}-postgres-1"
SERVER="${RUN}-server-1"
TAG="${SAILS_BACKUP_TEST_TAG:-$RUN-t1}"
BUILT_HERE=0; [ -n "${SAILS_BACKUP_TEST_TAG:-}" ] || BUILT_HERE=1
# SAILS_IMAGE_FLAVOR=distroless runs the same test against the CANDIDATE distroless images (no shell, /nodejs/bin/node).
export SAILS_IMAGE_FLAVOR="${SAILS_IMAGE_FLAVOR:-debian}"
if [ "$SAILS_IMAGE_FLAVOR" = distroless ]; then NODE=/nodejs/bin/node; else NODE=node; fi
STEP="starting"; N=0

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo; echo "::group::FAILED during: ${STEP} (exit ${status})"
    tail -n 80 "$LOGS"/*.log 2>/dev/null || true
    echo "::endgroup::"
  fi
  docker rm -f "${RUN}-migrate-job" >/dev/null 2>&1 || true
  COMPOSE_PROFILES=evidence-store,evidence-rotate docker compose -p "$RUN" down -v --remove-orphans >/dev/null 2>&1 || true
  [ "$BUILT_HERE" -eq 0 ] || docker rmi -f "sails-server:$TAG" "sails-migrate:$TAG" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { STEP="$*"; echo; echo "=== $*"; }
pass() { echo "PASS  $*"; }
sql() { docker exec "$PG" psql -h 127.0.0.1 -U sails -d sails -Atc "$1"; }
host_path() { if command -v wslpath >/dev/null 2>&1 && [ "$(docker version -f '{{.Client.Os}}' 2>/dev/null)" = windows ]; then wslpath -m "$1"; else echo "$1"; fi; }
tables() { sql "select count(*) from information_schema.tables where table_schema='public'"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }

# node_cmd <name> <expect: 0|nonzero> args...   -> $LOGS/<n>-<name>.log, sets STATUS and LASTLOG
node_cmd() {
  local name="$1" expect="$2"; shift 2; N=$((N + 1)); STATUS=0; LASTLOG="$LOGS/$N-$name.log"
  bash "$NODE_CMD" "$@" >"$LASTLOG" 2>&1 || STATUS=$?
  case "$expect" in
    0) [ "$STATUS" -eq 0 ] || fail "$name: expected exit 0, got $STATUS: $(tail -n 4 "$LASTLOG")" ;;
    nonzero) [ "$STATUS" -ne 0 ] || fail "$name: expected a failure exit, got 0" ;;
  esac
}
expect_in_log() { grep -q -- "$1" "$LASTLOG" || fail "the output does not say '$1': $(tail -n 4 "$LASTLOG")"; }
kit_compose() {
  ( export SAILS_SERVER_IMAGE="sails-server:$TAG" SAILS_MIGRATE_IMAGE="sails-migrate:$TAG" SAILS_HOME_HOST="$(host_path "$SAILS_NODE_HOME")"
    export WSLENV="${WSLENV:+$WSLENV:}SAILS_SERVER_IMAGE:SAILS_MIGRATE_IMAGE:SAILS_HOME_HOST:COMPOSE_PROFILES:COMPOSE_PROJECT_NAME:SAILS_PORT"
    local files=(-f "$(host_path "$PWD/deploy/self-host/compose.yml")")
    [ "$SAILS_IMAGE_FLAVOR" != distroless ] || files+=(-f "$(host_path "$PWD/deploy/self-host/compose.distroless.yml")")
    docker compose "${files[@]}" "$@" )
}
evidence_store_one() { # prints "<uri>"
  docker exec -e PAYLOAD="$1" "$SERVER" "$NODE" -e '
    const { S3EvidenceProvider } = require("/app/dist/src/modules/open-proof/s3-evidence-provider.js")
    const p = new S3EvidenceProvider({ endpoint: process.env.EVIDENCE_S3_ENDPOINT, region: process.env.EVIDENCE_S3_REGION, bucket: process.env.EVIDENCE_S3_BUCKET,
      accessKeyId: process.env.EVIDENCE_S3_ACCESS_KEY_ID, secretAccessKey: process.env.EVIDENCE_S3_SECRET_ACCESS_KEY, forcePathStyle: process.env.EVIDENCE_S3_FORCE_PATH_STYLE === "true" })
    p.store(Buffer.from(process.env.PAYLOAD + "-" + Math.random()), "image/png").then(s => console.log(s.uri)).catch(e => { console.error(e.message); process.exit(1) })'
}

if [ "$BUILT_HERE" -eq 1 ]; then
  step "Build the images an operator builds from source (sails-node build)"
  node_cmd build 0 build "$TAG"
  pass "images built"
else
  docker image inspect "sails-server:$TAG" "sails-migrate:$TAG" >/dev/null 2>&1 || fail "SAILS_BACKUP_TEST_TAG=$TAG: images not found"
  pass "reusing sails-server:$TAG and sails-migrate:$TAG"
fi

step "G5 init: the operator is told, once, to back up secrets/ off the host"
node_cmd init 0 init
expect_in_log "copy .*secrets somewhere OFF this host"
KEK_OLD="$(sed -n 's/^WEED_S3_SSE_KEK=//p' "$SAILS_NODE_HOME/secrets/seaweedfs.env")"
PGPASS="$(cat "$SAILS_NODE_HOME/secrets/postgres_password")"
S3PASS="$(sed -n 's/^EVIDENCE_S3_SECRET_ACCESS_KEY=//p' "$SAILS_NODE_HOME/secrets/server.env" | tail -n1)"
[ -n "$KEK_OLD" ] && [ -n "$PGPASS" ] && [ -n "$S3PASS" ] || fail "generated secrets are empty"
pass "init printed the secrets/ warning"

step "G6 update under a hardened migrate service: the migration job still works"
node_cmd update 0 update "$TAG"
CFG="$(kit_compose config --format json 2>/dev/null)" || fail "cannot render the compose file"
echo "$CFG" | docker run --rm -i --entrypoint "$NODE" "sails-server:$TAG" -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const m = JSON.parse(s).services.migrate
    const ok = (m.cap_drop || []).includes("ALL") && (m.security_opt || []).includes("no-new-privileges:true")
    console.log(ok ? "migrate hardened" : "migrate NOT hardened: " + JSON.stringify({ cap_drop: m.cap_drop, security_opt: m.security_opt })); process.exit(ok ? 0 : 1) })' >"$LOGS/migrate-hardening.log" 2>&1 \
  || fail "$(cat "$LOGS/migrate-hardening.log")"
sql "create table backup_sentinel(id int); insert into backup_sentinel values (7)" >/dev/null
[ "$(tables)" -gt 30 ] || fail "the database was not migrated"
pass "migrate has cap_drop ALL and no-new-privileges, and the update (which runs it) succeeded"

step "G1 backup writes a sha256 sidecar and says that secrets/ is not inside"
node_cmd backup 0 backup
expect_in_log "sha256 sidecar written"; expect_in_log "NOT in this backup"
DUMP="$(ls -t "$SAILS_NODE_HOME"/backups/sails-*.dump | head -n1)"
[ -s "$DUMP.sha256" ] && [ "$(cut -d' ' -f1 <"$DUMP.sha256")" = "$(sha "$DUMP")" ] || fail "the sidecar is missing or wrong"
node_cmd verify 0 verify-backup "$DUMP"
node_cmd verify-deep 0 verify-backup "$DUMP" --deep
[ "$(tables)" -gt 30 ] || fail "verify-backup --deep touched the live database"
[ -z "$(sql "select datname from pg_database where datname like 'verify_%'")" ] || fail "the scratch database was not dropped"
pass "sidecar matches; verify-backup and verify-backup --deep pass; the live database and the scratch cleanup are intact"

step "G1 a replaced, truncated or tampered backup is refused"
SIZE="$(wc -c <"$DUMP")"
head -c $((SIZE * 6 / 10)) "$DUMP" >"$WORK/cut.dump"
cp "$DUMP.sha256" "$WORK/cut.dump.sha256"                       # the OLD sidecar: mismatch
node_cmd cut-stale-sidecar nonzero verify-backup "$WORK/cut.dump"; expect_in_log "does NOT match its sha256 sidecar"
printf '%s  %s\n' "$(sha "$WORK/cut.dump")" cut.dump >"$WORK/cut.dump.sha256"   # a FORGED sidecar: sha256 alone cannot tell
node_cmd cut-forged-sidecar nonzero verify-backup "$WORK/cut.dump"
grep -qE "not a readable PostgreSQL custom-format dump|not restorable" "$LASTLOG" || fail "a truncated dump with a forged sidecar was not refused for its structure: $(tail -n 3 "$LASTLOG")"
# A corruption that leaves the table of contents readable (only data damaged) with a FORGED sidecar: the sha256 check cannot
# tell, the shallow structure check passes, and only the scratch restore of --deep catches it. Find such a position.
CORRUPT=""
for pct in 20 35 50 65 80; do
  cp "$DUMP" "$WORK/data.dump"
  printf '\377\377\377\377\377\377\377\377' | dd of="$WORK/data.dump" bs=1 seek=$((SIZE * pct / 100)) conv=notrunc 2>/dev/null
  printf '%s  %s\n' "$(sha "$WORK/data.dump")" data.dump >"$WORK/data.dump.sha256"
  if bash "$NODE_CMD" verify-backup "$WORK/data.dump" >/dev/null 2>&1 && ! bash "$NODE_CMD" verify-backup "$WORK/data.dump" --deep >/dev/null 2>&1; then CORRUPT=$pct; break; fi
done
[ -n "$CORRUPT" ] || fail "could not build a dump that passes the shallow check and fails --deep"
node_cmd data-forged-shallow 0 verify-backup "$WORK/data.dump"
node_cmd data-forged-deep nonzero verify-backup "$WORK/data.dump" --deep; expect_in_log "not restorable"
cp "$DUMP" "$WORK/flip.dump"; cp "$DUMP.sha256" "$WORK/flip.dump.sha256"
printf '\377\377\377\377' | dd of="$WORK/flip.dump" bs=1 seek=$((SIZE / 2)) conv=notrunc 2>/dev/null
node_cmd flipped nonzero verify-backup "$WORK/flip.dump"; expect_in_log "does NOT match its sha256 sidecar"
cp "$DUMP" "$WORK/nosidecar.dump"
node_cmd nosidecar nonzero verify-backup "$WORK/nosidecar.dump"; expect_in_log "sha256 is missing"
pass "stale sidecar, flipped byte and missing sidecar are refused; a truncated dump is refused for its structure; damaged DATA with a forged sidecar passes the shallow check (offset ${CORRUPT}%) and is caught by --deep (the documented limit of a sha256 sidecar)"

step "G2 a failed restore is atomic: nothing partial survives, and a retry with a good backup works"
docker rm -f "$SERVER" >/dev/null
sql "drop schema public cascade; create schema public" >/dev/null
[ "$(tables)" = "0" ] || fail "could not empty the database"
node_cmd restore-cut nonzero restore "$WORK/cut.dump"      # truncated with a forged sidecar: refused for its structure
[ "$(tables)" = "0" ] || fail "a refused restore touched the database"
node_cmd restore-data nonzero restore "$WORK/data.dump"    # damaged data, readable TOC, forged sidecar: pg_restore itself must fail
expect_in_log "pg_restore FAILED"
[ "$(tables)" = "0" ] || fail "a failed restore left $(tables) tables behind (not atomic)"
node_cmd restore-nosidecar nonzero restore "$WORK/nosidecar.dump"; expect_in_log "sha256 is missing"
[ "$(tables)" = "0" ] || fail "an unverifiable backup touched the database"
node_cmd restore-good 0 restore "$DUMP"
[ "$(sql "select id from backup_sentinel")" = "7" ] || fail "the sentinel was not restored"
pass "restore of a truncated dump was refused and of a data-damaged dump failed, both non-zero and the database stayed empty; an unverifiable backup was refused; the good backup restored the sentinel"

step "G1 an old backup without a sidecar needs an explicit, loud override"
sql "drop schema public cascade; create schema public" >/dev/null
SAILS_RESTORE_UNVERIFIED=1 node_cmd restore-unverified 0 restore "$WORK/nosidecar.dump"; expect_in_log "continuing UNVERIFIED"
[ "$(sql "select id from backup_sentinel")" = "7" ] || fail "the unverified restore did not restore"
node_cmd update-after-restore 0 update "$TAG"
pass "SAILS_RESTORE_UNVERIFIED=1 restores a sidecar-less backup with a warning; only a MISSING sidecar is overridable"

step "Evidence: store objects, back up, verify-evidence"
for i in 1 2 3; do evidence_store_one "bk-$i" >>"$WORK/uris"; done
[ "$(wc -l <"$WORK/uris" | tr -d ' ')" = "3" ] || fail "could not store the evidence objects"
node_cmd verify-evidence 0 verify-evidence; expect_in_log "3 objects, 3 verified"
node_cmd backup-evidence 0 backup-evidence; expect_in_log "sha256 sidecar written"
EVB="$(ls -t "$SAILS_NODE_HOME"/backups/evidence-*.tar.gz | head -n1)"
[ -s "$EVB.sha256" ] || fail "no evidence sidecar"
node_cmd verify-evbackup 0 verify-backup "$EVB"
pass "3 objects stored and verified by hash; the evidence backup has a sidecar and verifies"

step "G3 a truncated or replaced evidence archive is refused BEFORE the store is touched"
ESIZE="$(wc -c <"$EVB")"
head -c $((ESIZE / 2)) "$EVB" >"$WORK/cut-ev.tar.gz"
cp "$EVB.sha256" "$WORK/cut-ev.tar.gz.sha256"
node_cmd ev-cut-stale nonzero restore-evidence "$WORK/cut-ev.tar.gz"; expect_in_log "does NOT match its sha256 sidecar"
printf '%s  %s\n' "$(sha "$WORK/cut-ev.tar.gz")" cut-ev.tar.gz >"$WORK/cut-ev.tar.gz.sha256"
node_cmd ev-cut-forged nonzero restore-evidence "$WORK/cut-ev.tar.gz"; expect_in_log "not a complete, readable archive"
kit_compose up -d seaweedfs >/dev/null 2>&1
node_cmd verify-evidence-after-refusals 0 verify-evidence; expect_in_log "3 objects, 3 verified"
pass "stale sidecar and forged-sidecar truncated archive were refused; the running store and its 3 objects are untouched"

step "Restore into a wiped store, then verify-evidence reads every object back"
kit_compose rm -sf seaweedfs >/dev/null 2>&1
docker volume rm "${RUN}_seaweedfs-data" >/dev/null || fail "cannot remove the evidence volume"
node_cmd restore-evidence 0 restore-evidence "$EVB"
node_cmd verify-evidence-restored 0 verify-evidence; expect_in_log "3 objects, 3 verified"
pass "wiped, restored from the verified archive, and all 3 objects verify by hash"

step "verify-evidence fails when the store runs with the WRONG key (it does not report success on unreadable data)"
cp "$SAILS_NODE_HOME/secrets/seaweedfs.env" "$WORK/seaweedfs.env.good"
sed -i "s/^WEED_S3_SSE_KEK=.*/WEED_S3_SSE_KEK=$(printf '%064d' 7)/" "$SAILS_NODE_HOME/secrets/seaweedfs.env"
kit_compose up -d --force-recreate seaweedfs >/dev/null 2>&1
SAILS_READY_TIMEOUT=20 node_cmd verify-wrong-key nonzero verify-evidence
cp "$WORK/seaweedfs.env.good" "$SAILS_NODE_HOME/secrets/seaweedfs.env"
kit_compose up -d --force-recreate seaweedfs >/dev/null 2>&1
node_cmd verify-right-key 0 verify-evidence; expect_in_log "3 objects, 3 verified"
pass "a wrong key fails verify-evidence; the right key verifies again"

step "G4 rotate-evidence-key refuses to run over an unfinished rotation"
printf 'x' >"$SAILS_NODE_HOME/secrets/seaweedfs.next.env"
node_cmd rotate-guard nonzero rotate-evidence-key; expect_in_log "a previous rotation did not finish"
rm -f "$SAILS_NODE_HOME/secrets/seaweedfs.next.env"
node_cmd verify-after-guard 0 verify-evidence; expect_in_log "3 objects, 3 verified"
pass "refused; the running store was not touched"

step "G4 rotate-evidence-key: copy, verify, swap under a NEW key"
node_cmd rotate 0 rotate-evidence-key; expect_in_log "evidence key rotated"
KEK_NEW="$(sed -n 's/^WEED_S3_SSE_KEK=//p' "$SAILS_NODE_HOME/secrets/seaweedfs.env")"
[ -n "$KEK_NEW" ] && [ "$KEK_NEW" != "$KEK_OLD" ] || fail "the key did not change"
PREV="$(ls "$SAILS_NODE_HOME"/secrets/seaweedfs.env.prev-* | head -n1)"
grep -q "^WEED_S3_SSE_KEK=$KEK_OLD$" "$PREV" || fail "the previous env does not hold the old key"
[ ! -e "$SAILS_NODE_HOME/secrets/seaweedfs.next.env" ] || fail "seaweedfs.next.env was left behind"
docker volume inspect "${RUN}_seaweedfs-next-data" >/dev/null 2>&1 && fail "the temporary volume was left behind"
node_cmd verify-after-rotate 0 verify-evidence; expect_in_log "3 objects, 3 verified"
pass "key changed, old key kept in $(basename "$PREV"), temporary store/volume/env removed, all 3 objects verify under the new key"

step "After rotation the OLD key no longer reads the store, and the pre-rotation archive needs the OLD key"
cp "$SAILS_NODE_HOME/secrets/seaweedfs.env" "$WORK/seaweedfs.env.new"
cp "$PREV" "$SAILS_NODE_HOME/secrets/seaweedfs.env"
kit_compose up -d --force-recreate seaweedfs >/dev/null 2>&1
SAILS_READY_TIMEOUT=20 node_cmd old-key-after-rotate nonzero verify-evidence
cp "$WORK/seaweedfs.env.new" "$SAILS_NODE_HOME/secrets/seaweedfs.env"
kit_compose up -d --force-recreate seaweedfs >/dev/null 2>&1
node_cmd new-key-again 0 verify-evidence; expect_in_log "3 objects, 3 verified"
pass "the old key cannot read the rotated store; the new key can (so the old key must be kept only for old archives)"

step "Security: no key or password reaches any log"
for v in "$KEK_OLD" "$KEK_NEW" "$PGPASS" "$S3PASS"; do
  if grep -rqF -e "$v" "$LOGS"/*.log; then fail "a secret appears in a log: $(grep -rlF -e "$v" "$LOGS"/*.log | xargs -n1 basename | tr '\n' ' ')"; fi
done
pass "neither the old/new evidence key, the database password nor the S3 secret appears in any of $(ls "$LOGS"/*.log | wc -l | tr -d ' ') logs"

echo
echo "PASS: backup integrity, atomic restore, evidence verification, key rotation and migrate hardening of the self-hosting kit (throwaway project)."
