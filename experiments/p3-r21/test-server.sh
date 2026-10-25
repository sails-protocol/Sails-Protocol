#!/usr/bin/env bash
# P3-R2.1 frente A: the server image, tested for what it must do without a shell.
#   usage: experiments/p3-r21/test-server.sh <server-image> <migrate-image> [<node-path-in-image>]
# Example: ... r21x-runtime-distroless r21x-migrate-distroless /nodejs/bin/node
# Runs ONLY against throwaway containers (own PostgreSQL 16, Redis 7, private network).
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
cd "$here/../.."

IMG="${1:?server image}"; MIG="${2:?migrate image}"; NODE="${3:-/nodejs/bin/node}"
EXPECTED_NODE="${EXPECTED_NODE:-24.22.1}"
R="r21s$$"; NET="${R}_net"; PG="${R}-pg"; RD="${R}-redis"; APP="${R}-app"; APP2="${R}-app-ro"
cleanup() { docker rm -fv "$APP" "$APP2" "$PG" "$RD" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT

section "Environment"
echo "docker: $(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')   image: $IMG ($(docker image inspect "$IMG" --format '{{.Id}} {{.Size}}'))"

section "A1 Node version, A7 user, A6 no shell/npm (static facts from the image)"
v="$(docker run --rm --entrypoint "$NODE" "$IMG" -p process.version 2>&1)"
[ "$v" = "v${EXPECTED_NODE}" ] && pass "A1 node $v is the pinned version" || fail "A1 node is '$v', expected v${EXPECTED_NODE}"
u="$(docker image inspect "$IMG" --format '{{.Config.User}}')"
uid="$(docker run --rm --entrypoint "$NODE" "$IMG" -p 'process.getuid()' 2>&1)"
{ [ -n "$u" ] && [ "$uid" != "0" ]; } && pass "A7 runs as non-root: Config.User='$u', process uid=$uid" || fail "A7 root or no USER (Config.User='$u' uid=$uid)"
out="$(docker run --rm --entrypoint sh "$IMG" -c true 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ]; } && pass "A6 no shell: 'sh' cannot be started (exit $rc: $(echo "$out" | head -c 160))" || fail "A6 a shell exists in the image"
out="$(docker run --rm --entrypoint /bin/sh "$IMG" -c true 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && pass "A6 no /bin/sh either (exit $rc)" || fail "A6 /bin/sh exists"
for t in npm npx corepack; do
  out="$(docker run --rm --entrypoint "$t" "$IMG" --version 2>&1)"; rc=$?
  [ "$rc" -ne 0 ] && pass "A6 '$t' cannot be run" || fail "A6 '$t' runs"
done

section "A3/A4/A5 runtime-image-checks inside the image (Node version, non-root, requires resolve, sodium-native, tiny-secp256k1, Prisma client, @sails/core, tree walk, bare-runtime)"
docker run --rm -i -e "EXPECTED_NODE=${EXPECTED_NODE}" --entrypoint "$NODE" "$IMG" - < scripts/runtime-image-checks.js >/tmp/r21-checks.$$ 2>&1; rc=$?
cat /tmp/r21-checks.$$ | sed 's/^/    /'; rm -f /tmp/r21-checks.$$
[ "$rc" -eq 0 ] && pass "A3-A5 runtime-image-checks exit 0" || fail "A3-A5 runtime-image-checks exit $rc"

section "Throwaway stack: PostgreSQL, Redis, then the migration image"
docker network create "$NET" >/dev/null; join_network "$NET"
start_postgres "$PG" "$NET" && start_redis "$RD" "$NET"
out="$(docker run --rm --network "$NET" -e "DATABASE_URL=postgresql://postgres:password@${PG}:5432/sails_protocol" "$MIG" 2>&1)"; rc=$?
echo "$out" | tail -n 4 | sed 's/^/    /'
[ "$rc" -eq 0 ] && pass "migration image applied the migrations (exit 0)" || fail "migration image exit $rc"
n="$(sql sails_protocol "select count(*) from _prisma_migrations where finished_at is not null" 2>&1)"
[ "$n" = "37" ] && pass "37 migrations applied and finished" || fail "migrations finished: '$n'"

section "A2/A4 production boot, Prisma/PostgreSQL/Redis connectivity, health endpoints"
mapfile -t ENV_ARGS < <(prod_env "$PG" "$RD")
docker run -d --name "$APP" --network "$NET" "${ENV_ARGS[@]}" "$IMG" >/dev/null
wait_http "http://${APP}:3000/health/live" 90 "$APP"; w=$?
if [ "$w" -eq 0 ]; then pass "A2 the server answers /health/live"; else fail "A2 server did not come up (wait_http=$w)"; docker logs "$APP" 2>&1 | tail -n 30 | sed 's/^/    /'; fi
H="$(curl -fsS --max-time 5 "http://${APP}:3000/health" 2>&1)"; L="$(curl -fsS --max-time 5 "http://${APP}:3000/health/live" 2>&1)"
RS="$(curl -sS --max-time 5 -o /tmp/r21-ready.$$ -w '%{http_code}' "http://${APP}:3000/health/ready" 2>&1)"; R_BODY="$(cat /tmp/r21-ready.$$ 2>/dev/null)"; rm -f /tmp/r21-ready.$$
echo "    /health       $H"; echo "    /health/live  $L"; echo "    /health/ready $RS $R_BODY"
echo "$H" | grep -q '"status":"ok"' && echo "$H" | grep -q '"mockEscrow":false' && echo "$H" | grep -q '"mockSettlement":false' && pass "A9 /health ok, no mocks" || fail "A9 /health unexpected"
[ "$RS" = "200" ] && echo "$R_BODY" | grep -q '"status":"ready"' && pass "A4 /health/ready 200 ready (PostgreSQL + Redis reachable through the Prisma client)" || fail "A4 /health/ready $RS"
docker logs "$APP" 2>&1 | grep -q 'Cannot find module' && fail "A9 logs contain 'Cannot find module'" || pass "A9 no 'Cannot find module' in the logs"
measure "first log lines: $(docker logs "$APP" 2>&1 | head -n 3 | cut -c1-200 | tr '\n' '|')"

section "A9 built-in HEALTHCHECK (exec form, absolute node path)"
for i in $(seq 1 24); do
  st="$(docker inspect -f '{{.State.Health.Status}}' "$APP" 2>/dev/null)"; [ "$st" = "healthy" ] && break; sleep 5
done
[ "$st" = "healthy" ] && pass "A9 container health status = healthy" || { fail "A9 health status '$st'"; docker inspect -f '{{json .State.Health}}' "$APP" | cut -c1-400; }

section "A5 QVAC / Bare runtime inside the running container (no shell: absolute node path)"
out="$(docker exec "$APP" "$NODE" -e "import('@qvac/sdk').then(m=>{console.log('import ok exports='+Object.keys(m).length);process.exit(0)}).catch(e=>{console.log('import error '+e.message);process.exit(3)})" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && pass "A5 @qvac/sdk imports ($out)" || fail "A5 @qvac/sdk import failed ($out)"
out="$(docker exec "$APP" "$NODE" /app/node_modules/bare-runtime/bin/bare --version 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && pass "A5 the Bare native runtime starts through its package wrapper ($out)" || fail "A5 bare did not start: $(echo "$out" | head -c 200)"

section "A8 stop signal: graceful exit time and code"
t0=$(date +%s.%N); docker stop -t 25 "$APP" >/dev/null 2>&1; t1=$(date +%s.%N)
code="$(docker inspect -f '{{.State.ExitCode}}' "$APP")"; dur="$(echo "$t1 - $t0" | bc -l 2>/dev/null || awk "BEGIN{print $t1 - $t0}")"
measure "docker stop: ${dur}s, exit code $code"
{ [ "$code" = "0" ] || [ "$code" = "143" ]; } && awk "BEGIN{exit !($dur < 20)}" && pass "A8 stopped on SIGTERM within 20 s (exit $code, ${dur}s)" || fail "A8 slow or abnormal stop (exit $code, ${dur}s; 137 would mean SIGKILL)"
echo "    last logs: $(docker logs --tail 3 "$APP" 2>&1 | cut -c1-160 | tr '\n' '|')"

section "A7 read-only root filesystem (--read-only --tmpfs /tmp), non-root"
docker run -d --name "$APP2" --network "$NET" --read-only --tmpfs /tmp "${ENV_ARGS[@]}" "$IMG" >/dev/null
wait_http "http://${APP2}:3000/health/ready" 90 "$APP2"; w=$?
[ "$w" -eq 0 ] && pass "A7 the server is ready on a read-only root filesystem" || { fail "A7 not ready on read-only rootfs (wait_http=$w)"; docker logs "$APP2" 2>&1 | tail -n 15 | sed 's/^/    /'; }
out="$(docker exec "$APP2" "$NODE" /app/node_modules/bare-runtime/bin/bare --version 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then pass "A7 Bare starts on a read-only rootfs ($out)"; else fail "A7 Bare cannot start on a read-only rootfs: $(echo "$out" | tr '\n' ' ' | head -c 220)"; fi
st="$(docker exec "$APP2" "$NODE" -e "const s=require('fs').statSync('/app/node_modules/bare-runtime-linux-x64/bin/bare');console.log((s.mode&0o777).toString(8)+' uid='+s.uid)" 2>&1)"
measure "mode of bare-runtime-linux-x64/bin/bare in the image: $st"

section "Negative: the container must not run as root or hold a shell, and must refuse an unsafe configuration"
out="$(docker run --rm --network "$NET" -e NODE_ENV=production "$IMG" 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q FATAL; } && pass "fail-closed: production without configuration refuses to boot (exit $rc)" || fail "no refusal without configuration (exit $rc)"

summary
