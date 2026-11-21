#!/usr/bin/env bash
# Staging H1 smoke (Issue #474 barrier). Runs against a stack already started with this directory's
# docker-compose.yml. Read-only for the running stack; the negative boots start throwaway containers that exit.
#   bash deploy/staging/smoke.sh deploy/staging/.env
set -euo pipefail
ENV_FILE="${1:?usage: smoke.sh <env-file>}"
COMPOSE=(docker compose -f "$(dirname "$0")/docker-compose.yml" --env-file "$ENV_FILE")
BASE="${SMOKE_BASE_URL:-http://127.0.0.1:3000}"
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

# The runtime image must carry every workspace package the app requires (they are symlinks into packages/*).
image=$("${COMPOSE[@]}" images -q app | head -n1); [ -n "$image" ] || fail "app image not found"
docker run --rm --entrypoint node "$image" -e '
  for (const m of ["@sails/core", "@satsails/p2p-schemas", "@satsails/p2p-trading-sdk"]) console.log("resolves", m, "->", require.resolve(m))
' || fail "runtime image cannot resolve a workspace package"

for i in $(seq 1 60); do curl -fsS "$BASE/health/live" >/dev/null 2>&1 && break; sleep 2; done
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health/live"); [ "$code" = 200 ] || fail "/health/live answered $code"
ready=$(curl -s -w '\n%{http_code}' "$BASE/health/ready")
[ "$(tail -n1 <<<"$ready")" = 200 ] || fail "/health/ready not ready: $ready"
grep -q '"status":"ready"' <<<"$ready" || fail "/health/ready body: $ready"
health=$(curl -fsS "$BASE/health")
grep -q '"mockEscrow":false' <<<"$health" && grep -q '"mockSettlement":false' <<<"$health" || fail "mock flags not off: $health"
echo "ok   liveness, readiness, mocks off"

# Redis: its own healthcheck reports healthy, and the server refuses an unauthenticated client.
[ "$(docker inspect "$("${COMPOSE[@]}" ps -q redis)" --format '{{.State.Health.Status}}')" = healthy ] || fail "redis healthcheck is not healthy"
"${COMPOSE[@]}" exec -T redis sh -c 'unset REDISCLI_AUTH; redis-cli ping 2>&1' | grep -q NOAUTH || fail "redis accepted an unauthenticated PING"
echo "ok   redis healthy; unauthenticated access refused"

# Inside the running app container: the environment it really booted with and the rail policy it really enforces.
"${COMPOSE[@]}" exec -T app node -e '
  if (process.env.NODE_ENV !== "production") { console.error("NODE_ENV=" + process.env.NODE_ENV); process.exit(1) }
  const { assertDeploymentEligible } = require("./dist/src/modules/open-settlement/escrow-providers")
  assertDeploymentEligible("MULTISIG")
  for (const t of ["WDK_USDT_EVM", "SAFE_GUARD_EVM", "LIGHTNING_HODL", "MOCK"]) {
    try { assertDeploymentEligible(t); console.error(t + " is eligible"); process.exit(1) } catch (e) { if (!/not economically eligible in production/.test(e.message)) throw e }
  }' || fail "in-container environment or rail eligibility"
echo "ok   NODE_ENV=production in the container; only MULTISIG is deployment-eligible"

# Negative boots: the same image and the app's own resolved environment with exactly one value changed must refuse
# to start, and for the reason that value's own boot gate gives (its FATAL message), not merely any failure.
# The environment goes through a 0600 temp file, never through process arguments, and is deleted on exit; on a
# mismatch only the FATAL line (or the exit code) is printed, never the environment.
network=$(docker inspect "$("${COMPOSE[@]}" ps -q app)" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')
envdir=$(mktemp -d); chmod 700 "$envdir"; trap 'rm -rf "$envdir"' EXIT
"${COMPOSE[@]}" config --format json > "$envdir/config.json"
refuses() {
  local label="$1" key="$2" value="$3" reason="$4" file="$envdir/case.env"
  (umask 077; node -e '
    const [cfg, key, value, out] = process.argv.slice(1)
    const env = { ...JSON.parse(require("fs").readFileSync(cfg, "utf8")).services.app.environment, [key]: value }
    require("fs").writeFileSync(out, Object.entries(env).map(([k, v]) => `${k}=${v ?? ""}`).join("\n") + "\n")
  ' "$envdir/config.json" "$key" "$value" "$file")
  set +e; out=$(timeout 60 docker run --rm --network "$network" --env-file "$file" "$image" 2>&1); rc=$?; set -e
  rm -f "$file"
  [ "$rc" -ne 0 ] && [ "$rc" -ne 124 ] || fail "$label: the app did not refuse to boot (exit $rc)"
  grep -qF "$reason" <<<"$out" || fail "$label: refused (exit $rc) but not by its gate; FATAL line: $(grep -m1 -o 'FATAL: [^.]*' <<<"$out" || echo none)"
  echo "ok   refuses to boot: $label ($reason)"
}
refuses "NODE_ENV=staging" NODE_ENV staging "FATAL: NODE_ENV is set to an unrecognized value 'staging'"
refuses "NODE_ENV empty" NODE_ENV "" "FATAL: NODE_ENV is set to an unrecognized value ''"
refuses "WDK_SEED_PHRASE configured" WDK_SEED_PHRASE "test only example seed phrase never real" "FATAL: NODE_ENV=production, MOCK_ESCROW=false, and WDK_SEED_PHRASE is configured"
refuses "MOCK_ESCROW=true" MOCK_ESCROW true "FATAL: NODE_ENV=production but MOCK_ESCROW is not explicitly false"
refuses "EVIDENCE_PROVIDER=local-fs" EVIDENCE_PROVIDER local-fs 'FATAL: NODE_ENV=production but EVIDENCE_PROVIDER is unset (or "local-fs")'
echo "SMOKE PASS (configuration and boot gates only; no economic flow is exercised)"
