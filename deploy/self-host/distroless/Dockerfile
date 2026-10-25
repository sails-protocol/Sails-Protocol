# syntax=docker/dockerfile:1.6
#
# CANDIDATE, not the production Dockerfile and not used unless the operator sets SAILS_IMAGE_FLAVOR=distroless
# (sails-node build). Promoted from experiments/p3-r21 (P3-R2.1, #533). Final stages only: the application tree is built
# once by the production Dockerfile (targets `pruned` and `migrate-deps`) and passed as named build contexts:
#
#   docker build --target pruned -t sails-build-pruned:T .   &&   docker build --target migrate-deps -t sails-build-migdeps:T .
#   docker build -f deploy/self-host/distroless/Dockerfile --build-context pruned=docker-image://sails-build-pruned:T \
#       --build-context migdeps=docker-image://sails-build-migdeps:T --target server -t sails-server:T .
#
# Differences an operator must know: no shell and no package manager in either image; the server runs as uid 65532 (not the
# Debian `node` uid 1000); `node` is /nodejs/bin/node and is NOT on PATH, so `docker exec <c> node` does not work: use the
# absolute path (the kit does). To debug, use an ephemeral debug container (e.g. `docker run --rm -it --pid=container:<id>
# busybox`) rather than putting a shell into the image. Update strategy: docs/SELF_HOSTING.md ("Distroless candidate").
#
# Both bases are pinned by digest; bump them in a reviewed commit (the weekly image audit shows when a newer digest fixes
# a finding). The Trivy gate (security/trivy-gate.json) judges the images built from these stages exactly as the others.

ARG DISTROLESS=gcr.io/distroless/nodejs24-debian13@sha256:206cfbab1a64af20b63645150e3aa61b7babc17869e0254914947732963d6f07

# ---- Server: Distroless Debian 13, Node 24.x (the base's own Node, matched to the project pin by the image checks) ----
FROM ${DISTROLESS} AS server
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
# The QVAC SDK starts its worker with bare-runtime-linux-x64/bin/bare. npm installs it mode 644; the package's wrapper
# chmods it at first spawn, which fails on a read-only root filesystem (EROFS). Set the mode at build time instead.
COPY --from=pruned --chown=65532:65532 --chmod=755 /app/node_modules/bare-runtime-linux-x64/bin/bare /app/node_modules/bare-runtime-linux-x64/bin/bare
USER 65532:65532
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "require('http').get('http://localhost:3000/health/live',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/src/main.js"]

# ---- Migration job: explicit Node entrypoint (scripts/migrate-deploy.sh re-implemented in Node, same contract) ----
FROM ${DISTROLESS} AS migrate
ENV NODE_ENV=production PRISMA_HIDE_UPDATE_MESSAGE=1 CHECKPOINT_DISABLE=1
WORKDIR /app
COPY --from=migdeps --chown=65532:65532 /migrate/node_modules ./node_modules
COPY --from=pruned --chown=65532:65532 /app/prisma ./prisma
COPY --from=pruned --chown=65532:65532 /app/prisma.config.ts ./prisma.config.ts
COPY --from=pruned --chown=65532:65532 /app/package.json ./package.json
COPY --chown=65532:65532 deploy/self-host/distroless/migrate-deploy.mjs ./scripts/migrate-deploy.mjs
USER 65532:65532
ENTRYPOINT ["/nodejs/bin/node", "scripts/migrate-deploy.mjs"]
