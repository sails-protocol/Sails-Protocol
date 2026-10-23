# Sails Protocol - production server image (2026-08-02)
#
# Built for AWS App Runner's "source code repository" build path, but
# runs anywhere a plain OCI image does. bookworm-slim (glibc), not
# alpine - this project's real native dependencies (sodium-native,
# tiny-secp256k1) either ship no prebuilt musl binaries or are markedly
# less reliable to compile against musl; glibc is the boring, correct
# choice for this dependency set, not a default left unexamined.
#
# Builds exactly what `npm run build` already builds locally (verified
# throughout this repo's own history) - no separate build logic invented
# for Docker. Does NOT run `prisma migrate`/`db push` here: schema
# changes are applied as their own explicit step against the target
# database (see docs/DEPLOYMENT.md), never implicitly on container start,
# so a bad migration can't silently run every time the service restarts.
#
# Layer-cache optimization (added 2026-08-07, preserves behavior):
#   - package*.json copies happen BEFORE `npm ci`, so a source-only change
#     does not invalidate the dependency install layer.
#   - Multi-stage builder -> pruned -> runtime stays unchanged: production
#     image still gets the slim node_modules tree, devDependencies still
#     pruned.
#   - Non-root user (`node`) added to the runtime stage so a future
#     container-escape doesn't land as root inside the host namespace.
#
# Node 24 LTS (CTO decision, 2026-10-23): Node 20 reached end of life and
# got no fix for the October 2026 security release (CVE-2026-111497 Brotli
# RCE and nine others); 24.22.1 is that release's fixed LTS build. Both
# stages pin the exact tag AND the image digest, so a rebuild cannot drift
# to a different image; bump both together, deliberately. Also: dependencies
# already declare Node >= 22 (e.g. @arkade-os/sdk ">=22.12.0 <27"), which
# Node 20 never satisfied.

# ---- syntax=docker/dockerfile:1.6 ----
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS builder

# python3/make/g++: required to build this project's native addons
# (sodium-native, tiny-secp256k1) from source when no matching prebuilt
# binary is available for the target platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ----- Layer cache: deps first, source second -----
# Copying ONLY the lockfiles + per-workspace package.json's first lets
# `npm ci` cache survive across source-only edits. `npm ci` is the same
# command the host dev workflow runs (see package.json scripts) so the
# image never drifts from what contributors test locally.
COPY package.json package-lock.json ./
COPY packages/sails-p2p-schemas/package.json ./packages/sails-p2p-schemas/
COPY packages/sails-sdk/package.json ./packages/sails-sdk/

# --ignore-scripts: found the hard way (first real `docker build` attempt,
# 2026-08-03) - `redis-memory-server`/`embedded-postgres` (devDependencies
# used only for local test infra, see docs/DEPLOYMENT.md section 3) each
# have a postinstall that tries to compile/download a full server binary
# from source (Redis with RedisBloom/RediSearch/RedisJSON modules, in
# redis-memory-server's case - needs cmake/pkg-config/a Python
# interpreter, none of which this image has or needs). Neither package is
# ever imported by the production server; skipping install scripts
# entirely avoids paying for infrastructure this image will never use.
# The one script that DOES matter - `@prisma/client`'s own `prisma
# generate` - is run explicitly right after, since skipping scripts
# means it no longer fires automatically.
RUN npm ci --ignore-scripts

# Now bring in the rest of the source. Anything that changes here
# invalidates the npm-ci cache above, but the `npm run build` step
# below is fast enough that's the right tradeoff.
COPY . .

# @prisma/client postinstall is the one we want. Run it explicitly since
# we skipped scripts above.
RUN npx prisma generate

# Same build this repo's own package.json script runs everywhere else:
# @sails/p2p-schemas -> @sails/sdk -> the server's own tsc.
RUN npm run build

