#!/usr/bin/env bash
# Staging H1 smoke (Issue #474 barrier). Runs against a stack already started with this directory's
# docker-compose.yml. Read-only for the running stack; the negative boots start throwaway containers that exit.
#   bash deploy/staging/smoke.sh deploy/staging/.env
set -euo pipefail
ENV_FILE="${1:?usage: smoke.sh <env-file>}"
COMPOSE=(docker compose -f "$(dirname "$0")/docker-compose.yml" --env-file "$ENV_FILE")
BASE="${SMOKE_BASE_URL:-http://127.0.0.1:3000}"
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

for i in $(seq 1 60); do curl -fsS "$BASE/health/live" >/dev/null 2>&1 && break; sleep 2; done
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health/live"); [ "$code" = 200 ] || fail "/health/live answered $code"
ready=$(curl -s -w '\n%{http_code}' "$BASE/health/ready")
[ "$(tail -n1 <<<"$ready")" = 200 ] || fail "/health/ready not ready: $ready"
grep -q '"status":"ready"' <<<"$ready" || fail "/health/ready body: $ready"
health=$(curl -fsS "$BASE/health")
grep -q '"mockEscrow":false' <<<"$health" && grep -q '"mockSettlement":false' <<<"$health" || fail "mock flags not off: $health"
echo "ok   liveness, readiness, mocks off"

# Inside the running app container: the environment it really booted with and the rail policy it really enforces.
"${COMPOSE[@]}" exec -T app node -e '
  if (process.env.NODE_ENV !== "production") { console.error("NODE_ENV=" + process.env.NODE_ENV); process.exit(1) }
  const { assertDeploymentEligible } = require("./dist/src/modules/open-settlement/escrow-providers")
  assertDeploymentEligible("MULTISIG")
  for (const t of ["WDK_USDT_EVM", "SAFE_GUARD_EVM", "LIGHTNING_HODL", "MOCK"]) {
    try { assertDeploymentEligible(t); console.error(t + " is eligible"); process.exit(1) } catch (e) { if (!/not economically eligible in production/.test(e.message)) throw e }
  }' || fail "in-container environment or rail eligibility"
echo "ok   NODE_ENV=production in the container; only MULTISIG is deployment-eligible"

# Negative boots: the same image and environment with one value wrong must refuse to start (non-zero exit).
image=$("${COMPOSE[@]}" images -q app | head -n1); [ -n "$image" ] || fail "app image not found"
network=$(docker inspect "$("${COMPOSE[@]}" ps -q app)" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')
envs=$("${COMPOSE[@]}" config --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s).services.app.environment;for(const[k,v]of Object.entries(e))console.log(k+"="+(v??""))})')
refuses() {
  local label="$1"; shift
  local args=(); while IFS= read -r line; do args+=(-e "$line"); done <<<"$envs"
  set +e; out=$(timeout 60 docker run --rm --network "$network" "${args[@]}" "$@" "$image" 2>&1); rc=$?; set -e
  [ "$rc" -ne 0 ] && [ "$rc" -ne 124 ] || fail "$label: the app did not refuse to boot (exit $rc)"
  echo "ok   refuses to boot: $label"
}
refuses "NODE_ENV=staging (unrecognized)" -e NODE_ENV=staging
refuses "NODE_ENV empty" -e NODE_ENV=
refuses "WDK_SEED_PHRASE configured" -e "WDK_SEED_PHRASE=test only example seed phrase never real"
refuses "MOCK_ESCROW=true" -e MOCK_ESCROW=true
refuses "EVIDENCE_PROVIDER=local-fs" -e EVIDENCE_PROVIDER=local-fs
echo "SMOKE PASS"
