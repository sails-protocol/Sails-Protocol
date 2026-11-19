#!/usr/bin/env bash
# P51: refuse to run with an unpinned or malformed pin. Fails CLOSED.
# Every value below is pinned IN THE WORKFLOW (env:). A value that still starts with PIN_REQUIRED means the GK / Aux 01
# have not supplied and checked it yet: the job must stop here, before downloading or building anything.
set -euo pipefail

fail=0
bad() { echo "PIN ERROR: $1" >&2; fail=1; }

req() { # req NAME REGEX DESCRIPTION
  local name="$1" re="$2" what="$3" val="${!1-}"
  if [ -z "$val" ]; then bad "$name is empty ($what)"; return; fi
  case "$val" in PIN_REQUIRED*) bad "$name is still a placeholder: $val ($what)"; return;; esac
  if ! printf '%s' "$val" | grep -Eq "$re"; then bad "$name has an invalid format ($what): $val"; fi
}

req EXPECTED_SHA                   '^[0-9a-f]{40}$'                 'full commit SHA of the code under proof'
req EXPECTED_INFRA_TREE            '^[0-9a-f]{40}$'                 'git tree hash of tests/regtest at the reviewed infra commit'
req BITCOIN_CORE_VERSION           '^[0-9]+\.[0-9]+(\.[0-9]+)?$'    'exact Bitcoin Core version, e.g. 29.0'
req BITCOIN_CORE_TARBALL_SHA256    '^[0-9a-f]{64}$'                 'sha256 of the official x86_64-linux-gnu tarball'
req GPG_MIN_VALID_SIGNATURES       '^([3-9]|1[0-3])$'               'minimum valid builder signatures (GK decision: >= 3)'
req GUIX_SIGS_REPO_URL             '^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(\.git)?$' 'guix.sigs repository'
req GUIX_SIGS_COMMIT               '^[0-9a-f]{40}$'                 'full guix.sigs commit SHA (builder keys are read at this commit)'
req ELECTRS_REPO_URL               '^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(\.git)?$' 'electrs (Esplora fork) repository'
req ELECTRS_COMMIT                 '^[0-9a-f]{40}$'                 'full electrs commit SHA'
req ELECTRS_CARGO_LOCK_SHA256      '^[0-9a-f]{64}$'                 'sha256 of electrs Cargo.lock at that commit'
req RUST_TOOLCHAIN                 '^[0-9]+\.[0-9]+\.[0-9]+$'       'exact Rust toolchain version'
req FIXED_FEE_SAT_PER_VB           '^[0-9]{1,3}$'                   'declared fixed fee rate (sat/vB)'

# Builder fingerprints: a space-separated list of full 40-hex PRIMARY key fingerprints, at least GPG_MIN_VALID_SIGNATURES of them.
if [ -z "${BITCOIN_CORE_BUILDER_FINGERPRINTS-}" ]; then
  bad "BITCOIN_CORE_BUILDER_FINGERPRINTS is empty"
else
  case "$BITCOIN_CORE_BUILDER_FINGERPRINTS" in PIN_REQUIRED*) bad "BITCOIN_CORE_BUILDER_FINGERPRINTS is still a placeholder";; esac
  n=0
  for fp in $BITCOIN_CORE_BUILDER_FINGERPRINTS; do
    printf '%s' "$fp" | grep -Eq '^[0-9A-F]{40}$' || bad "builder fingerprint is not 40 uppercase hex: $fp"
    n=$((n + 1))
  done
  uniq_n="$(printf '%s\n' $BITCOIN_CORE_BUILDER_FINGERPRINTS | sort -u | wc -l | tr -d ' ')"
  [ "$uniq_n" = "$n" ] || bad "duplicate builder fingerprints"
  min="${GPG_MIN_VALID_SIGNATURES:-3}"
  case "$min" in PIN_REQUIRED*) min=3;; esac
  [ "$n" -ge "$min" ] 2>/dev/null || bad "only $n builder fingerprint(s) pinned, need at least $min"
fi

# Vendored builder keys: one "name sha256" line per pinned fingerprint (same count), names unique, hashes 64-hex.
if [ -z "${BUILDER_KEY_SHA256S-}" ]; then
  bad "BUILDER_KEY_SHA256S is empty"
else
  case "$BUILDER_KEY_SHA256S" in PIN_REQUIRED*) bad "BUILDER_KEY_SHA256S is still a placeholder";; esac
  nk=0; names=""
  while read -r kname ksha extra; do
    [ -n "${kname:-}" ] || continue
    nk=$((nk + 1))
    printf '%s' "$kname" | grep -Eq '^[A-Za-z0-9_-]+$' || bad "builder key name has an invalid format: $kname"
    printf '%s' "${ksha:-}" | grep -Eq '^[0-9a-f]{64}$' || bad "builder key $kname: sha256 must be 64 lowercase hex"
    [ -z "${extra:-}" ] || bad "builder key line for $kname has extra fields"
    names="$names $kname"
  done <<< "$BUILDER_KEY_SHA256S"
  [ "$(printf '%s\n' $names | sort -u | wc -l | tr -d ' ')" = "$nk" ] || bad "duplicate builder key names"
  [ -n "${BITCOIN_CORE_BUILDER_FINGERPRINTS-}" ] && [ "$nk" = "$(printf '%s\n' $BITCOIN_CORE_BUILDER_FINGERPRINTS | wc -l | tr -d ' ')" ] || bad "BUILDER_KEY_SHA256S has $nk entries but the pinned fingerprints are a different number"
fi

# The declared fee must fit the provider's own ceiling (default MULTISIG_MAX_FEE_RATE_SATS_PER_VBYTE = 200).
if [ -n "${FIXED_FEE_SAT_PER_VB-}" ] && printf '%s' "$FIXED_FEE_SAT_PER_VB" | grep -Eq '^[0-9]+$'; then
  [ "$FIXED_FEE_SAT_PER_VB" -ge 1 ] && [ "$FIXED_FEE_SAT_PER_VB" -le 200 ] || bad "FIXED_FEE_SAT_PER_VB must be 1..200 (provider ceiling)"
fi

# The explorer must be loopback (never a public explorer: lesson D9 / #698).
case "${MULTISIG_EXPLORER_API_URL-}" in
  http://127.0.0.1:*) ;;
  *) bad "MULTISIG_EXPLORER_API_URL must start with http://127.0.0.1: (got '${MULTISIG_EXPLORER_API_URL-}')";;
esac
# And no public explorer may appear anywhere in the job environment.
if env | grep -Ei 'mempool\.space|blockstream\.info' >/dev/null 2>&1; then bad "a public explorer URL is present in the environment"; fi

if [ "$fail" -ne 0 ]; then
  echo "verify-pins: REFUSING TO RUN (fail closed). Nothing was downloaded or built." >&2
  exit 1
fi
echo "verify-pins: all pins present and well-formed."
