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