# `builder` (this exact point, full devDependencies still present) is
# what docker-compose.yml's local `migrate`/`app` services target
# directly - local dev wants `pino-pretty`'s readable logs (app.ts only
# enables that transport when NODE_ENV=development, and devDependencies
# have to actually be present for it to load) and the real `prisma` CLI.
# Production, below, prunes them - a separate named stage so "local dev
# wants devDependencies, production must not ship them" doesn't fight
# itself in one stage (found the hard way, 2026-08-03: pointing
# docker-compose at this stage `AS builder` after the prune already ran
# crashed on the exact same missing-pino-pretty error the runtime image
# has, defeating the entire reason to target `builder` in the first
# place).
# Production dependencies of the SERVER only: the root package plus the three
# workspace packages it actually uses (@sails/core, @satsails/p2p-schemas,
# @satsails/p2p-trading-sdk). A bare `npm prune --omit=dev` here keeps - and
# even re-installs, because `COPY . .` above made every workspace directory
# exist - the dependencies of the OTHER workspaces (packages/sails-ui,
# packages/sdk-react, examples/*, contracts): next, lucide-react, radix, the
# tailwind toolchain, sharp, etc., none of which the server can reach
# (374 lock entries, ~380 MB; see docs and scripts/docker-image-size-report.sh).
# Measured on a synthetic monorepo and on this one: with the workspace filter
# npm installs exactly the server's closure. Nothing the server requires is
# removed; scripts/docker-runtime-test.sh (resolution of every require in
# dist/, dependency-integrity check, production boot) is the guard.
FROM builder AS pruned
RUN npm prune --omit=dev \
      --workspace=packages/sails-core \
      --workspace=packages/sails-p2p-schemas \
      --workspace=packages/sails-sdk \
      --include-workspace-root
# The Prisma CLI is an OPTIONAL PEER of @prisma/client, so the prune above keeps it, with
# its CLI-only chain (@prisma/config, mysql2, deepmerge-ts, c12, effect, studio-core, the
# schema engine...). The server needs only the generated client + the pg adapter; the CLI
# lives in the separate `migrate` image. `npm uninstall` removes exactly that chain and
# touches neither package.json nor the lockfile. It needs the SAME --omit=dev / workspace
# filters as the prune: without them npm re-resolves the whole tree and re-installs the
# devDependencies and the other workspaces (found by the runtime image checks). (PR #451 reached the same goal with
# `--omit=optional`, which ALSO removes every other optional dependency — among them
# bare-runtime-linux-x64, the binary the QVAC SDK starts its worker with — so it is not
# used here; scripts/runtime-image-checks.js guards both properties.)
RUN npm uninstall prisma --no-save --ignore-scripts --omit=dev \
      --workspace=packages/sails-core \
      --workspace=packages/sails-p2p-schemas \
      --workspace=packages/sails-sdk \
      --include-workspace-root

# ---- Database migrations: a separate image, never the server ----
# `docker build --target migrate`. The Prisma CLI is a devDependency, so the `runtime`
# image (correctly) does not carry it, nor prisma.config.ts; a migration is its own
# one-shot job that must finish successfully BEFORE the new server version starts.
# This stage holds only the CLI and its dependencies, copied from the lockfile-exact
# tree built above (scripts/copy-package-closure.js), the committed migrations, and
# scripts/migrate-deploy.sh. Last stage of the file stays `runtime` (what a plain
# `docker build` and App Runner's source build produce).
FROM builder AS migrate-deps
RUN node scripts/copy-package-closure.js /migrate prisma dotenv

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS migrate
# No version-check/telemetry call to the network from a job that only needs the database.
ENV NODE_ENV=production PRISMA_HIDE_UPDATE_MESSAGE=1 CHECKPOINT_DISABLE=1
# libssl3: bookworm-slim has no libssl3, so the bundled schema-engine (debian-openssl-3.0.x)
# cannot load and Prisma silently falls back to DOWNLOADING an engine from binaries.prisma.sh
# at migration time. The job must work with no internet access (docker-migrate-test.sh runs
# it on an --internal network). The library only, not the `openssl` CLI package: the engine
# needs just the library and Prisma finds it without the binary (verified).
# Deliberately NOT pinned to a version or an apt snapshot: the base image is digest-pinned, and
# freezing this library would also freeze its Debian security fixes (old versions leave the
# mirror, so a pin would eventually break the build instead). docker-migrate-test.sh prints
# the installed version on every run.
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=migrate-deps --chown=node:node /migrate/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/scripts/migrate-deploy.sh ./scripts/migrate-deploy.sh
USER node
ENTRYPOINT ["sh", "scripts/migrate-deploy.sh"]

# ---- syntax=docker/dockerfile:1.6
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime

