#!/usr/bin/env bash
# P51: one complete, self-contained execution on a FRESH regtest chain (blocks generated from zero, no snapshot).
# The workflow calls this twice (run 1, run 2) on the same SHA; the structural comparison decides reproducibility.
#
# Usage: run-once.sh <N>
# Env (set by the workflow): CODE_DIR (tree under proof, infra overlaid) BITCOIN_BIN_DIR ELECTRS_BIN EVIDENCE_ROOT
#   FIXED_FEE_SAT_PER_VB RUNNER_TEMP
# Isolation: regtest only; bitcoind RPC bound to 127.0.0.1 with EPHEMERAL credentials generated here; P2P fully off;
# nothing listens outside loopback; the datadir (wallet, cookie) is wiped on exit and is NEVER copied to the evidence.
set -euo pipefail
N="${1:?run number}"
: "${CODE_DIR:?}" "${BITCOIN_BIN_DIR:?}" "${ELECTRS_BIN:?}" "${EVIDENCE_ROOT:?}" "${FIXED_FEE_SAT_PER_VB:?}" "${RUNNER_TEMP:?}" "${SECRETS_DIR:?}"

RUN_DIR="$EVIDENCE_ROOT/run$N"
WORK="$RUNNER_TEMP/p51-run$N"
INFRA="$CODE_DIR/tests/regtest"
RPC_PORT=18443; ELECTRS_HTTP=3002; ELECTRS_ELECTRUM=60401; ELECTRS_MON=24224
PROXY_PORT=3003; FAULT500_PORT=3004; EMPTY_PORT=3005
mkdir -p "$RUN_DIR" "$WORK/bitcoin" "$WORK/electrs-db"

# Ephemeral credentials, generated now, masked in the log, never written to the evidence.
RPC_USER="u$(openssl rand -hex 6)"
RPC_PASS="$(openssl rand -hex 24)"
MULTISIG_SEED="$(openssl rand -hex 32)"
echo "::add-mask::$RPC_PASS"; echo "::add-mask::$MULTISIG_SEED"
SALT="$(openssl rand -hex 16)"
HMAC="$(printf '%s' "$RPC_PASS" | openssl dgst -sha256 -hmac "$SALT" | awk '{print $NF}')"
RPCAUTH="$RPC_USER:$SALT\$$HMAC"
export RPC_USER RPC_PASS MULTISIG_SEED
# The literal VALUES of this run's ephemeral secrets go to SECRETS_DIR, OUTSIDE evidence/. scan-evidence.sh searches the evidence for them and
# then deletes the directory. It FAILS if a run directory exists without its values file (never a silent skip).
mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR" 2>/dev/null || true
( umask 077; printf '%s\n' "$RPC_PASS" "$RPC_USER" "$RPCAUTH" "$SALT" "$HMAC" "$MULTISIG_SEED" > "$SECRETS_DIR/run$N.values" )

PIDS=()
cleanup() {
  set +e
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  "$BITCOIN_BIN_DIR/bitcoin-cli" -regtest -datadir="$WORK/bitcoin" -rpcport="$RPC_PORT" -rpcuser="$RPC_USER" -rpcpassword="$RPC_PASS" stop >/dev/null 2>&1
  for _ in $(seq 1 30); do pgrep -x bitcoind >/dev/null || break; sleep 1; done
  rm -rf "$WORK"   # wallet, cookie, rpcauth: gone. Never part of the evidence.
}
trap cleanup EXIT

cli() { "$BITCOIN_BIN_DIR/bitcoin-cli" -regtest -datadir="$WORK/bitcoin" -rpcport="$RPC_PORT" -rpcuser="$RPC_USER" -rpcpassword="$RPC_PASS" "$@"; }
wait_http() { # wait_http URL SECONDS
  for _ in $(seq 1 "$2"); do curl -sf -o /dev/null "$1" && return 0; sleep 1; done
  echo "timeout waiting for $1" >&2; return 1
}

echo "=== run $N: bitcoind (regtest, P2P off, RPC loopback, ephemeral credentials) ==="
"$BITCOIN_BIN_DIR/bitcoind" -regtest -datadir="$WORK/bitcoin" -server=1 -txindex=1 \
  -listen=0 -dnsseed=0 -discover=0 -networkactive=0 \
  -rpcbind=127.0.0.1 -rpcallowip=127.0.0.1 -rpcport="$RPC_PORT" -rpcauth="$RPCAUTH" \
  -fallbackfee=0.0002 -daemonwait
chain="$(cli getblockchaininfo | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).chain')"
[ "$chain" = "regtest" ] || { echo "REFUSING: chain is '$chain', not regtest" >&2; exit 1; }
cli getblockchaininfo > "$RUN_DIR/getblockchaininfo-initial.json"

