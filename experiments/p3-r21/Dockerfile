# syntax=docker/dockerfile:1.6
#
# EXPERIMENT (P3-R2.1) - NOT the production Dockerfile and not referenced by CI or by any
# deploy path. It builds alternative FINAL stages from the application tree the production
# Dockerfile already produces, so nothing here duplicates or changes the production build:
#
#   docker build --target pruned       -t r21x-pruned  .
#   docker build --target migrate-deps -t r21x-migdeps .
#   docker build -f experiments/p3-r21/Dockerfile \
#       --build-context pruned=docker-image://r21x-pruned \
#       --build-context migdeps=docker-image://r21x-migdeps \
#       --target runtime-distroless -t r21x-runtime-distroless .
#
# Targets: runtime-distroless, migrate-distroless, migrate-trixie.
# (see experiments/p3-r21/README.md for the tests and the results)

ARG DISTROLESS=gcr.io/distroless/nodejs24-debian13@sha256:206cfbab1a64af20b63645150e3aa61b7babc17869e0254914947732963d6f07
ARG TRIXIE=node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea

# ---- Server on Distroless Debian 13: no shell, no package manager, Node v24.22.1 (the project pin) ----
# Same file list as the production `runtime` stage. The node binary is /nodejs/bin/node and is NOT
# on PATH, so everything that runs node (HEALTHCHECK, `docker exec`, the self-host kit) must use
# the absolute path. uid 65532 ("nonroot") instead of the Debian `node` user (uid 1000).
FROM ${DISTROLESS} AS runtime-distroless
ENV NODE_ENV=production
WORKDIR /app
COPY --from=pruned --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=pruned --chown=65532:65532 /app/dist ./dist
COPY --from=pruned --chown=65532:65532 /app/prisma ./prisma
COPY --from=pruned --chown=65532:65532 /app/package.json ./package.json
COPY --from=pruned --chown=65532:65532 /app/packages/sails-p2p-schemas/dist ./packages/sails-p2p-schemas/dist
COPY --from=pruned --chown=65532:65532 /app/packages/sails-p2p-schemas/package.json ./packages/sails-p2p-schemas/package.json
COPY --from=pruned --chown=65532:65532 /app/packages/sails-sdk/dist ./packages/sails-sdk/dist
COPY --from=pruned --chown=65532:65532 /app/packages/sails-sdk/package.json ./packages/sails-sdk/package.json
COPY --from=pruned --chown=65532:65532 /app/packages/sails-sdk/node_modules ./packages/sails-sdk/node_modules
COPY --from=pruned --chown=65532:65532 /app/packages/sails-core/dist ./packages/sails-core/dist
COPY --from=pruned --chown=65532:65532 /app/packages/sails-core/package.json ./packages/sails-core/package.json
USER 65532:65532
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "require('http').get('http://localhost:3000/health/live',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/src/main.js"]

# ---- Migration job on Distroless Debian 13: an explicit Node entrypoint, no shell/npm/npx ----
# scripts/migrate-deploy.sh re-implemented in Node (experiments/p3-r21/migrate-deploy.mjs), same
# contract: refuse without DATABASE_URL (exit 64), `prisma migrate deploy`, then `migrate status`.
FROM ${DISTROLESS} AS migrate-distroless
ENV NODE_ENV=production PRISMA_HIDE_UPDATE_MESSAGE=1 CHECKPOINT_DISABLE=1
WORKDIR /app
COPY --from=migdeps --chown=65532:65532 /migrate/node_modules ./node_modules
COPY --from=pruned --chown=65532:65532 /app/prisma ./prisma
COPY --from=pruned --chown=65532:65532 /app/prisma.config.ts ./prisma.config.ts
COPY --from=pruned --chown=65532:65532 /app/package.json ./package.json
COPY --chown=65532:65532 experiments/p3-r21/migrate-deploy.mjs ./scripts/migrate-deploy.mjs
USER 65532:65532
ENTRYPOINT ["/nodejs/bin/node", "scripts/migrate-deploy.mjs"]

# ---- Migration job on Trixie-slim with the Node version pinned (24.22.1) ----
# Same shell entrypoint as production; libssl3t64 is installed unpinned on purpose (security
# updates), npm/corepack are removed exactly as in the production `migrate` stage.
FROM ${TRIXIE} AS migrate-trixie
ENV NODE_ENV=production PRISMA_HIDE_UPDATE_MESSAGE=1 CHECKPOINT_DISABLE=1
RUN apt-get update && apt-get install -y --no-install-recommends libssl3t64 \
    && rm -rf /var/lib/apt/lists/*
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=migdeps --chown=node:node /migrate/node_modules ./node_modules
COPY --from=pruned --chown=node:node /app/prisma ./prisma
COPY --from=pruned --chown=node:node /app/prisma.config.ts ./prisma.config.ts
COPY --from=pruned --chown=node:node /app/package.json ./package.json
COPY --from=pruned --chown=node:node /app/scripts/migrate-deploy.sh ./scripts/migrate-deploy.sh
USER node
ENTRYPOINT ["sh", "scripts/migrate-deploy.sh"]
