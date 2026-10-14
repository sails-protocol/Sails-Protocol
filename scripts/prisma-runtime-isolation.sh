#!/usr/bin/env bash
set -Eeuo pipefail

suffix="${GITHUB_RUN_ID:-local}-${RANDOM}-$$"
network="prisma-isolation-${suffix}"
volume="prisma-isolation-${suffix}"
postgres="prisma-isolation-postgres-${suffix}"
redis="prisma-isolation-redis-${suffix}"
app="prisma-isolation-app-${suffix}"
builder_image="sails-prisma-isolation-builder:${suffix}"
runtime_image="sails-prisma-isolation-runtime:${suffix}"
network_created=0
volume_created=0
postgres_created=0
redis_created=0
app_created=0
builder_built=0
runtime_built=0

cleanup() {
  if [[ "$app_created" -eq 1 ]]; then docker rm -f "$app" >/dev/null 2>&1 || true; fi
  if [[ "$redis_created" -eq 1 ]]; then docker rm -f "$redis" >/dev/null 2>&1 || true; fi
  if [[ "$postgres_created" -eq 1 ]]; then docker rm -f "$postgres" >/dev/null 2>&1 || true; fi
  if [[ "$network_created" -eq 1 ]]; then docker network rm "$network" >/dev/null 2>&1 || true; fi
  if [[ "$volume_created" -eq 1 ]]; then docker volume rm "$volume" >/dev/null 2>&1 || true; fi
  if [[ "$runtime_built" -eq 1 ]]; then docker image rm "$runtime_image" >/dev/null 2>&1 || true; fi
  if [[ "$builder_built" -eq 1 ]]; then docker image rm "$builder_image" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

docker network create "$network" >/dev/null
network_created=1
docker volume create "$volume" >/dev/null
volume_created=1
docker run -d \
  --name "$postgres" \
  --network "$network" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=sails_runtime_empty \
  -v "$volume:/var/lib/postgresql/data" \
  postgres:16-alpine >/dev/null
postgres_created=1
docker run -d --name "$redis" --network "$network" redis:7-alpine >/dev/null
redis_created=1

echo "Waiting for isolated PostgreSQL and Redis services"
for attempt in $(seq 1 60); do
  if docker exec "$postgres" pg_isready -U postgres -d sails_runtime_empty >/dev/null 2>&1 \
    && docker exec "$redis" redis-cli ping 2>/dev/null | grep -q PONG; then
    break
  fi
  if [[ "$attempt" -eq 60 ]]; then
    docker logs "$postgres"
    docker logs "$redis"
    echo "Database services did not become ready" >&2
    exit 1
  fi
  sleep 2
done

docker build --target builder --tag "$builder_image" .
builder_built=1
docker run --rm --entrypoint npx "$builder_image" prisma --version
docker run --rm --entrypoint node "$builder_image" -e '
  const { PrismaClient } = require("@prisma/client");
  if (typeof PrismaClient !== "function") throw new Error("Generated Prisma Client is unavailable");
  console.log("Generated Prisma Client is loadable in the builder");
'

docker build --target runtime --tag "$runtime_image" .
runtime_built=1
image_command="$(docker image inspect --format '{{json .Config.Cmd}}' "$runtime_image")"
printf 'runtime image command: %s\n' "$image_command"
if [[ "$image_command" != '["node","dist/src/main.js"]' ]]; then
  echo "Unexpected runtime image command; migrations must remain one-off" >&2
  exit 1
fi

docker run --rm --entrypoint node "$runtime_image" - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const wanted = new Set([
  'prisma',
  '@prisma/config',
  'mysql2',
  'deepmerge-ts',
  '@prisma/client',
  '@prisma/adapter-pg',
  '@prisma/client-runtime-utils',
  '@prisma/engines',
  'pg',
]);
const forbidden = new Set(['prisma', '@prisma/config', 'mysql2', 'deepmerge-ts']);
const required = new Set(['@prisma/client', '@prisma/adapter-pg', '@prisma/client-runtime-utils', 'pg']);
const found = new Map([...wanted].map((name) => [name, []]));
const visited = new Set();

function inspectPackage(packagePath) {
  let stat;
  try {
    stat = fs.statSync(packagePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory() || visited.has(packagePath)) return;
  visited.add(packagePath);

  const manifestPath = path.join(packagePath, 'package.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (found.has(manifest.name)) {
      found.get(manifest.name).push({ path: packagePath, version: manifest.version });
    }
  }
  scanModules(path.join(packagePath, 'node_modules'));
}

function scanModules(modulesPath) {
  if (!fs.existsSync(modulesPath)) return;
  for (const entry of fs.readdirSync(modulesPath, { withFileTypes: true })) {
    if (entry.name === '.bin') continue;
    const entryPath = path.join(modulesPath, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scopedPackage of fs.readdirSync(entryPath, { withFileTypes: true })) {
        if (scopedPackage.isDirectory() || scopedPackage.isSymbolicLink()) {
          inspectPackage(path.join(entryPath, scopedPackage.name));
        }
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      inspectPackage(entryPath);
    }
  }
}

for (const modulesPath of [
  '/app/node_modules',
  '/app/packages/sails-sdk/node_modules',
  '/usr/local/lib/node_modules',
  '/usr/lib/node_modules',
]) {
  scanModules(modulesPath);
}

let failed = false;
for (const name of wanted) {
  const matches = found.get(name);
  const installed = matches.length > 0;
  const expected = required.has(name) ? 'present' : forbidden.has(name) ? 'absent' : 'reported';
  console.log(JSON.stringify({ name, physicallyInstalled: installed, expected, matches }));
  if ((forbidden.has(name) && installed) || (required.has(name) && !installed)) failed = true;
}
if (failed) process.exitCode = 1;
NODE

docker exec "$postgres" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE sails_runtime_migrated;' >/dev/null

database_url() {
  printf 'postgresql://postgres:password@%s:5432/%s' "$postgres" "$1"
}

migrate() {
  local database="$1"
  docker run --rm \
    --network "$network" \
    -e DATABASE_URL="$(database_url "$database")" \
    --entrypoint sh "$builder_image" scripts/migrate-deploy-safe.sh
}

migration_count() {
  docker exec "$postgres" psql -U postgres -d "$1" -Atqc \
    'SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL'
}

assert_empty_database_untouched() {
  local result
  result="$(docker exec "$postgres" psql -U postgres -d sails_runtime_empty -Atqc \
    "SELECT to_regclass('public._prisma_migrations') IS NULL")"
  if [[ "$result" != 't' ]]; then
    echo "The runtime created migration history on startup" >&2
    exit 1
  fi
}

echo "Starting final runtime image against an empty PostgreSQL database"
docker run -d \
  --name "$app" \
  --network "$network" \
  -p 127.0.0.1::3000 \
  -e DATABASE_URL="$(database_url sails_runtime_empty)" \
  -e REDIS_URL="redis://${redis}:6379" \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e HOST=0.0.0.0 \
  -e MOCK_ESCROW=false \
  -e MOCK_SETTLEMENT=false \
  -e ENFORCE_CAPABILITIES=true \
  -e MULTISIG_NETWORK=testnet \
  -e EVIDENCE_PROVIDER=s3 \
  -e EVIDENCE_S3_BUCKET=runtime-isolation-smoke \
  -e EVIDENCE_S3_ACCESS_KEY_ID=runtime-isolation-smoke \
  -e EVIDENCE_S3_SECRET_ACCESS_KEY=runtime-isolation-smoke \
  "$runtime_image" >/dev/null
app_created=1

app_port="$(docker port "$app" 3000/tcp | sed 's/.*://')"
ready=0
for attempt in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:${app_port}/health/live" >/dev/null \
    && curl --fail --silent "http://127.0.0.1:${app_port}/health/ready" >/dev/null; then
    ready=1
    break
  fi
  if [[ "$attempt" -eq 60 ]]; then
    docker logs "$app"
    echo "Runtime image did not become live and ready" >&2
    exit 1
  fi
  sleep 2
done
[[ "$ready" -eq 1 ]]
printf 'runtime readiness response: '
curl --fail --silent "http://127.0.0.1:${app_port}/health/ready"
printf '\n'
assert_empty_database_untouched

docker run --rm \
  --network "$network" \
  -e DATABASE_URL="$(database_url sails_runtime_empty)" \
  --entrypoint node "$runtime_image" -e '
    const { PrismaClient } = require("@prisma/client");
    const { PrismaPg } = require("@prisma/adapter-pg");
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
    (async () => {
      try {
        const rows = await client.$queryRaw`SELECT 1::int AS value`;
        if (rows.length !== 1 || rows[0].value !== 1) {
          throw new Error(`Unexpected Prisma query result: ${JSON.stringify(rows)}`);
        }
        console.log(JSON.stringify({ prismaClientQuery: "PASS", rows }));
      } finally {
        await client.$disconnect();
      }
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  '
assert_empty_database_untouched
docker rm -f "$app" >/dev/null
app_created=0

echo "Applying migrations to an empty database"
migrate sails_runtime_empty
empty_count="$(migration_count sails_runtime_empty)"
if [[ "$empty_count" -eq 0 ]]; then
  echo "No migrations were recorded on the empty database" >&2
  exit 1
fi
migrate sails_runtime_empty
if [[ "$(migration_count sails_runtime_empty)" != "$empty_count" ]]; then
  echo "Repeated empty-database migration changed migration history" >&2
  exit 1
fi
printf 'empty database migration count after repeat: %s\n' "$empty_count"

echo "Priming an already-migrated database and verifying no-op deployment"
migrate sails_runtime_migrated
migrated_count="$(migration_count sails_runtime_migrated)"
if [[ "$migrated_count" -eq 0 ]]; then
  echo "No migrations were recorded on the already-migrated database" >&2
  exit 1
fi
migrate sails_runtime_migrated
if [[ "$(migration_count sails_runtime_migrated)" != "$migrated_count" ]]; then
  echo "Repeated already-migrated deployment changed migration history" >&2
  exit 1
fi

echo "Restarting PostgreSQL and verifying migration repeatability"
docker restart "$postgres" >/dev/null
for attempt in $(seq 1 60); do
  if docker exec "$postgres" pg_isready -U postgres -d sails_runtime_empty >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 60 ]]; then
    docker logs "$postgres"
    echo "PostgreSQL did not recover after restart" >&2
    exit 1
  fi
  sleep 2
done
migrate sails_runtime_empty
migrate sails_runtime_migrated
if [[ "$(migration_count sails_runtime_empty)" != "$empty_count" \
  || "$(migration_count sails_runtime_migrated)" != "$migrated_count" ]]; then
  echo "Migration history changed after database restart" >&2
  exit 1
fi

echo "PASS: builder generation/CLI, final-image audit, PostgreSQL startup/readiness/query, and one-off migrations"
