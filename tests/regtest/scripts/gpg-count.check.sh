#!/usr/bin/env bash
# P51: self-test of gpg-count.sh with REAL gpg output. No network, no secrets: throw-away keys in a temporary GNUPGHOME, deleted on exit.
# It builds the situations that matter for the provenance step and asserts on the REAL `--status-fd` lines gpg produces:
#   A  signs with a SUBKEY (the signing key differs from the primary)          -> must COUNT, by the primary
#   B  signs with its PRIMARY key, twice                                        -> must count ONCE
#   C  signs with a SUBKEY that has EXPIRED by verification time               -> must NOT count (EXPKEYSIG)
#   E  signs with a SUBKEY that was REVOKED afterwards                          -> must NOT count (REVKEYSIG)
#   D  signs but its public key is not in the verification keyring              -> not seen (ERRSIG), gpg exit code != 0
#   F  pinned but never signed                                                  -> must not count
# And a SENSITIVITY control: the OLD method (compare the revoked/expired key id with the end of the PRIMARY fingerprint) is replayed on the
# same status output and must wrongly COUNT the revoked subkey signature, which proves this test can see that defect.
# Exit 0 = every assertion held. A scenario that gpg did not reproduce is a FAILURE, never a silent skip.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gpg-count.sh
source "$HERE/gpg-count.sh"
command -v gpg >/dev/null 2>&1 || { echo "FAIL: gpg is not available"; exit 2; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
GEN="$WORK/gen"; VER="$WORK/ver"; mkdir -p "$GEN" "$VER"; chmod 700 "$GEN" "$VER" 2>/dev/null || true
echo "gpg: $(gpg --version | head -1)"
G=(gpg --batch --yes --no-tty --homedir "$GEN" --pinentry-mode loopback --passphrase '')
V=(gpg --batch --yes --no-tty --homedir "$VER")
fail=0
ok()  { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
primary_of() { "${G[@]}" --with-colons --list-keys "$1@example.invalid" | awk -F: '$1 == "fpr" {print $10; exit}'; }
signing_subkey_of() { "${G[@]}" --with-colons --list-keys "$1@example.invalid" | awk -F: '$1 == "sub" {s = 1; next} $1 == "fpr" && s {print $10; exit}'; }

MSG="$WORK/SHA256SUMS"; echo "0000000000000000000000000000000000000000000000000000000000000000  bitcoin-test.tar.gz" > "$MSG"
sig() { # sig <fingerprint-to-sign-with> <faked-time-or-empty> -> armored detached signature on stdout
  local key="$1" ft="${2:-}"
  if [ -n "$ft" ]; then "${G[@]}" --faked-system-time "$ft" --armor --detach-sign -u "${key}!" -o - "$MSG"
  else "${G[@]}" --armor --detach-sign -u "${key}!" -o - "$MSG"; fi
}

# ---- key material ----
"${G[@]}" --quick-generate-key "A <A@example.invalid>" ed25519 cert never >/dev/null 2>&1
A_PRI="$(primary_of A)"; "${G[@]}" --quick-add-key "$A_PRI" ed25519 sign never >/dev/null 2>&1; A_SUB="$(signing_subkey_of A)"

"${G[@]}" --quick-generate-key "B <B@example.invalid>" ed25519 cert,sign never >/dev/null 2>&1
B_PRI="$(primary_of B)"

# C: created and used in 2020; its signing subkey lasts one day, so it is EXPIRED when we verify now
"${G[@]}" --faked-system-time 20200101T000000 --quick-generate-key "C <C@example.invalid>" ed25519 cert never >/dev/null 2>&1
C_PRI="$(primary_of C)"
"${G[@]}" --faked-system-time 20200101T000000 --quick-add-key "$C_PRI" ed25519 sign 1d >/dev/null 2>&1; C_SUB="$(signing_subkey_of C)"

"${G[@]}" --quick-generate-key "E <E@example.invalid>" ed25519 cert never >/dev/null 2>&1
E_PRI="$(primary_of E)"; "${G[@]}" --quick-add-key "$E_PRI" ed25519 sign never >/dev/null 2>&1; E_SUB="$(signing_subkey_of E)"

"${G[@]}" --quick-generate-key "D <D@example.invalid>" ed25519 cert,sign never >/dev/null 2>&1
D_PRI="$(primary_of D)"
"${G[@]}" --quick-generate-key "F <F@example.invalid>" ed25519 cert,sign never >/dev/null 2>&1
F_PRI="$(primary_of F)"
"${G[@]}" --quick-generate-key "G <G@example.invalid>" ed25519 cert never >/dev/null 2>&1
G_PRI="$(primary_of G)"; "${G[@]}" --quick-add-key "$G_PRI" ed25519 sign never >/dev/null 2>&1; G_SUB="$(signing_subkey_of G)"

# ---- signatures (E is signed BEFORE its subkey is revoked) ----
{
  sig "$A_SUB"
  sig "$B_PRI"; sig "$B_PRI"
  sig "$C_SUB" 20200101T120000
  sig "$E_SUB"
  sig "$D_PRI"
} > "$WORK/SHA256SUMS.asc"
# revoke E's signing subkey now (reason 0 = no reason)
printf 'key 1\nrevkey\ny\n0\n\ny\nsave\n' | "${G[@]}" --command-fd 0 --status-fd 2 --edit-key "$E_PRI" >/dev/null 2>&1 || true

# ---- the verification keyring: A B C E F G, but NOT D ----
for k in A B C E F G; do "${G[@]}" --armor --export "$k@example.invalid" | "${V[@]}" --import >/dev/null 2>&1; done
GPG_RC=0
"${V[@]}" --status-fd 1 --verify "$WORK/SHA256SUMS.asc" "$MSG" > "$WORK/status.txt" 2> "$WORK/stderr.txt" || GPG_RC=$?

# ---- the scenario must really have happened (REAL gpg output) ----
grep -q "^\[GNUPG:\] VALIDSIG $A_SUB .* $A_PRI\$" "$WORK/status.txt" && [ "$A_SUB" != "$A_PRI" ] \
  && ok "A: gpg reports VALIDSIG with signing subkey != primary (last field = primary)" || bad "A: expected a VALIDSIG whose signing key differs from the primary"
[ "$(grep -c "^\[GNUPG:\] VALIDSIG $B_PRI " "$WORK/status.txt")" = "2" ] && ok "B: two VALIDSIG lines by the same primary" || bad "B: expected two VALIDSIG lines"
grep -q "^\[GNUPG:\] EXPKEYSIG " "$WORK/status.txt" && ok "C: gpg reported EXPKEYSIG for the expired subkey" || bad "C: EXPKEYSIG not produced (scenario not reproduced)"
grep -q "^\[GNUPG:\] REVKEYSIG " "$WORK/status.txt" && ok "E: gpg reported REVKEYSIG for the revoked subkey" || bad "E: REVKEYSIG not produced (scenario not reproduced)"
grep -q "^\[GNUPG:\] \(ERRSIG\|NO_PUBKEY\)" "$WORK/status.txt" && ok "D: unknown signer produced ERRSIG/NO_PUBKEY" || bad "D: expected ERRSIG/NO_PUBKEY"
[ "$GPG_RC" -ne 0 ] && ok "gpg exit code is $GPG_RC (non-zero because of the unknown signer): the exit code must not be used" || bad "gpg exit code was 0; the scenario did not include an unknown signer"

# ---- the code under test ----
PINNED="$A_PRI $B_PRI $C_PRI $E_PRI $F_PRI $G_PRI"
OUT="$(count_valid_builders "$WORK/status.txt" "$PINNED")"
echo "$OUT" | sed 's/^/    /'
n="$(echo "$OUT" | sed -n 's/^VALID_BUILDERS=//p')"
echo "$OUT" | grep -qx "COUNTED $A_PRI" && ok "A (subkey signer) is counted by its primary fingerprint" || bad "A should be counted"
echo "$OUT" | grep -qx "COUNTED $B_PRI" && ok "B counted" || bad "B should be counted"
[ "$(echo "$OUT" | grep -c "COUNTED $B_PRI\$" | tr -d ' ')" = "1" ] && ok "B counted exactly once despite two signatures" || bad "B must be counted once"
echo "$OUT" | grep -qx "NOT COUNTED (revoked/expired) $C_PRI" && ok "C (EXPIRED subkey) is NOT counted" || bad "C must not be counted"
echo "$OUT" | grep -qx "NOT COUNTED (revoked/expired) $E_PRI" && ok "E (REVOKED subkey) is NOT counted" || bad "E must not be counted"
echo "$OUT" | grep -q "$F_PRI" && bad "F never signed and must not appear" || ok "F (pinned, never signed) does not count"
[ "$n" = "2" ] && ok "VALID_BUILDERS=2 (A and B)" || bad "expected VALID_BUILDERS=2, got $n"
[ "$n" -ge 3 ] && bad "threshold 3 must REFUSE 2 valid signatures" || ok "threshold 3 refuses 2 valid signatures"

# a third good builder reaches the threshold
G_SIG="$(sig "$G_SUB")"
printf '%s\n' "$(cat "$WORK/SHA256SUMS.asc")" "$G_SIG" > "$WORK/SHA256SUMS2.asc"
"${V[@]}" --status-fd 1 --verify "$WORK/SHA256SUMS2.asc" "$MSG" > "$WORK/status2.txt" 2>/dev/null || true
n2="$(count_valid_builders "$WORK/status2.txt" "$PINNED" | sed -n 's/^VALID_BUILDERS=//p')"
[ "$n2" = "3" ] && ok "with a third good builder VALID_BUILDERS=3 (meets the threshold)" || bad "expected 3, got $n2"

# a signer that is valid but NOT pinned is ignored
n3="$(count_valid_builders "$WORK/status2.txt" "$A_PRI $B_PRI" | sed -n 's/^VALID_BUILDERS=//p')"
[ "$n3" = "2" ] && ok "a valid signer outside the pinned list is ignored" || bad "expected 2 with G unpinned, got $n3"

# ---- SENSITIVITY control: the OLD method (revoked/expired id vs the END OF THE PRIMARY) wrongly counts the revoked subkey ----
old_count() {
  local status="$1" pinned="$2" n=0 fp short
  local bad_keys; bad_keys="$(awk '$1 == "[GNUPG:]" && ($2 == "REVKEYSIG" || $2 == "EXPKEYSIG" || $2 == "EXPSIG") {print $3}' "$status" | sort -u)"
  local signers; signers="$(awk '$1 == "[GNUPG:]" && $2 == "VALIDSIG" {print $NF}' "$status" | sort -u)"
  for fp in $pinned; do
    if printf '%s\n' "$signers" | grep -qx "$fp"; then
      short="${fp: -16}"
      if printf '%s\n' "$bad_keys" | grep -qi "$short"; then :; else echo "OLD counted $fp"; n=$((n + 1)); fi
    fi
  done
  echo "OLD_VALID=$n"
}
OLD="$(old_count "$WORK/status.txt" "$PINNED")"
echo "$OLD" | grep -q "OLD counted $E_PRI" && ok "sensitivity: the OLD method WRONGLY counts the revoked subkey signature (E), so this test can see that defect" \
  || bad "sensitivity: the old method should have counted E; the scenario is not discriminating"
echo "$OLD" | grep -q "OLD counted $C_PRI" && ok "sensitivity: the OLD method also WRONGLY counts the expired subkey signature (C)" || bad "sensitivity: old method should have counted C"

[ "$fail" -eq 0 ] && echo "gpg-count.check: ALL PASS" || echo "gpg-count.check: FAILED"
exit "$fail"
