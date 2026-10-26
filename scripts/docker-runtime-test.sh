#!/usr/bin/env bash
# scripts/docker-runtime-test.sh
#
# Builds the PRODUCTION image (`docker build --target runtime`) and runs THAT
# image — not the `builder` stage docker-compose.yml's `app` service uses.
# scripts/docker-test.sh never exercises the production stage, which is how
# `Cannot find module '@sails/core'` (a package the runtime stage forgot to
# copy) kept the real image from booting while every check stayed green.
#
# Checks, in order; the first failure stops the script with a non-zero status
# and prints the container logs:
#   1. the runtime stage builds;
#   2. inside the image: pinned Node version, non-root user, every package the
#      compiled server requires resolves, native modules and Prisma load
#      (scripts/runtime-image-checks.js);
#   3. in NODE_ENV=production the image REFUSES to boot when a mandatory
#      setting is missing or unsafe (no MULTISIG_NETWORK, MOCK_ESCROW on,
#      ENFORCE_CAPABILITIES off) — the fail-closed gates are part of the image;
#   4. in NODE_ENV=production, with a complete NON-SECRET placeholder
#      configuration, the image boots against real PostgreSQL and Redis, and
#      /health, /health/live and /health/ready answer correctly
#      (/health must report mockEscrow=false and mockSettlement=false).
# Nothing here is published, pushed or deployed. Every credential below is a
# placeholder for a throwaway local stack; none is a real secret.
#
# Usage: bash scripts/docker-runtime-test.sh        (from the repo root)

set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="${RUNTIME_IMAGE_TAG:-sails-runtime-ci:local}"
PROJECT="sailsrt$$"
APP="${PROJECT}-app"
NETWORK="${PROJECT}_default"
BOOT_TIMEOUT_S="${BOOT_TIMEOUT_S:-90}"
STEP="starting"

