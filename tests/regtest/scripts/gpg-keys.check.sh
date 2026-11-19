#!/usr/bin/env bash
# P51: self-test of the VENDORED builder keys against the pins, with the real gpg. No network. Runs early in the job (before any download).
# Positive: the 13 vendored files import and give exactly the 13 pinned primary fingerprints.
# Negative (the verifier is verified): a tampered key, a missing key, an extra key, a swapped pair and a wrong pinned fingerprint are ALL refused.
#
# Env: BUILDER_KEY_SHA256S (lines "name sha256")  BITCOIN_CORE_BUILDER_FINGERPRINTS (space-separated)  [KEYS_DIR]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gpg-keys.sh
source "$HERE/gpg-keys.sh"
: "${BUILDER_KEY_SHA256S:?}" "${BITCOIN_CORE_BUILDER_FINGERPRINTS:?}"
KEYS_DIR="${KEYS_DIR:-$HERE/../keys/bitcoin-core-builders}"
command -v gpg >/dev/null 2>&1 || { echo "FAIL: gpg is not available"; exit 2; }

fail=0
ok()  { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

fresh_home() { local h; h="$(mktemp -d "$WORK/gnupg.XXXXXX")"; chmod 700 "$h" 2>/dev/null || true; echo "$h"; }
try() { # try <keys-dir> <pins> <fingerprints> -> 0 if accepted
  ( export GNUPGHOME; GNUPGHOME="$(fresh_home)"; import_pinned_builder_keys "$1" "$2" "$3" ) >"$WORK/last.out" 2>"$WORK/last.err"
}

if try "$KEYS_DIR" "$BUILDER_KEY_SHA256S" "$BITCOIN_CORE_BUILDER_FINGERPRINTS"; then ok "$(cat "$WORK/last.out")"; else bad "the vendored keys do not match the pins: $(cat "$WORK/last.err")"; fi

copy() { rm -rf "$WORK/k"; cp -r "$KEYS_DIR" "$WORK/k"; }
first="$(printf '%s\n' "$BUILDER_KEY_SHA256S" | awk 'NF {print $1; exit}')"
second="$(printf '%s\n' "$BUILDER_KEY_SHA256S" | awk 'NF {n++; if (n == 2) {print $1; exit}}')"

copy; printf ' ' >> "$WORK/k/$first.asc"
try "$WORK/k" "$BUILDER_KEY_SHA256S" "$BITCOIN_CORE_BUILDER_FINGERPRINTS" && bad "a TAMPERED key file was accepted" || ok "a tampered key file (1 byte appended) is refused: $(head -1 "$WORK/last.err")"

copy; rm "$WORK/k/$first.asc"
try "$WORK/k" "$BUILDER_KEY_SHA256S" "$BITCOIN_CORE_BUILDER_FINGERPRINTS" && bad "a MISSING key file was accepted" || ok "a missing key file is refused: $(head -1 "$WORK/last.err")"

copy; cp "$WORK/k/$first.asc" "$WORK/k/extra.asc"
try "$WORK/k" "$BUILDER_KEY_SHA256S" "$BITCOIN_CORE_BUILDER_FINGERPRINTS" && bad "an EXTRA key file was accepted" || ok "an extra key file is refused: $(head -1 "$WORK/last.err")"

copy; mv "$WORK/k/$first.asc" "$WORK/k/tmp.asc"; mv "$WORK/k/$second.asc" "$WORK/k/$first.asc"; mv "$WORK/k/tmp.asc" "$WORK/k/$second.asc"
try "$WORK/k" "$BUILDER_KEY_SHA256S" "$BITCOIN_CORE_BUILDER_FINGERPRINTS" && bad "two SWAPPED key files were accepted" || ok "two swapped key files are refused: $(head -1 "$WORK/last.err")"

# a pinned fingerprint that is not the real one: the file's primary is no longer in the list
wrong="$(printf '%s\n' $BITCOIN_CORE_BUILDER_FINGERPRINTS | sed '1s/.*/0000000000000000000000000000000000000000/' | tr '\n' ' ')"
try "$KEYS_DIR" "$BUILDER_KEY_SHA256S" "$wrong" && bad "a WRONG pinned fingerprint was accepted" || ok "a wrong pinned fingerprint is refused: $(head -1 "$WORK/last.err")"

# a pinned fingerprint list with one entry MISSING: the keyring would hold one key too many
short="$(printf '%s\n' $BITCOIN_CORE_BUILDER_FINGERPRINTS | sed '1d' | tr '\n' ' ')"
try "$KEYS_DIR" "$BUILDER_KEY_SHA256S" "$short" && bad "a fingerprint list MISSING one builder was accepted" || ok "a fingerprint list missing one builder is refused: $(head -1 "$WORK/last.err")"

[ "$fail" -eq 0 ] && echo "gpg-keys.check: ALL PASS" || echo "gpg-keys.check: FAILED"
exit "$fail"
