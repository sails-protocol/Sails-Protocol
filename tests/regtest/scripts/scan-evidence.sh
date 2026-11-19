#!/usr/bin/env bash
# P51 / GK checklist section 3: scan the evidence directory BEFORE it is uploaded. FAILS the job if it finds anything that looks like a private
# key, a seed, an RPC cookie, an RPC password, a file type that must never be uploaded, or the LITERAL value of an ephemeral secret of this job.
#
# Usage: scan-evidence.sh <evidence-dir> <secrets-dir>
#   <secrets-dir> holds one file per run (run1.values, run2.values), written by run-once.sh OUTSIDE the evidence, one secret VALUE per line.
#   ALL the values files are read. The scan FAILS if there is NONE at all, and for every run directory in the evidence (run1, run2, ...) its own
#   values file MUST exist and be non-empty: a missing file is a FAILURE, never a silent skip (GK R3 blocker 3 and the GK's later review). The
#   values directory is deleted when the scan ends, whatever the verdict. Values are never printed.
#   Consequence: a job that stops BEFORE any run (for example verify-pins) has no values, so its scan fails and nothing is uploaded; the job log and
#   the step summary still carry the diagnosis.
set -euo pipefail
DIR="${1:?usage: scan-evidence.sh <evidence-dir> <secrets-dir>}"
SECRETS="${2:?usage: scan-evidence.sh <evidence-dir> <secrets-dir>}"
[ -d "$DIR" ] || { echo "SCAN: $DIR is not a directory" >&2; exit 2; }
fail=0
bad() { echo "SCAN FAILED: $1" >&2; fail=1; }
cleanup() { rm -rf "$SECRETS"; }
trap cleanup EXIT

# (1) allowlist: only plain text evidence. No wallets, cookies, keys, databases, binaries.
while IFS= read -r -d '' f; do
  base="$(basename "$f")"
  case "$base" in
    wallet.dat|*.wallet|.cookie|*.cookie|*.key|*.pem|*.p12|*.pfx|*.der|*.db|*.sqlite|*.ldb|*.sst|*.dat|*.pid|*.sock|*.tar|*.gz|*.zip|*.values)
      bad "forbidden file type: $f";;
  esac
  case "$base" in
    *.txt|*.log|*.json|*.md) ;;
    *) bad "file outside the allowlist (.txt .log .json .md): $f";;
  esac
done < <(find "$DIR" -type f -print0)

# (2a) the LITERAL ephemeral secrets. GK rules: read ALL the values files; FAIL if there is none at all; a run directory without its own
# values file is also a failure. Nothing is ever skipped silently.
shopt -s nullglob
values_files=("$SECRETS"/*.values)
if [ "${#values_files[@]}" -eq 0 ]; then bad "no secret-values file in $SECRETS: the literal-secret scan has nothing to search for, which is a FAILURE (it is never skipped)"; fi
runs=0
for rd in "$DIR"/run*; do
  [ -d "$rd" ] || continue
  runs=$((runs + 1))
  n="${rd##*/run}"
  if [ ! -s "$SECRETS/run$n.values" ]; then bad "run$n has an evidence directory but no secret-values file ($SECRETS/run$n.values)"; fi
done
searched=0
for vf in "${values_files[@]}"; do
  [ -s "$vf" ] || { bad "empty secret-values file: $vf"; continue; }
  searched=$((searched + 1))
  idx=0
  while IFS= read -r val || [ -n "$val" ]; do
    idx=$((idx + 1))
    [ "${#val}" -ge 8 ] || continue
    if grep -rqF -- "$val" "$DIR"; then bad "the literal value #$idx of $(basename "$vf") (an ephemeral secret) appears in the evidence"; fi
  done < "$vf"
done

# (2b) generic patterns
scan() { # scan LABEL REGEX
  if grep -rEq -- "$2" "$DIR"; then bad "pattern found: $1"; fi
}
scan 'extended private key (xprv/tprv)'         '(^|[^A-Za-z0-9])[xt]prv[1-9A-HJ-NP-Za-km-z]{50,}'
scan 'PEM private key block'                    'BEGIN [A-Z ]*PRIVATE KEY'
scan 'WIF private key (mainnet 5/K/L)'          '(^|[^A-Za-z0-9])[5KL][1-9A-HJ-NP-Za-km-z]{50,51}([^A-Za-z0-9]|$)'
scan 'WIF private key (testnet/regtest 9/c)'    '(^|[^A-Za-z0-9])[9c][1-9A-HJ-NP-Za-km-z]{50,51}([^A-Za-z0-9]|$)'
scan 'rpcpassword / rpcauth setting'            '(rpcpassword|rpcauth)[[:space:]]*='
scan 'RPC cookie line (__cookie__:)'            '__cookie__:'
scan 'MULTISIG_SEED assignment with a value'    'MULTISIG_SEED[[:space:]]*[=:][[:space:]]*[A-Za-z0-9]{16,}'
scan 'seed / mnemonic / secret-key label'       '"(seed|mnemonic|secretKey|privateKey|privkey|wif)"[[:space:]]*:[[:space:]]*"[^"]+"'
scan 'bitcoin-cli dumpprivkey / walletpassphrase usage' '(dumpprivkey|walletpassphrase|dumpwallet)'

if [ "$fail" -ne 0 ]; then
  echo "scan-evidence: REFUSING TO UPLOAD. Fix the evidence; do not upload this directory." >&2
  exit 1
fi
echo "scan-evidence: clean ($(find "$DIR" -type f | wc -l | tr -d ' ') files checked; the literal values of $searched secrets file(s) were searched for; $runs run director$([ "$runs" -eq 1 ] && echo y || echo ies))."