compose() { docker compose -p "$PROJECT" "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo
    echo "::group::FAILED during: ${STEP} (exit ${status})"
    docker logs "$APP" 2>&1 | tail -n 80 || true
    echo "::endgroup::"
  fi
  docker rm -f "$APP" >/dev/null 2>&1 || true
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { STEP="$*"; echo; echo "=== $*"; }

# --- The Node version the Dockerfile pins is the single source of truth. ----
step "Resolve the pinned Node version from the Dockerfile"
PINNED_VERSIONS=$(grep -E '^FROM node:' Dockerfile | sed -E 's/^FROM node:([0-9]+\.[0-9]+\.[0-9]+)-.*/\1/' | sort -u)
[ "$(echo "$PINNED_VERSIONS" | wc -l)" -eq 1 ] || fail "Dockerfile pins more than one Node version: $PINNED_VERSIONS"
echo "$PINNED_VERSIONS" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "Dockerfile does not pin an exact Node version: '$PINNED_VERSIONS'"
EXPECTED_NODE="$PINNED_VERSIONS"
echo "pinned Node: ${EXPECTED_NODE}"

step "Build the production image: docker build --target runtime"
docker build --target runtime -t "$IMAGE" .

step "Checks inside the image (Node version, non-root, requires, native modules)"
docker run --rm -i -e "EXPECTED_NODE=${EXPECTED_NODE}" --entrypoint node "$IMAGE" - < scripts/runtime-image-checks.js

# --- Real PostgreSQL, Redis and migrations: the same services the compose
#     stack defines; only the app under test is the runtime image. ------------
step "Start PostgreSQL and Redis, apply migrations"
compose up -d --wait postgres redis
compose run --rm migrate

# A complete, NON-SECRET production configuration. EVIDENCE_S3_* are
# placeholders: the provider is constructed at boot but contacts nothing
# until evidence is stored, which this test never does.
PROD_ENV=(
  -e NODE_ENV=production
  -e DATABASE_URL=postgresql://postgres:password@postgres:5432/sails_protocol
  -e REDIS_URL=redis://redis:6379
  -e PORT=3000
  -e HOST=0.0.0.0
  -e MULTISIG_NETWORK=regtest
  -e MOCK_ESCROW=false
  -e MOCK_SETTLEMENT=false
  -e ENFORCE_CAPABILITIES=true
  -e EVIDENCE_PROVIDER=s3
  -e EVIDENCE_S3_BUCKET=ci-placeholder-bucket
  -e EVIDENCE_S3_ACCESS_KEY_ID=ci-placeholder-access-key
  -e EVIDENCE_S3_SECRET_ACCESS_KEY=ci-placeholder-secret-key
)

# Replaces `-e NAME=...` in PROD_ENV with `-e NAME=value`, or drops it when
# value is the literal word UNSET.
prod_env_with() {
  local name="$1" value="$2" out=() i=0
  while [ "$i" -lt "${#PROD_ENV[@]}" ]; do
    if [ "${PROD_ENV[$i]}" = "-e" ] && [[ "${PROD_ENV[$((i + 1))]}" == "${name}="* ]]; then
      [ "$value" = "UNSET" ] || out+=(-e "${name}=${value}")
    else
      out+=("${PROD_ENV[$i]}" "${PROD_ENV[$((i + 1))]}")
    fi
    i=$((i + 2))
  done
  printf '%s\n' "${out[@]}"
}

expect_refusal() {
  local label="$1" expected_text="$2" name="$3" value="$4" output status=0
  step "Production refuses to boot: ${label}"
  mapfile -t env_args < <(prod_env_with "$name" "$value")
  output=$(timeout 60 docker run --rm --network "$NETWORK" "${env_args[@]}" "$IMAGE" 2>&1) || status=$?
  echo "$output" | grep -E 'FATAL' | head -n 2 || true
  [ "$status" -ne 0 ] || fail "${label}: the container exited 0 — it must refuse to boot"
  [ "$status" -ne 124 ] || fail "${label}: the container kept running instead of refusing"
  echo "$output" | grep -q "$expected_text" || fail "${label}: refused, but not for the expected reason (wanted '${expected_text}')"
  echo "$output" | grep -qi 'server listening' && fail "${label}: the server started"
  echo "ok: exit ${status}, reason '${expected_text}'"
}

expect_refusal "MULTISIG_NETWORK missing" "MULTISIG_NETWORK" MULTISIG_NETWORK UNSET
expect_refusal "MOCK_ESCROW enabled" "MOCK_ESCROW" MOCK_ESCROW true
expect_refusal "ENFORCE_CAPABILITIES off" "ENFORCE_CAPABILITIES" ENFORCE_CAPABILITIES false

step "Boot the production image in NODE_ENV=production with the placeholder configuration"
docker run -d --name "$APP" --network "$NETWORK" -p 127.0.0.1::3000 "${PROD_ENV[@]}" "$IMAGE" >/dev/null
PORT_MAPPING=$(docker port "$APP" 3000/tcp | head -n 1)
BASE="http://127.0.0.1:${PORT_MAPPING##*:}"
echo "container ${APP} -> ${BASE}"

deadline=$((SECONDS + BOOT_TIMEOUT_S))
until curl -fsS --max-time 3 "${BASE}/health/live" >/dev/null 2>&1; do
  [ "$(docker inspect -f '{{.State.Running}}' "$APP")" = "true" ] || fail "the container exited during boot (exit $(docker inspect -f '{{.State.ExitCode}}' "$APP"))"
  [ "$SECONDS" -lt "$deadline" ] || fail "the server did not answer /health/live within ${BOOT_TIMEOUT_S}s"
  sleep 2
done

step "Health endpoints"
HEALTH=$(curl -fsS --max-time 5 "${BASE}/health")
LIVE=$(curl -fsS --max-time 5 "${BASE}/health/live")
READY_STATUS=$(curl -sS --max-time 5 -o /tmp/ready.$$ -w '%{http_code}' "${BASE}/health/ready")
READY=$(cat /tmp/ready.$$); rm -f /tmp/ready.$$
echo "/health       ${HEALTH}"
echo "/health/live  ${LIVE}"
echo "/health/ready ${READY_STATUS} ${READY}"
echo "$HEALTH" | grep -q '"status":"ok"' || fail "/health did not report status ok"
echo "$HEALTH" | grep -q '"mockEscrow":false' || fail "/health reports mockEscrow enabled in production"
echo "$HEALTH" | grep -q '"mockSettlement":false' || fail "/health reports mockSettlement enabled in production"
echo "$LIVE" | grep -q '"status":"ok"' || fail "/health/live did not report status ok"
[ "$READY_STATUS" = "200" ] || fail "/health/ready answered ${READY_STATUS}, not 200"
echo "$READY" | grep -q '"status":"ready"' || fail "/health/ready did not report ready"

step "The running container"
RUNNING_NODE=$(docker exec "$APP" node -p 'process.version')
RUNNING_UID=$(docker exec "$APP" node -p 'process.getuid()')
echo "node ${RUNNING_NODE}, uid ${RUNNING_UID}"
[ "$RUNNING_NODE" = "v${EXPECTED_NODE}" ] || fail "the container runs ${RUNNING_NODE}, the Dockerfile pins v${EXPECTED_NODE}"
[ "$RUNNING_UID" != "0" ] || fail "the container runs as root"
if docker logs "$APP" 2>&1 | grep -q 'Cannot find module'; then fail "the server logged 'Cannot find module'"; fi

STEP="done"
echo
echo "PASS: the production image (${IMAGE}) builds, refuses unsafe configuration, boots in NODE_ENV=production and answers its health endpoints."
