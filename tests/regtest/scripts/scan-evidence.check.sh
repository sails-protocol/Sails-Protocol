#!/usr/bin/env bash
# P51: self-test of scan-evidence.sh. No network. Every kind of secret is PLANTED in a throw-away evidence tree and the scan must refuse it; a clean tree
# must pass; and (GK R3 blocker 3) a run directory WITHOUT its secret-values file must FAIL, never be skipped silently.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCAN="$HERE/scan-evidence.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
fail=0
ok()  { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }

VALUES=(
  "0123456789abcdef0123456789abcdef0123456789abcdef"   # RPC password (48 hex)
  "u1a2b3c4d5e6f"                                       # RPC user
  "u1a2b3c4d5e6f:00112233445566778899aabbccddeeff\$ffeeddccbbaa99887766554433221100aabbccddeeff00112233445566778899"  # rpcauth
  "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0"   # MULTISIG_SEED
)
mk() { # mk <case-name> -> creates $WORK/<case>/{evidence,secrets}; evidence/run1 with a clean log; secrets/run1.values with the values
  local c="$WORK/$1"; mkdir -p "$c/evidence/run1" "$c/secrets"
  printf 'getblockchaininfo ok\nchain regtest\n' > "$c/evidence/run1/fidelity.log"
  printf '%s\n' "${VALUES[@]}" > "$c/secrets/run1.values"
  echo "$c"
}
run_scan() { bash "$SCAN" "$1/evidence" "$1/secrets" >"$WORK/out.txt" 2>"$WORK/err.txt"; }
expect_refuse() { # expect_refuse <case-dir> <label>
  if run_scan "$1"; then bad "$2: the scan ACCEPTED it"; else ok "$2: refused ($(head -1 "$WORK/err.txt"))"; fi
}

c="$(mk clean)"
run_scan "$c" && ok "a clean evidence tree passes" || bad "a clean tree was refused: $(cat "$WORK/err.txt")"
[ ! -e "$c/secrets" ] && ok "the secrets directory is deleted after the scan" || bad "the secrets directory was not deleted"

c="$(mk lit-pass)"; echo "debug: auth=${VALUES[0]}" >> "$c/evidence/run1/electrs.log"; expect_refuse "$c" "the literal RPC password in a log"
c="$(mk lit-user)"; echo "user ${VALUES[1]} connected" >> "$c/evidence/run1/electrs.log"; expect_refuse "$c" "the literal RPC user in a log"
c="$(mk lit-rpcauth)"; echo "x ${VALUES[2]}" >> "$c/evidence/run1/bitcoind.log"; expect_refuse "$c" "the literal rpcauth string in a log"
c="$(mk lit-seed)"; echo "seed was ${VALUES[3]}" >> "$c/evidence/run1/notes.txt"; expect_refuse "$c" "the literal MULTISIG_SEED in a text file"

# the GK blocker: a run directory with NO values file must FAIL, not skip
c="$(mk no-values)"; rm "$c/secrets/run1.values"; expect_refuse "$c" "BLOCKER 3: a run directory without its secret-values file"
c="$(mk empty-values)"; : > "$c/secrets/run1.values"; expect_refuse "$c" "BLOCKER 3: an EMPTY secret-values file"
c="$(mk run2-missing)"; mkdir -p "$c/evidence/run2"; echo ok > "$c/evidence/run2/fidelity.log"; expect_refuse "$c" "BLOCKER 3: run2 present but only run1 has a values file"

