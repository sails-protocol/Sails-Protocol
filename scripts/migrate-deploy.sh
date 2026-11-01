#!/bin/sh
# Entrypoint of the `migrate` image (Dockerfile target `migrate`): applies the committed
# Prisma migrations to the database in DATABASE_URL, then proves the result with
# `migrate status`. Exit 0 ONLY when the database is fully migrated; any other outcome
# exits non-zero, which is what blocks the rollout of the new server version
# (docker-compose `service_completed_successfully`, or the platform's pre-deploy job).
#
# It never runs implicitly on server start (see the Dockerfile header) and it does not log
# the connection string: Prisma prints host/database names only, and this script prints
# nothing derived from DATABASE_URL.
set -eu

# prisma.config.ts falls back to a localhost URL when DATABASE_URL is unset (convenient for
# `npm test`); a migration job must never do that — it would either fail confusingly or,
# worse, migrate whatever happens to listen on localhost.
if [ -z "${DATABASE_URL:-}" ]; then
  echo "migrate: DATABASE_URL is not set; refusing to run (no localhost fallback for migrations)" >&2
  exit 64
fi

PRISMA="node node_modules/prisma/build/index.js"

echo "migrate: applying pending migrations"
$PRISMA migrate deploy
echo "migrate: verifying"
$PRISMA migrate status
echo "migrate: database is up to date"
