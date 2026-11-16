#!/bin/sh
# Wraps `prisma migrate deploy` to work around a real, reproducible bug
# found 2026-08-09 diagnosing a fresh `docker compose up` from an empty
# database: `prisma migrate deploy`, run once for the FULL pending set,
# fails applying the very first migration (20260807_init, ~500 lines,
# creates the whole schema) immediately followed by any other migration
# in the SAME invocation -- "relation ... does not exist" for a table
# that migration itself just created. Verified this is specific to
# 20260807_init sharing an invocation with a later migration, not a
# general "second migration in a batch" issue or a problem with the
# migration SQL itself (each migration file applies cleanly on its own
# via `prisma db execute`, and the full remaining set applies cleanly
# together once 20260807_init has already been recorded as applied by
# a prior, separate invocation) -- most likely a Prisma 7 / @prisma/
# adapter-pg driver-adapter issue with schema-cache invalidation after
# a large first migration, not something fixable by editing this
# repo's own SQL. Root cause not fully isolated beyond that; this is a
# working, verified operational workaround, not a real fix upstream.
#
# On a genuinely fresh database (no _prisma_migrations table yet):
# apply 20260807_init in its own invocation first, then deploy the rest
# normally in a second invocation. On every other database (already has
# some migration history), this is exactly `prisma migrate deploy` --
# zero behavior change from before this script existed.
set -e

# CTO 225 - decide the credential model BEFORE migrating anything. A segregated
# database (docs/DEPLOYMENT.md 6.3) is migrated through MIGRATION_DATABASE_URL
# (sails_migrator). The legacy single superuser credential is an explicit,
# affirmative opt-in; forgetting both is a configuration error, not a skip.
if [ -z "$MIGRATION_DATABASE_URL" ] && [ "$SAILS_LEGACY_SINGLE_CREDENTIAL" != "1" ]; then
  echo "migrate-deploy-safe: set MIGRATION_DATABASE_URL (sails_migrator, see docs/DEPLOYMENT.md 6.3) or, for a legacy single-credential database only, SAILS_LEGACY_SINGLE_CREDENTIAL=1" >&2
  exit 1
fi

# `prisma db execute` never prints SELECT output (verified directly --
# it only ever says "Script executed successfully", regardless of the
# query), so detection here goes through `migrate status` instead:
# verified directly that its pending-migrations list prints one bare
# migration name per line, e.g. a line reading exactly "20260807_init"
# when that migration hasn't been applied yet. `migrate status` exits
# non-zero whenever anything is pending, hence `|| true` -- this
# script only cares about the specific line, not the exit code.
STATUS_OUTPUT=$(npx prisma migrate status 2>&1 || true)

if echo "$STATUS_OUTPUT" | grep -qx "20260807_init"; then
  echo "20260807_init not yet applied -- applying it in its own invocation first (see this script's own header comment for why)."
  npx prisma db execute --file prisma/migrations/20260807_init/migration.sql
  npx prisma migrate resolve --applied 20260807_init
fi

npx prisma migrate deploy

# CTO 225 - runtime privilege matrix, applied as the migrator after every
# migration run (idempotent). On a segregated database a missing sails_runtime
# role or an unclassified table fails the deploy; the legacy opt-in (checked at
# the top) skips it, and the production boot check refuses that credential.
if [ -n "$MIGRATION_DATABASE_URL" ]; then
  npx prisma db execute --file scripts/db/runtime-grants.sql
else
  echo "SAILS_LEGACY_SINGLE_CREDENTIAL=1: legacy single-credential database, runtime grants NOT applied (production refuses to boot on it; see docs/DEPLOYMENT.md 6.3)."
fi
