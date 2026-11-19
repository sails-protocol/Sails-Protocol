#!/usr/bin/env bash
# P51 / GK checklist section 1, decisions V2.1 and R3 review: provenance of bitcoind. There is NO official Docker image of Bitcoin Core, so the
# OFFICIAL release tarball is downloaded on the runner and verified here, each step fatal:
#   (a) sha256 of the tarball == the line in the official SHA256SUMS;
#   (c) sha256 of the tarball == the hash PINNED in the workflow (independent of the download of the day);
#   (b) >= GPG_MIN_VALID_SIGNATURES valid signatures on SHA256SUMS.asc by DISTINCT pinned PRIMARY fingerprints;
#   (e) the installed binary reports exactly the pinned version; its sha256 is recorded as evidence.
# (a)+(c) and (b) are ALL mandatory.
#
# KEYS: VENDORED in the repository (tests/regtest/keys/bitcoin-core-builders/<builder>.asc), byte-for-byte the files builder-keys/<builder>.gpg of
# bitcoin-core/guix.sigs at the pinned commit GUIX_SIGS_COMMIT. Nothing is fetched from a keyserver or from guix.sigs during the job. The sha256 of
# EVERY key file is pinned in the workflow (BUILDER_KEY_SHA256S); each file's PRIMARY fingerprint must be one of the pinned fingerprints; the
# directory must hold exactly the pinned files; and the keyring built from them is ASSERTED to hold exactly the pinned fingerprints.
#
# Counting the signatures is done by gpg-count.sh (also exercised by gpg-count.check.sh with real gpg output): exit code of gpg ignored; VALIDSIG
# paired (signing key = $3, primary = last field); revoked/expired signing keys not counted; distinct primaries.
#
# Env: BITCOIN_CORE_VERSION BITCOIN_CORE_TARBALL_SHA256 BITCOIN_CORE_BUILDER_FINGERPRINTS GPG_MIN_VALID_SIGNATURES BUILDER_KEY_SHA256S
#      GUIX_SIGS_COMMIT KEYS_DIR INSTALL_DIR EVIDENCE_DIR
set -euo pipefail
: "${BITCOIN_CORE_VERSION:?}" "${BITCOIN_CORE_TARBALL_SHA256:?}" "${BITCOIN_CORE_BUILDER_FINGERPRINTS:?}" "${GPG_MIN_VALID_SIGNATURES:?}"
: "${BUILDER_KEY_SHA256S:?}" "${GUIX_SIGS_COMMIT:?}" "${KEYS_DIR:?}" "${INSTALL_DIR:?}" "${EVIDENCE_DIR:?}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gpg-count.sh
source "$HERE/gpg-count.sh"
# shellcheck source=gpg-keys.sh
source "$HERE/gpg-keys.sh"
die() { echo "PROVENANCE FAILED: $*" >&2; exit 1; }

BASE="https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_CORE_VERSION}"
TARBALL="bitcoin-${BITCOIN_CORE_VERSION}-x86_64-linux-gnu.tar.gz"
WORK="$(mktemp -d)"
mkdir -p "$EVIDENCE_DIR" "$INSTALL_DIR"

fetch() { curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 600 --retry 0 -o "$2" "$1"; }
# The job FAILS here if a name does not exist at the pinned version (no silent fallback to another file).
fetch "$BASE/$TARBALL"        "$WORK/$TARBALL"
fetch "$BASE/SHA256SUMS"      "$WORK/SHA256SUMS"
fetch "$BASE/SHA256SUMS.asc"  "$WORK/SHA256SUMS.asc"

# (a) tarball vs the official SHA256SUMS
actual="$(sha256sum "$WORK/$TARBALL" | awk '{print $1}')"
listed="$(awk -v f="$TARBALL" '$2 == f {print $1}' "$WORK/SHA256SUMS")"
[ -n "$listed" ] || die "$TARBALL is not listed in SHA256SUMS"
[ "$actual" = "$listed" ] || die "(a) tarball sha256 $actual != SHA256SUMS $listed"
echo "(a) tarball sha256 matches the official SHA256SUMS"

# (c) the hash pinned in the workflow
[ "$actual" = "$BITCOIN_CORE_TARBALL_SHA256" ] || die "(c) tarball sha256 $actual != pinned $BITCOIN_CORE_TARBALL_SHA256"
echo "(c) tarball sha256 matches the hash pinned in the workflow"

# (b) vendored keys: exactly the pinned files, each byte-identical to its pinned sha256, keyring exactly the pinned fingerprints
export GNUPGHOME; GNUPGHOME="$(mktemp -d)"; chmod 700 "$GNUPGHOME"
import_pinned_builder_keys "$KEYS_DIR" "$BUILDER_KEY_SHA256S" "$BITCOIN_CORE_BUILDER_FINGERPRINTS" || die "(b) the vendored builder keys do not match the pins"
echo "(b) vendored builder keys verified (taken from guix.sigs@$GUIX_SIGS_COMMIT)"

# (b) verify. The EXIT CODE is ignored on purpose (it is non-zero when an unknown key also signed).
gpg --batch --status-fd 1 --verify "$WORK/SHA256SUMS.asc" "$WORK/SHA256SUMS" >"$WORK/gpg-status.txt" 2>"$WORK/gpg-stderr.txt" || true
count_out="$(count_valid_builders "$WORK/gpg-status.txt" "$BITCOIN_CORE_BUILDER_FINGERPRINTS")"
printf '%s\n' "$count_out" | sed 's/^/  /'
valid="$(printf '%s\n' "$count_out" | sed -n 's/^VALID_BUILDERS=//p')"
[ -n "$valid" ] || die "(b) the signature counter produced no result"
[ "$valid" -ge "$GPG_MIN_VALID_SIGNATURES" ] || die "(b) only $valid valid signature(s) by distinct pinned builders, need >= $GPG_MIN_VALID_SIGNATURES"
echo "(b) $valid valid signatures by distinct pinned builder fingerprints (threshold $GPG_MIN_VALID_SIGNATURES)"

# install + (e) version and binary hashes
tar -xzf "$WORK/$TARBALL" -C "$INSTALL_DIR" --strip-components=1
BIN="$INSTALL_DIR/bin"
version_line="$("$BIN/bitcoind" --version | head -1)"
case "$version_line" in
  "Bitcoin Core version v${BITCOIN_CORE_VERSION}"*) ;;
  *) die "(e) installed bitcoind reports '$version_line', expected v${BITCOIN_CORE_VERSION}";;
esac
{
  echo "bitcoind_version: $version_line"
  echo "tarball: $TARBALL"
  echo "tarball_sha256: $actual"
  echo "builder_keys: vendored, taken from guix.sigs@$GUIX_SIGS_COMMIT, each sha256 pinned"
  echo "valid_builder_signatures: $valid (threshold $GPG_MIN_VALID_SIGNATURES, distinct primary fingerprints)"
  printf '%s\n' "$count_out" | sed 's/^/signature: /'
  echo "pinned_builder_fingerprints: $BITCOIN_CORE_BUILDER_FINGERPRINTS"
  sha256sum "$BIN/bitcoind" "$BIN/bitcoin-cli" | sed "s#$INSTALL_DIR/##"
} | tee "$EVIDENCE_DIR/provenance-bitcoin-core.txt"
cp "$WORK/SHA256SUMS" "$EVIDENCE_DIR/SHA256SUMS.bitcoin-core.txt"
cp "$WORK/gpg-status.txt" "$EVIDENCE_DIR/gpg-status.bitcoin-core.txt"
echo "PROVENANCE OK"
