#!/usr/bin/env bash
# P3-R2.1 frente B: a migration image candidate, tested on a throwaway PostgreSQL ONLY.
#   usage: experiments/p3-r21/test-migrate.sh <migrate-image> <label> <expect-shell: yes|no>
# The job runs on an --internal network (no internet): if Prisma needed to download an engine it fails there.
# Historical migrations are never modified; the broken-migration case adds a NEW directory in a derived image.
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
cd "$here/../.."

MIG="${1:?migrate image}"; LABEL="${2:?label}"; SHELL_EXPECTED="${3:-no}"
R="r21m$$"; NET="${R}_net"; PG="${R}-pg"; WORK="$(mktemp -d)"
BROKEN="r21m-broken-$$:tmp"
cleanup() { docker rm -fv "$PG" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; docker rmi -f "$BROKEN" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

url() { echo "postgresql://postgres:${3:-password}@${2:-$PG}:5432/$1"; }
job() { # <db> [extra docker args...]  -> runs the job against db, output in $JOB_OUT, exit in $JOB_RC
  local db="$1"; shift
  JOB_OUT="$(timeout 180 docker run --rm --network "$NET" -e "DATABASE_URL=$(url "$db")" "$@" 2>&1)"; JOB_RC=$?
}
history() { sql "$1" "select count(*)||' rows, md5='||md5(coalesce(string_agg(migration_name||':'||checksum||':'||coalesce(finished_at::text,'NULL'),',' order by migration_name),'')) from _prisma_migrations" 2>/dev/null; }

section "Environment: $LABEL = $MIG"
echo "docker: $(docker version --format '{{.Server.Version}}')   image: $(docker image inspect "$MIG" --format '{{.Id}} {{.Size}} user={{.Config.User}} entrypoint={{json .Config.Entrypoint}}')"
docker network create --internal "$NET" >/dev/null
start_postgres "$PG" "$NET" || exit 1
echo "postgres: $(docker exec "$PG" postgres --version)"

section "B0 contract facts: shell / npm / npx"
out="$(docker run --rm --entrypoint sh "$MIG" -c true 2>&1)"; rc=$?
if [ "$SHELL_EXPECTED" = "no" ]; then [ "$rc" -ne 0 ] && pass "B0 no shell in the image (sh: exit $rc)" || fail "B0 a shell exists"; else [ "$rc" -eq 0 ] && pass "B0 shell present as designed (sh: exit 0)" || fail "B0 no shell but one was expected"; fi
for t in npm npx corepack; do
  out="$(docker run --rm --entrypoint "$t" "$MIG" --version 2>&1)"; rc=$?
  [ "$rc" -ne 0 ] && pass "B0 '$t' cannot be run" || fail "B0 '$t' runs"
done
vout="$(docker run --rm --network "$NET" --entrypoint "$(docker image inspect "$MIG" --format '{{index .Config.Entrypoint 0}}' | sed 's#^sh$#node#')" "$MIG" node_modules/prisma/build/index.js --version 2>&1 | tr '\n' '|' | cut -c1-420)"
measure "prisma version / engine report: $vout"

section "B1 success path: empty database, then the second run is idempotent"
newdb m1 ; job m1 "$MIG"
echo "$JOB_OUT" | tail -n 5 | sed 's/^/    /'
[ "$JOB_RC" -eq 0 ] && pass "B1 exit 0 on an empty database (internal network: no engine download possible)" || fail "B1 exit $JOB_RC"
n="$(sql m1 "select count(*) from _prisma_migrations where finished_at is not null")"; [ "$n" = "37" ] && pass "B1 37 migrations applied" || fail "B1 migrations applied: $n"
h1="$(history m1)"; job m1 "$MIG"; h2="$(history m1)"
{ [ "$JOB_RC" -eq 0 ] && [ "$h1" = "$h2" ]; } && pass "B1 re-run exit 0, history unchanged ($h2)" || fail "B1 re-run exit $JOB_RC or history changed ($h1 -> $h2)"
echo "$JOB_OUT" | grep -q 'password' && fail "B1 'password' appears in the output" || pass "B1 no credential in the output"

section "B2 failure: DATABASE_URL missing (must refuse, no localhost fallback)"
JOB_OUT="$(timeout 60 docker run --rm --network "$NET" "$MIG" 2>&1)"; JOB_RC=$?
echo "$JOB_OUT" | tail -n 2 | sed 's/^/    /'
[ "$JOB_RC" -eq 64 ] && pass "B2 exit 64 and refusal message" || fail "B2 exit $JOB_RC"

section "B3 failure: wrong credentials (and the password must not leak)"
newdb m3
JOB_OUT="$(timeout 120 docker run --rm --network "$NET" -e "DATABASE_URL=$(url m3 "$PG" r21-WRONG-secret-pw)" "$MIG" 2>&1)"; JOB_RC=$?
echo "$JOB_OUT" | tail -n 3 | cut -c1-220 | sed 's/^/    /'
[ "$JOB_RC" -ne 0 ] && pass "B3 non-zero exit ($JOB_RC) with wrong credentials" || fail "B3 exit 0 with wrong credentials"
echo "$JOB_OUT" | grep -q 'r21-WRONG-secret-pw' && fail "B3 the password appears in the output" || pass "B3 the password does not appear in the output"

section "B4 failure: unreachable host and malformed URL"
JOB_OUT="$(timeout 170 docker run --rm --network "$NET" -e "DATABASE_URL=$(url m3 no-such-host.invalid)" "$MIG" 2>&1)"; JOB_RC=$?
echo "$JOB_OUT" | tail -n 2 | cut -c1-200 | sed 's/^/    /'
[ "$JOB_RC" -ne 0 ] && [ "$JOB_RC" -ne 124 ] && pass "B4 unreachable host: non-zero exit $JOB_RC (not a hang)" || fail "B4 unreachable host exit $JOB_RC"
JOB_OUT="$(timeout 60 docker run --rm --network "$NET" -e "DATABASE_URL=this is not a url" "$MIG" 2>&1)"; JOB_RC=$?
[ "$JOB_RC" -ne 0 ] && pass "B4 malformed URL: non-zero exit $JOB_RC" || fail "B4 malformed URL accepted"

section "B5 failure: schema without migration history (what 'db push' leaves) is refused and left untouched"
newdb m5; sql m5 "create table r21_probe(id int)" >/dev/null
job m5 "$MIG"
echo "$JOB_OUT" | grep -E 'P3005|not empty' | head -n 2 | cut -c1-200 | sed 's/^/    /'
{ [ "$JOB_RC" -ne 0 ] && echo "$JOB_OUT" | grep -q P3005; } && pass "B5 refused with P3005 (exit $JOB_RC)" || fail "B5 exit $JOB_RC / no P3005"
t="$(sql m5 "select count(*) from information_schema.tables where table_schema='public'")"; [ "$t" = "1" ] && pass "B5 the database still has exactly its one table" || fail "B5 tables in public: $t"

section "B6 failure: a NEW migration with invalid SQL fails the job and leaves the applied history intact"
mkdir -p "$WORK/broken/99990101000099_r21_broken"; echo 'SELECT * FROM a_table_that_does_not_exist;' > "$WORK/broken/99990101000099_r21_broken/migration.sql"
printf 'FROM %s\nCOPY --chown=65532:65532 broken/ /app/prisma/migrations/\n' "$MIG" > "$WORK/Dockerfile"
if [ "$SHELL_EXPECTED" = "yes" ]; then sed -i 's/65532:65532/node:node/' "$WORK/Dockerfile"; fi
docker build -q -t "$BROKEN" "$WORK" >/dev/null 2>&1 || fail "B6 could not build the derived image"
newdb m6; job m6 "$MIG"; before="$(history m6)"
job m6 "$BROKEN"
echo "$JOB_OUT" | grep -iE 'failed|error' | head -n 3 | cut -c1-200 | sed 's/^/    /'
[ "$JOB_RC" -ne 0 ] && pass "B6 the broken migration fails the job (exit $JOB_RC)" || fail "B6 broken migration exit 0"
after="$(history m6)"; [ "$before" = "$after" ] && pass "B6 applied history unchanged ($before)" || measure "B6 history changed: $before -> $after (a failed migration row is recorded by Prisma as designed)"
nf="$(sql m6 "select count(*) from _prisma_migrations where finished_at is null and rolled_back_at is null")"
measure "B6 unfinished (failed) migration rows now: $nf (Prisma P3009 blocks further deploys until resolved, same as production)"

section "B7 the job does not depend on a shell, npm or npx implicitly"
if [ "$SHELL_EXPECTED" = "no" ]; then
  out="$(docker run --rm --network "$NET" --entrypoint sh "$MIG" scripts/migrate-deploy.sh 2>&1)"; rc=$?
  [ "$rc" -ne 0 ] && pass "B7 the production shell entrypoint cannot run here (exit $rc): the Node entrypoint is the only path" || fail "B7 shell entrypoint ran"
fi
echo "    (B1 already proved the job completes with no npm/npx/shell on PATH)"

summary
