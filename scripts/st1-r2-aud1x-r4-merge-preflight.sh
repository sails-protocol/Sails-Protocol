#!/usr/bin/env bash
# Non-destructive ST1-R2 / AUD1X-R4 merge preflight.
# Requires git >= 2.38 and a clean clone with GitHub origin access.
set -euo pipefail

BASE_SHA="1ab60a891ed40b76060482519768e387f50c477a"
AUD_SHA="fe3523a5fb13ead11086ef6ba8c24044a1d7c62b"
EXPECTED_MERGE_BASE="58d39503c22f5a1747968f12e11f628c30b0129f"

git rev-parse --is-inside-work-tree >/dev/null
git fetch --no-tags origin "$BASE_SHA" "$AUD_SHA"
actual_base="$(git merge-base "$BASE_SHA" "$AUD_SHA")"
if [[ "$actual_base" != "$EXPECTED_MERGE_BASE" ]]; then
  printf 'RED: unexpected merge base: %s (expected %s)\n' "$actual_base" "$EXPECTED_MERGE_BASE" >&2
  exit 2
fi

printf 'Pinned ST1-R2: %s\nPinned AUD1X-R4: %s\nMerge base: %s\n' "$BASE_SHA" "$AUD_SHA" "$actual_base"
printf 'Conflicting paths (if any):\n'
# --name-only is not available for merge-tree. The --write-tree exit code is
# nonzero when there are conflicts. Capture and print the full diagnostic,
# without checking out, moving a ref, or committing any result.
set +e
report="$(git merge-tree --write-tree "$BASE_SHA" "$AUD_SHA" 2>&1)"
status=$?
set -e
printf '%s\n' "$report"
if [[ "$status" -ne 0 ]]; then
  printf 'RED: merge-tree found conflicts. Resolve on sandbox; do not merge/deploy.\n' >&2
  exit 1
fi
printf 'GREEN: tree composition is conflict-free, NOT yet typechecked, PG-tested, reviewed, or authorized.\n'