echo "=== electrs (Esplora REST) indexing this bitcoind ==="
# FLAGS: conventional for the Blockstream/electrs (Esplora) fork; the GK confirms them against electrs-help.txt for the
# pinned commit BEFORE the first run. If a flag is wrong the process exits at once and the job fails here, loudly.
"$ELECTRS_BIN" -vv --network regtest --daemon-dir "$WORK/bitcoin" --daemon-rpc-addr "127.0.0.1:$RPC_PORT" \
  --cookie "$RPC_USER:$RPC_PASS" --db-dir "$WORK/electrs-db" --http-addr "127.0.0.1:$ELECTRS_HTTP" \
  --electrum-rpc-addr "127.0.0.1:$ELECTRS_ELECTRUM" --monitoring-addr "127.0.0.1:$ELECTRS_MON" --jsonrpc-import \
  > "$WORK/electrs.log" 2>&1 &
PIDS+=("$!")
wait_http "http://127.0.0.1:$ELECTRS_HTTP/blocks/tip/height" 180

echo "=== front proxies: normal + two fault-injection instances (loopback) ==="
start_proxy() { # start_proxy PORT MODE LOGFILE
  FIXED_FEE_SAT_PER_VB="$FIXED_FEE_SAT_PER_VB" ESPLORA_UPSTREAM="http://127.0.0.1:$ELECTRS_HTTP" PROXY_PORT="$1" FEE_MODE="$2" PROXY_LOG="$3" \
    node "$INFRA/esplora-front/server.mjs" > "$WORK/proxy-$1.out" 2>&1 &
  PIDS+=("$!")
}
start_proxy "$PROXY_PORT"    normal   "$RUN_DIR/proxy-normal.log"
start_proxy "$FAULT500_PORT" fault500 "$RUN_DIR/proxy-fault500.log"
start_proxy "$EMPTY_PORT"    empty    "$RUN_DIR/proxy-empty.log"
wait_http "http://127.0.0.1:$PROXY_PORT/blocks/tip/height" 60
wait_http "http://127.0.0.1:$FAULT500_PORT/blocks/tip/height" 30
wait_http "http://127.0.0.1:$EMPTY_PORT/blocks/tip/height" 30

export RPC_URL="http://127.0.0.1:$RPC_PORT" PROXY_URL="http://127.0.0.1:$PROXY_PORT" OUT_DIR="$RUN_DIR" FIXED_FEE_SAT_PER_VB
export PROXY_FAULT500_URL="http://127.0.0.1:$FAULT500_PORT" PROXY_EMPTY_URL="http://127.0.0.1:$EMPTY_PORT"
export PROXY_FAULT500_LOG="$RUN_DIR/proxy-fault500.log" PROXY_EMPTY_LOG="$RUN_DIR/proxy-empty.log"
# The provider under test talks ONLY to the loopback proxy, on regtest.
export MULTISIG_NETWORK=regtest MULTISIG_EXPLORER_API_URL="http://127.0.0.1:$PROXY_PORT"

rc_fidelity=0; rc_fee=0; rc_scen=0
echo "=== BLOCKING: fidelity of the 7 Esplora routes vs the real bitcoind ==="
node "$INFRA/first-flow/fidelity.check.mjs" 2>&1 | tee "$RUN_DIR/fidelity.log" || rc_fidelity=${PIPESTATUS[0]}
rc_fidelity="${rc_fidelity:-0}"

echo "=== fee route: the provider REFUSES to guess (500 and {}), 0 POST ==="
( cd "$CODE_DIR" && "$CODE_DIR/node_modules/.bin/ts-node" --transpile-only tests/regtest/first-flow/fee-negative.check.ts ) 2>&1 | tee "$RUN_DIR/fee-negative.log" || rc_fee=${PIPESTATUS[0]}

echo "=== scenarios D7-D12 (only if the drivers are present in this tree) ==="
shopt -s nullglob
drivers=("$INFRA"/first-flow/scenarios/*.check.ts)
if [ "${#drivers[@]}" -eq 0 ]; then
  echo "ABSENT: no scenario drivers (D7-D12) are present in this tree. They were NOT run. D1-D6 depend on #235/F3/F4 and are NOT covered." | tee "$RUN_DIR/scenarios-status.txt"
else
  : > "$RUN_DIR/scenarios-status.txt"
  for d in "${drivers[@]}"; do
    name="$(basename "$d" .check.ts)"
    if ( cd "$CODE_DIR" && "$CODE_DIR/node_modules/.bin/ts-node" --transpile-only "$d" ) 2>&1 | tee "$RUN_DIR/$name.log"; then echo "$name: PASS" >> "$RUN_DIR/scenarios-status.txt"
    else echo "$name: FAIL" >> "$RUN_DIR/scenarios-status.txt"; rc_scen=1; fi
  done
fi

cli getblockchaininfo > "$RUN_DIR/getblockchaininfo-final.json"
# Logs: filtered, never the datadir. The filter drops any line that could carry a credential.
grep -viE 'rpcauth|rpcpassword|cookie|password' "$WORK/bitcoin/regtest/debug.log" > "$RUN_DIR/bitcoind-debug.log" 2>/dev/null || true
grep -viE 'rpcauth|rpcpassword|cookie|password' "$WORK/electrs.log" > "$RUN_DIR/electrs.log" 2>/dev/null || true

echo "run $N: fidelity rc=$rc_fidelity fee-negative rc=$rc_fee scenarios rc=$rc_scen"
[ "$rc_fidelity" -eq 0 ] && [ "$rc_fee" -eq 0 ] && [ "$rc_scen" -eq 0 ]
