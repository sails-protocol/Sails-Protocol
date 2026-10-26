#!/usr/bin/env bash
# Shared helpers of the P3-R2.1 experiment scripts. Sourced, never executed.
# Needs: bash, docker CLI (talking to a throwaway engine), curl, coreutils. Every resource it creates is
# named r21<kind>$$ and removed by the sourcing script's cleanup. No shared database, no registry push.
set -uo pipefail

PASS_N=0
FAIL_N=0
pass() { echo "PASS  $*"; PASS_N=$((PASS_N + 1)); }
fail() { echo "FAIL  $*"; FAIL_N=$((FAIL_N + 1)); }
measure() { echo "MEASURE  $*"; }   # a recorded observation that is not an assertion
section() { echo; echo "=== $*"; }
summary() { echo; echo "RESULT: ${PASS_N} PASS, ${FAIL_N} FAIL"; [ "$FAIL_N" -eq 0 ]; }

# Make this (runner) container reachable from the throwaway network, so curl can use container names.
join_network() { docker network connect "$1" "$(cat /etc/hostname)" >/dev/null 2>&1 || true; }

PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
REDIS_IMAGE="${REDIS_IMAGE:-redis:7-alpine}"

start_postgres() { # <name> <network> [--internal-ok]
  docker run -d --name "$1" --network "$2" -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=password -e POSTGRES_DB=sails_protocol "$PG_IMAGE" >/dev/null
  local i
  for i in $(seq 1 60); do
    docker exec "$1" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "postgres did not become ready" >&2; return 1
}
start_redis() { docker run -d --name "$1" --network "$2" "$REDIS_IMAGE" >/dev/null; }
sql() { docker exec "$PG" psql -h 127.0.0.1 -U postgres -d "$1" -Atc "$2"; }   # sql <db> <statement>
newdb() { docker exec "$PG" psql -h 127.0.0.1 -U postgres -d postgres -Atc "create database $1" >/dev/null; }

# A complete, NON-SECRET production configuration (placeholders for a throwaway stack; same as scripts/docker-runtime-test.sh).
prod_env() { # <db-host> <redis-host>
  printf '%s\n' -e NODE_ENV=production -e "DATABASE_URL=postgresql://postgres:password@$1:5432/sails_protocol" -e "REDIS_URL=redis://$2:6379" \
    -e PORT=3000 -e HOST=0.0.0.0 -e MULTISIG_NETWORK=regtest -e MOCK_ESCROW=false -e MOCK_SETTLEMENT=false -e ENFORCE_CAPABILITIES=true \
    -e EVIDENCE_PROVIDER=s3 -e EVIDENCE_S3_BUCKET=ci-placeholder-bucket -e EVIDENCE_S3_ACCESS_KEY_ID=ci-placeholder-access-key -e EVIDENCE_S3_SECRET_ACCESS_KEY=ci-placeholder-secret-key
}

wait_http() { # <url> <seconds> <container>   -> 0 when 200, 1 timeout, 2 container exited
  local deadline=$((SECONDS + $2))
  until curl -fsS --max-time 3 "$1" >/dev/null 2>&1; do
    [ "$(docker inspect -f '{{.State.Running}}' "$3" 2>/dev/null)" = "true" ] || return 2
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 2
  done
}