# Secret-LOOKING strings are generated at run time (random base58), so no literal key-like token lives in this repository file.
b58() { head -c 400 /dev/urandom | base64 | tr -dc '1-9A-HJ-NP-Za-km-z' | head -c "$1"; }
c="$(mk xprv)"; echo "master $(printf 'xp''rv')$(b58 107)" >> "$c/evidence/run1/x.log"; expect_refuse "$c" "an xprv"
c="$(mk tprv)"; echo "master $(printf 'tp''rv')$(b58 107)" >> "$c/evidence/run1/x.log"; expect_refuse "$c" "a tprv"
c="$(mk wif)"; echo "key 5$(b58 50) end" >> "$c/evidence/run1/x.log"; expect_refuse "$c" "a mainnet WIF private key"
c="$(mk wif-regtest)"; echo "key c$(b58 51) end" >> "$c/evidence/run1/x.log"; expect_refuse "$c" "a testnet/regtest WIF private key"
c="$(mk pem)"; printf -- '-----BEGIN PRIVATE KEY-----\nAAAA\n' >> "$c/evidence/run1/x.log"; expect_refuse "$c" "a PEM private key block"
c="$(mk rpcpw)"; echo "rpcpassword=hunter2hunter2" >> "$c/evidence/run1/x.log"; expect_refuse "$c" "an rpcpassword setting"
c="$(mk cookie)"; echo "__cookie__:abcdef0123456789" >> "$c/evidence/run1/x.log"; expect_refuse "$c" "an RPC cookie line"
c="$(mk walletdat)"; echo x > "$c/evidence/run1/wallet.dat"; expect_refuse "$c" "a wallet.dat file"
c="$(mk dotcookie)"; echo x > "$c/evidence/run1/.cookie"; expect_refuse "$c" "a .cookie file"
c="$(mk binary)"; echo x > "$c/evidence/run1/bitcoind.tar.gz"; expect_refuse "$c" "an archive"
c="$(mk valuesinevidence)"; cp "$c/secrets/run1.values" "$c/evidence/run1/leak.values"; expect_refuse "$c" "a .values file inside the evidence"
c="$(mk seedlabel)"; echo '{"seed": "correct horse battery staple"}' >> "$c/evidence/run1/x.json"; expect_refuse "$c" "a JSON seed label"
c="$(mk seedassign)"; echo "MULTISIG_SEED=aabbccddeeff00112233" >> "$c/evidence/run1/x.log"; expect_refuse "$c" "a MULTISIG_SEED assignment"

# GK: the scan must FAIL when there is NO values file at all (a job that died before any run has nothing to search for: that is a failure, not a pass)
c="$WORK/norun"; mkdir -p "$c/evidence" "$c/secrets"; echo "verify-pins ok" > "$c/evidence/00-verify-pins.txt"
expect_refuse "$c" "GK: no secret-values file at all (no run directory either)"
c="$WORK/nosecretsdir"; mkdir -p "$c/evidence/run1"; echo ok > "$c/evidence/run1/fidelity.log"
if bash "$SCAN" "$c/evidence" "$c/does-not-exist" >"$WORK/out.txt" 2>"$WORK/err.txt"; then bad "a MISSING secrets directory was accepted"; else ok "a missing secrets directory is refused ($(head -1 "$WORK/err.txt"))"; fi
# ALL values files are read, also one that does not correspond to a run directory
c="$(mk extra-values)"; printf '%s\n' "ffeeddccbbaa99887766554433221100" > "$c/secrets/extra.values"; echo "leak ffeeddccbbaa99887766554433221100" >> "$c/evidence/run1/x.log"
expect_refuse "$c" "GK: a value from a values file that has no run directory is still searched"
# ... and not only the FIRST one: the leak belongs to the LAST values file (z.values sorts after run1.values), so reading only the first would miss it
c="$(mk last-values)"; printf '%s\n' "00ffeeddccbbaa998877665544332211" > "$c/secrets/z.values"; echo "leak 00ffeeddccbbaa998877665544332211" >> "$c/evidence/run1/x.log"
expect_refuse "$c" "GK: a value from the LAST values file is searched too (all files are read)"
c="$(mk two-runs)"; mkdir -p "$c/evidence/run2"; echo ok > "$c/evidence/run2/fidelity.log"; printf '%s\n' "run2-only-secret-value-0123456789" > "$c/secrets/run2.values"; echo "leak run2-only-secret-value-0123456789" >> "$c/evidence/run2/fidelity.log"
expect_refuse "$c" "GK: a secret that belongs to run2 is found in run2's evidence"
# the LAST line of a values file is searched even without a trailing newline
c="$(mk no-trailing-newline)"; printf '%s' "no-trailing-newline-secret-9876543210" > "$c/secrets/run1.values"; echo "leak no-trailing-newline-secret-9876543210" >> "$c/evidence/run1/x.log"
expect_refuse "$c" "the last line of a values file without a trailing newline is still searched"
# an EMPTY values file is refused even when it belongs to no run directory (the per-run check cannot catch this one)
c="$(mk empty-extra)"; : > "$c/secrets/extra.values"; expect_refuse "$c" "an empty values file with no run directory is refused"

[ "$fail" -eq 0 ] && echo "scan-evidence.check: ALL PASS" || echo "scan-evidence.check: FAILED"
exit "$fail"
