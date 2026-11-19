#!/usr/bin/env bash
# P51 / T2: electrs (the Esplora REST backend) COMPILED from a pinned commit with `cargo build --locked`.
# Steps (each fatal): pinned Rust toolchain -> fetch exactly ELECTRS_COMMIT -> HEAD must equal it -> Cargo.lock sha256 must equal
# the pin -> locked build -> record the binary sha256.
#
# Declared supply-chain surface (written down, not hidden): the system packages below come from the Ubuntu archive of the runner
# image and are NOT pinned; the crates are pinned by Cargo.lock (--locked) but downloaded from crates.io. No cargo cache is used
# (a cache would make the build non-hermetic and is a cache-poisoning surface).
#
# Env: ELECTRS_REPO_URL ELECTRS_COMMIT ELECTRS_CARGO_LOCK_SHA256 RUST_TOOLCHAIN SRC_DIR EVIDENCE_DIR
# Output: $SRC_DIR/target/release/electrs
set -euo pipefail
: "${ELECTRS_REPO_URL:?}" "${ELECTRS_COMMIT:?}" "${ELECTRS_CARGO_LOCK_SHA256:?}" "${RUST_TOOLCHAIN:?}" "${SRC_DIR:?}" "${EVIDENCE_DIR:?}"
die() { echo "ELECTRS BUILD FAILED: $*" >&2; exit 1; }
mkdir -p "$EVIDENCE_DIR"

rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --no-self-update
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends build-essential clang cmake pkg-config

rm -rf "$SRC_DIR"; mkdir -p "$SRC_DIR"; cd "$SRC_DIR"
git init -q .
git remote add origin "$ELECTRS_REPO_URL"
git fetch --depth 1 origin "$ELECTRS_COMMIT"
git checkout -q --detach FETCH_HEAD
[ "$(git rev-parse HEAD)" = "$ELECTRS_COMMIT" ] || die "HEAD $(git rev-parse HEAD) != pinned $ELECTRS_COMMIT"
lock="$(sha256sum Cargo.lock | awk '{print $1}')"
[ "$lock" = "$ELECTRS_CARGO_LOCK_SHA256" ] || die "Cargo.lock sha256 $lock != pinned $ELECTRS_CARGO_LOCK_SHA256"

cargo "+$RUST_TOOLCHAIN" build --locked --release
BIN="$SRC_DIR/target/release/electrs"
[ -x "$BIN" ] || die "no electrs binary produced"
{
  echo "electrs_repo: $ELECTRS_REPO_URL"
  echo "electrs_commit: $ELECTRS_COMMIT"
  echo "cargo_lock_sha256: $lock"
  echo "rust_toolchain: $(rustc "+$RUST_TOOLCHAIN" --version)"
  echo "electrs_binary_sha256: $(sha256sum "$BIN" | awk '{print $1}')"
} | tee "$EVIDENCE_DIR/provenance-electrs.txt"
# The exact flag set of THIS commit goes into the evidence: run-once.sh's flags are checked against it by the GK.
"$BIN" --help > "$EVIDENCE_DIR/electrs-help.txt" 2>&1 || true
echo "ELECTRS BUILD OK"
