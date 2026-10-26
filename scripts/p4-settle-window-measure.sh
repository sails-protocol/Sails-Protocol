#!/usr/bin/env bash
# scripts/p4-settle-window-measure.sh
#
# MEASUREMENT harness for the P4 Gate 3 settle window W (docs/p4-gate3-unknown-outcome-contract.md 6.11, part A). It produces numbers; it does not
# choose W, does not touch the application, a database or any real network, and the guard stays OFF (DISPUTED_RECREATION_SETTLE_WINDOW_MS unset).
# Regtest only, two throwaway bitcoind nodes on an --internal Docker network (no route out), no wallet funds that exist anywhere else.
#
# What it measures (each line is machine-readable: `MEASURE <name> <value> <unit>`):
#   propagation_ms   a transaction accepted by node A until it is in node B's mempool (p50/p99 over N runs, default 30)
#   expiry           after `setmocktime` past -mempoolexpiry the transaction leaves the mempool on its own (so a lost round CAN disappear
#                    and a holder of a signed copy CAN re-broadcast it later: the guard's chain read is a point in time)
#   rebroadcast_ok   the same raw transaction is accepted again after it expired (nothing in the node refuses a late re-broadcast)
#   clock_skew_ms    |date(host) - date(container)| and the largest authorizedAt-vs-now error an instance with that skew would make
# It runs against a bitcoind image given by BITCOIND_IMAGE, which MUST be pinned by digest (name@sha256:...): a tag is refused.
#
# Usage:  BITCOIND_IMAGE='bitcoin/bitcoin@sha256:<digest>' bash scripts/p4-settle-window-measure.sh [runs]
# Image origin is the operator's/CTO's decision: docker.io/bitcoin/bitcoin is an UNOFFICIAL image (its own README says so; built by
# github.com/willcl-ark/bitcoin-core-docker CI, Debian images from bitcoincore.org binaries with signatures checked in that CI). It is fine for
# a disposable regtest measurement and for nothing else. This script has NOT been run in this repository's history: see the PR that added it.
set -euo pipefail

RUNS="${1:-30}"
IMAGE="${BITCOIND_IMAGE:-}"
case "$IMAGE" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) echo "BITCOIND_IMAGE must be pinned by digest (name@sha256:<64 hex>), got '${IMAGE}'" >&2; exit 2 ;; esac

NET="p4win-$$"; A="p4win-a-$$"; B="p4win-b-$$"
cleanup() { docker rm -f "$A" "$B" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
now_ms() { date +%s%3N; }
cli() { local n="$1"; shift; docker exec "$n" bitcoin-cli -regtest -rpcuser=t -rpcpassword=t "$@"; }

docker network create --internal "$NET" >/dev/null
for n in "$A" "$B"; do
  docker run -d --name "$n" --network "$NET" --cap-drop ALL --read-only --tmpfs /tmp --tmpfs /home/bitcoin/.bitcoin --entrypoint bitcoind "$IMAGE" \
    -regtest -server=1 -rpcuser=t -rpcpassword=t -rpcallowip=0.0.0.0/0 -rpcbind=0.0.0.0 -listen=1 -fallbackfee=0.0001 -mempoolexpiry=1 -acceptnonstdtxn=0 >/dev/null
done
for n in "$A" "$B"; do for i in $(seq 1 60); do cli "$n" getblockcount >/dev/null 2>&1 && break; sleep 1; done; done
cli "$A" addnode "$B" onetry >/dev/null
for i in $(seq 1 30); do [ "$(cli "$A" getconnectioncount)" -ge 1 ] && break; sleep 1; done

cli "$A" createwallet w >/dev/null; cli "$B" createwallet w >/dev/null
ADDR="$(cli "$A" -rpcwallet=w getnewaddress)"
cli "$A" generatetoaddress 101 "$ADDR" >/dev/null
for i in $(seq 1 30); do [ "$(cli "$B" getblockcount)" = "$(cli "$A" getblockcount)" ] && break; sleep 1; done
DEST="$(cli "$B" -rpcwallet=w getnewaddress)"

# propagation: A accepts -> B's mempool has it
samples=()
for r in $(seq 1 "$RUNS"); do
  t0="$(now_ms)"; txid="$(cli "$A" -rpcwallet=w sendtoaddress "$DEST" 0.001)"
  for i in $(seq 1 2000); do cli "$B" getmempoolentry "$txid" >/dev/null 2>&1 && break; sleep 0.01; done
  samples+=("$(( $(now_ms) - t0 ))")
  cli "$A" generatetoaddress 1 "$ADDR" >/dev/null
done
sorted=($(printf '%s\n' "${samples[@]}" | sort -n)); n=${#sorted[@]}
echo "MEASURE propagation_ms_p50 ${sorted[$((n / 2))]} ms"
echo "MEASURE propagation_ms_p99 ${sorted[$(( (n * 99 + 99) / 100 - 1 ))]} ms"
echo "MEASURE propagation_ms_max ${sorted[$((n - 1))]} ms (n=$n)"

# expiry and late re-broadcast: node A (mempoolexpiry 1h) drops an unconfirmed tx when its clock passes the expiry, and accepts it again
txid="$(cli "$A" -rpcwallet=w sendtoaddress "$DEST" 0.002)"; RAW="$(cli "$A" getrawtransaction "$txid")"
cli "$A" getmempoolentry "$txid" >/dev/null || { echo "MEASURE expiry unknown (tx not in mempool)"; exit 1; }
cli "$A" setmocktime "$(( $(date +%s) + 2 * 3600 ))" >/dev/null
cli "$A" -rpcwallet=w sendtoaddress "$DEST" 0.003 >/dev/null 2>&1 || true   # accepting another tx runs the mempool's size/expiry trimming
if cli "$A" getmempoolentry "$txid" >/dev/null 2>&1; then echo "MEASURE expiry not_observed (still in the mempool after mocktime +2h; mempoolexpiry=1h)"; else echo "MEASURE expiry observed (left the mempool after mocktime +2h)"; fi
cli "$A" setmocktime 0 >/dev/null
if cli "$A" sendrawtransaction "$RAW" >/dev/null 2>&1; then echo "MEASURE rebroadcast_ok yes (the same raw transaction was accepted again)"; else echo "MEASURE rebroadcast_ok no ($(cli "$A" testmempoolaccept "[\"$RAW\"]" | tr -d '\n ' | cut -c1-120))"; fi

# clock skew between the host and a container (the guard compares authorizedAt (writer's clock) with Date.now() of ANOTHER instance)
h="$(date +%s%3N)"; c="$(docker exec "$A" date +%s%3N 2>/dev/null || echo "$h")"; skew=$(( h > c ? h - c : c - h ))
echo "MEASURE clock_skew_ms $skew ms (host vs container; two real instances can differ by much more: set the bound from NTP policy, not from this)"
