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

# ---- Application tree without the native prebuilds of other platforms ----
# Every @qvac engine ships prebuilds for nine platforms (android, darwin, ios, linux x64/arm64, win32); 5 GB of the 6.2 GB node_modules
# of the server image. A linux image can load only the one that matches its architecture. This stage runs on the build context's own
# shell (distroless has none) and deletes every `prebuilds/<platform>-<arch>` directory except the target's; the files directly inside
# `prebuilds/` and every package stay. TARGETARCH is set by BuildKit (amd64 or arm64); any other architecture fails the build.
FROM pruned AS slim
ARG TARGETARCH
RUN set -eu; arch="${TARGETARCH:-amd64}"; \
    case "$arch" in amd64) keep=linux-x64 ;; arm64) keep=linux-arm64 ;; *) echo "unsupported TARGETARCH $arch" >&2; exit 1 ;; esac; \
    before=$(du -sk /app/node_modules | cut -f1); \
    find /app/node_modules -type d -name prebuilds -prune | while read -r p; do \
      for d in "$p"/*/; do if [ -d "$d" ] && [ "$(basename "$d")" != "$keep" ]; then rm -rf "$d"; fi; done; \
    done; \
    after=$(du -sk /app/node_modules | cut -f1); \
    echo "prebuilds kept: $keep; node_modules $((before/1024)) MB -> $((after/1024)) MB"
# The QVAC SDK starts its worker with bare-runtime-linux-<x64|arm64>/bin/bare. npm installs it mode 644; the package's wrapper chmods it at
# first spawn, which fails on a read-only root filesystem (EROFS). Set the mode here, in the stage that has a shell, for the one platform package
# that is installed (its name depends on the architecture): the COPY of node_modules below keeps the mode.
RUN set -eu; bare="$(ls /app/node_modules/bare-runtime-linux-*/bin/bare)"; [ "$(printf '%s\n' "$bare" | wc -l)" -eq 1 ] || { echo "expected exactly one bare-runtime platform package, found: $bare" >&2; exit 1; }; chmod 755 "$bare"

# ---- Server: Distroless Debian 13, Node 24.x (the base's own Node, matched to the project pin by the image checks) ----
FROM ${DISTROLESS} AS server
ENV NODE_ENV=production
WORKDIR /app
COPY --from=slim --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=pruned --chown=65532:65532 /app/dist ./dist
COPY --from=pruned --chown=65532:65532 /app/prisma ./prisma
COPY --from=pruned --chown=65532:65532 /app/package.json ./package.json
COPY --from=pruned --chown=65532:65532 /app/packages/sails-p2p-schemas/dist ./packages/sails-p2p-schemas/dist
COPY --from=pruned --chown=65532:65532 /app/packages/sails-p2p-schemas/package.json ./packages/sails-p2p-schemas/package.json
COPY --from=pruned --chown=65532:65532 /app/packages/sails-sdk/dist ./packages/sails-sdk/dist
COPY --from=pruned --chown=65532:65532 /app/packages/sails-sdk/package.json ./packages/sails-sdk/package.json
COPY --from=slim --chown=65532:65532 /app/packages/sails-sdk/node_modules ./packages/sails-sdk/node_modules
COPY --from=pruned --chown=65532:65532 /app/packages/sails-core/dist ./packages/sails-core/dist
COPY --from=pruned --chown=65532:65532 /app/packages/sails-core/package.json ./packages/sails-core/package.json
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
