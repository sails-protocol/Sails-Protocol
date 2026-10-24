#!/usr/bin/env bash
# Scans the server and migration images with the Trivy build pinned in security/trivy-scanner.json
# (image + digest) and hands the JSON reports to scripts/trivy-image-gate.js, which applies the
# severity policy (security/trivy-gate.json) and the formal exceptions (security/trivy-exceptions.json).
#
#   scripts/trivy-scan-image.sh <server-image> <migrate-image> [out-dir]
#
# Everything lands in out-dir (default trivy-report/): trivy-<image>.json, trivy-version-<image>.txt
# (scanner + vulnerability-DB versions), trivy-gate-report.md, trivy-gate-summary.json.
# Exit status is the gate's: 0 pass (or observe mode), 1 blocking findings in enforce mode, 2 the gate
# could not run. Needs docker; reads the images from the local daemon, pushes and uploads nothing.
set -euo pipefail

server_image="${1:?usage: trivy-scan-image.sh <server-image> <migrate-image> [out-dir]}"
migrate_image="${2:?usage: trivy-scan-image.sh <server-image> <migrate-image> [out-dir]}"
out="${3:-trivy-report}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

scanner="$(node -e "const s=require('./security/trivy-scanner.json');process.stdout.write(s.image+'@'+s.digest)")"
cache="${TRIVY_CACHE_DIR:-$HOME/.cache/trivy}"
mkdir -p "$cache"

scan() { # <name> <image>
  local name="$1" image="$2"
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$cache:/root/.cache/trivy" \
    -v "$out:/out" \
    "$scanner" image --quiet --scanners vuln --severity CRITICAL,HIGH,MEDIUM,LOW,UNKNOWN \
    --format json --output "/out/trivy-$name.json" "$image"
  docker run --rm -v "$cache:/root/.cache/trivy" "$scanner" version > "$out/trivy-version-$name.txt"
  test -s "$out/trivy-$name.json" || { echo "Trivy produced no report for $name" >&2; exit 2; }
}

scan server "$server_image"
scan migrate "$migrate_image"

node scripts/trivy-image-gate.js --out "$out" \
  --scan "server=$out/trivy-server.json" --scan "migrate=$out/trivy-migrate.json" \
  --version-file "$out/trivy-version-server.txt" --version-file "$out/trivy-version-migrate.txt"
