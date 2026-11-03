#!/usr/bin/env bash
# Issue #253 - reproduce the RED side of the OS-process suites.
#
# Applies one production-code mutant at a time to the working tree, runs the OS-process suites against it, and ALWAYS
# reverts it. The patches are evidence tooling only: they are never part of a build and nothing here is committed.
#
# From the repository root, with the same environment as `npm run test:integration:postgres`
# (DATABASE_URL, REDIS_URL, SAILS_INTEGRATION_TEST_DB_CONFIRMED, TRUSTED_ARBITRATORS, ...):
#
#   bash tests/integration/mutants/run-mutants.sh M1 M4       # chosen mutants
#   bash tests/integration/mutants/run-mutants.sh             # all of them
#   MUTANT_TESTS='-t O4' bash tests/integration/mutants/run-mutants.sh M7   # only some tests
#
# The GREEN side is the same command with no mutant (`bash tests/integration/mutants/run-mutants.sh NONE`).
set -u
cd "$(dirname "$0")/../../.."
mutants=("$@")
[ ${#mutants[@]} -eq 0 ] && mutants=(M1 M2 M3 M4 M5 M6 M7)
for m in "${mutants[@]}"; do
  patch=""
  if [ "$m" != "NONE" ]; then
    patch=$(ls tests/integration/mutants/"$m"-*.patch)
    git apply "$patch" || { echo "cannot apply $patch"; exit 2; }
    trap 'git apply -R "$patch"' EXIT
  fi
  echo "=== $m ${patch:+($(basename "$patch"))}"
  # shellcheck disable=SC2086
  npx jest --runInBand tests/integration/reconcilerOsProcess.test.ts tests/integration/reconcilerOsProcessFanout.test.ts ${MUTANT_TESTS:-} 2>&1 | grep -E '^\s+(✓|✕)|^Tests:'
  if [ -n "$patch" ]; then git apply -R "$patch"; trap - EXIT; fi
done