# OCI labels - indexable by `docker inspect` / registry searches, also
# surface in Docker Desktop and any container-image scanner (trivy,
# dive, etc.). Kept minimal on purpose: every key here is something an
# operator might actually filter on.
LABEL org.opencontainers.image.title="sails-p2p-protocol" \
      org.opencontainers.image.description="Sails Protocol reference implementation - non-custodial P2P marketplace server" \
      org.opencontainers.image.source="https://github.com/alan-schramm/Sails-Protocol" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production
WORKDIR /app

# Only what src/main.js actually needs at runtime: the pruned
# node_modules tree, the compiled server, the Prisma schema (the
# generated client's query engine reads it), and package.json (Node's
# own module resolution wants it present for the "type"/"main" fields).
#
# node_modules/@sails/sdk and @sails/p2p-schemas are npm-workspaces
# SYMLINKS (to ../../packages/<name>), not real copies - Docker COPY
# preserves symlinks as-is, so their *targets* must exist at the same
# relative path in this stage too, or the require() they point at 404s
# at container start. Both dist/ (the built JS) and package.json (whose
# "main"/"exports" field is what actually gets resolved through the
# symlink) are copied for each; src/tsconfig/tests are not needed here.
#
# packages/sails-sdk/node_modules/@noble - found the hard way (first
# real `docker run`, 2026-08-03): npm nests a SEPARATE @noble/curves
# v2.x here because escrow-key.ts/kms-signer.ts need it, while the root
# tree stays on v1.2.0 for everything else (that version split is
# exactly what those two files' own header comments already disclose).
# Without this nested copy, Node's module resolution silently falls
# through to the root's incompatible v1.2.0 and crashes at import time
# with ERR_PACKAGE_PATH_NOT_EXPORTED - invisible in `npm test` (Jest's
# own transformIgnorePatterns sidesteps this entirely, see
# jest.config.js's own comment) and invisible in every `tsc --noEmit`/
# `npm run build` check this repo has ever run, since none of those
# actually execute the compiled output the way `node dist/src/main.js`
# does. Only a real run of the built artifact surfaces it.
COPY --from=pruned --chown=node:node /app/node_modules ./node_modules
COPY --from=pruned --chown=node:node /app/dist ./dist
COPY --from=pruned --chown=node:node /app/prisma ./prisma
COPY --from=pruned --chown=node:node /app/package.json ./package.json
COPY --from=pruned --chown=node:node /app/packages/sails-p2p-schemas/dist ./packages/sails-p2p-schemas/dist
COPY --from=pruned --chown=node:node /app/packages/sails-p2p-schemas/package.json ./packages/sails-p2p-schemas/package.json
COPY --from=pruned --chown=node:node /app/packages/sails-sdk/dist ./packages/sails-sdk/dist
COPY --from=pruned --chown=node:node /app/packages/sails-sdk/package.json ./packages/sails-sdk/package.json
COPY --from=pruned --chown=node:node /app/packages/sails-sdk/node_modules ./packages/sails-sdk/node_modules
# @sails/core (packages/sails-core) - same symlink rule as above. It was
# added to the workspace after this list was written and never copied, so
# node_modules/@sails/core pointed at nothing and the server died at boot
# with "Cannot find module '@sails/core'" (found 2026-10-23 by the first
# real run of this runtime stage; CI's docker-compose test builds the
# `builder` target, which has the full tree, so it never saw this).
COPY --from=pruned --chown=node:node /app/packages/sails-core/dist ./packages/sails-core/dist
COPY --from=pruned --chown=node:node /app/packages/sails-core/package.json ./packages/sails-core/package.json

# node:24-bookworm-slim ships a non-root `node` user (uid 1000). Run as
# `node` so the process doesn't hold root privileges inside the container
# namespace - a future container-escape vulnerability lands as a normal
# user, not root. `node` is the canonical image-level user; we don't
# create a project-specific one.
USER node

EXPOSE 3000

# Liveness probe: `/health/live` returns ok as long as the process is
# up. Doesn't touch DB or Redis on purpose - a transient DB outage
# shouldn't trigger a container restart, only a readiness failure.
# `node` is the right tool here because Node's built-in http module is
# always present (the runtime image doesn't install curl/wget on
# purpose, keeping the image smaller). start_period gives the app time
# to boot before the first probe; retries/interval tuned for the
# existing app.ts /health route's sub-millisecond response time.
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health/live',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/main.js"]
