#!/usr/bin/env bash
# scripts/docker-image-size-report.sh <image>
#
# Reproducible size report for a built image (e.g. the production image):
#   bash scripts/docker-image-size-report.sh sails-runtime-ci:local
# Prints the image size, the layers >= 50 MB, and — measured INSIDE the image —
# the application tree, node_modules totals and its largest packages. Numbers
# are in MB (1 MB = 1 048 576 bytes, `du -m`) except the first two lines, which
# are Docker's own decimal figures. Read-only: it runs `docker run --rm`.
#
# Informational; it never fails a build. Size budgets, if wanted, belong in a
# separate decision.

set -euo pipefail

IMAGE="${1:?usage: docker-image-size-report.sh <image>}"

echo "image: ${IMAGE}"
echo "docker reports (bytes): $(docker image inspect "$IMAGE" --format '{{.Size}}')"
echo "docker reports (GB, decimal): $(docker image inspect "$IMAGE" --format '{{.Size}}' | awk '{printf "%.2f", $1/1000000000}')"
echo
echo "== layers >= 50 MB (docker history)"
docker history "$IMAGE" --no-trunc --format '{{.Size}}|{{.CreatedBy}}' | awk -F'|' '
  $1 ~ /GB$/ { v = $1; sub(/GB$/, "", v); printf "%8.0f MB  %s\n", v * 1000, substr($2, 1, 110); next }
  $1 ~ /MB$/ { v = $1; sub(/MB$/, "", v); if (v >= 50) printf "%8.0f MB  %s\n", v, substr($2, 1, 110) }'

echo
docker run --rm -i --entrypoint sh "$IMAGE" -s <<'INSIDE'
set -eu
mb() { du -xsm "$1" 2>/dev/null | cut -f1; }
echo "== /app (MB)"
for d in /app/*; do echo "$(mb "$d") $d"; done | sort -rn | head -8
echo
cd /app/node_modules
echo "node_modules total MB: $(mb /app/node_modules)"
echo "top-level packages (incl. scoped): $(ls -d */ @*/*/ 2>/dev/null | grep -vc '^@[^/]*/$')"
echo "package.json files under node_modules (installed package copies): $(find /app/node_modules -name package.json -path '*/node_modules/*' -not -path '*/node_modules/*/node_modules/*/node_modules/*' | wc -l)"
echo
echo "== 20 largest packages (MB)"
for d in * @*/*; do [ -d "$d" ] && [ "$d" != '@*' ] && echo "$(mb "$d") $d"; done | sort -rn | head -20
echo
echo "== groups (MB)"
sum() { total=0; for d in "$@"; do [ -e "$d" ] && total=$((total + $(mb "$d"))); done; echo "$total"; }
echo "@qvac (all): $(sum @qvac)"
echo "native binaries (*.node, *.so*, *.dylib, *.dll): $(find /app/node_modules -type f \( -name '*.node' -o -name '*.so' -o -name '*.so.*' -o -name '*.dylib' -o -name '*.dll' \) -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {printf "%.0f", s/1048576}')"
echo "source maps (*.map): $(find /app/node_modules -type f -name '*.map' -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {printf "%.0f", s/1048576}')"
echo "TypeScript sources (*.ts, not *.d.ts): $(find /app/node_modules -type f -name '*.ts' ! -name '*.d.ts' -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {printf "%.0f", s/1048576}')"
echo "front-end / example packages (next, @next, react*, lucide-react, @radix-ui, @tailwindcss, sonner, tailwind-merge, @tanstack, @floating-ui, class-variance-authority, clsx, @swc): $(sum next @next react react-dom react-router lucide-react @radix-ui @tailwindcss sonner tailwind-merge @tanstack @floating-ui class-variance-authority clsx @swc)"
echo "dev tooling (typescript, @types, playwright, @playwright, playwright-core): $(sum typescript @types playwright @playwright playwright-core)"
INSIDE
