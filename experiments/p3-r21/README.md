# P3-R2.1 - Distroless Debian 13 experiment (NOT production)

Status: **experiment**. Nothing here is referenced by CI, compose, the production `Dockerfile` or any deploy path.
Base: #530 (`5ef5e22d`, itself on #521 and #519). Evidence logs are kept by the auditor (`p2-evidence/r21/accept/`, SHA-256 in the report comment).

## What is here
| File | Purpose |
|---|---|
| `Dockerfile` | Alternative FINAL stages on top of the application tree the production Dockerfile already builds (named build contexts `pruned`, `migdeps`): `runtime-distroless`, `runtime-distroless-rofix`, `migrate-distroless`, `migrate-trixie` |
| `migrate-deploy.mjs` | `scripts/migrate-deploy.sh` re-implemented in Node (same contract), the entrypoint of `migrate-distroless` |
| `test-server.sh` | frente A: server image on a throwaway PostgreSQL 16 + Redis 7 |
| `test-migrate.sh` | frente B: migration image, internal network, 7 cases |
| `test-adversarial.sh` | frente E: mutations by shadowing paths with throwaway mounts (no rebuilds) |
| `lib.sh`, `runner/Dockerfile` | helpers; a Linux runner with bash/curl/docker CLI |

## Reproduce
```bash
docker build --target pruned       -t r21x-pruned  .
docker build --target migrate-deps -t r21x-migdeps .
docker build --target runtime -t r21x-bookworm-runtime . ; docker build --target migrate -t r21x-bookworm-migrate .
for t in runtime-distroless runtime-distroless-rofix migrate-distroless migrate-trixie; do
  docker build -f experiments/p3-r21/Dockerfile --build-context pruned=docker-image://r21x-pruned \
    --build-context migdeps=docker-image://r21x-migdeps --target $t -t r21x-$t .; done
docker build -t r21v-runner experiments/p3-r21/runner
# inside the runner (docker socket mounted, repo at /w):
bash experiments/p3-r21/test-server.sh r21x-runtime-distroless-rofix r21x-migrate-distroless /nodejs/bin/node
bash experiments/p3-r21/test-migrate.sh r21x-migrate-distroless distroless no
bash experiments/p3-r21/test-migrate.sh r21x-migrate-trixie trixie yes
bash experiments/p3-r21/test-adversarial.sh r21x-bookworm-runtime r21x-runtime-distroless
# scanner (same digest as the other P3 reports)
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v trivycache:/root/.cache -v "$PWD/out:/out" \
  aquasec/trivy@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c image --scanners vuln \
  --severity HIGH,CRITICAL --format json -o /out/img.json --quiet <image>
```

## Results (2026-10-25; Docker 29.9.2 on Windows 11 / WSL2; Trivy 0.76.1, DB v2 updated 2026-10-25 01:20Z)
| Image | Size | Trivy HIGH+CRIT | Tests |
|---|---|---|---|
| production `runtime` (bookworm, control) | 8.81 GB | 57 (1 CRITICAL, all OS, no fix) | test-server: 18 PASS / 3 FAIL (the 3 are expected: it has a shell; its Bare binary fails on a read-only rootfs) |
| `runtime-distroless` | 8.69 GB | **0** | test-server: 20 PASS / 1 FAIL (read-only rootfs + Bare, same cause) |
| `runtime-distroless-rofix` | 8.81 GB | **0** | test-server: **21 PASS / 0 FAIL** |
| production `migrate` (bookworm, control) | 702 MB | 58 | test-migrate: 16 PASS / 0 FAIL |
| `migrate-distroless` | 578 MB | **0** | test-migrate: **17 PASS / 0 FAIL** |
| `migrate-trixie` (24.22.1, digest-pinned) | 698 MB | 43 HIGH (8 CVEs, none fixable) | test-migrate: 16 PASS / 0 FAIL |
Adversarial (both runtime images): **18 PASS / 0 FAIL**, plus two recorded gaps (see below).

## Findings
1. **Distroless Debian 13 works for the server**: Node v24.22.1 (the pin), non-root uid 65532, no shell/npm/npx/corepack, real production boot against PostgreSQL + Redis (`/health/ready` 200), built-in exec-form HEALTHCHECK healthy, `@qvac/sdk` imports (536 exports), Bare runtime starts, SIGTERM -> exit 0 in 0.44 s, read-only rootfs boots.
2. **Pre-existing defect also in the production image**: `bare-runtime-linux-x64/bin/bare` is mode 644 after `npm ci`; its wrapper chmods it at first spawn, which fails on a read-only root filesystem (EROFS). `runtime-distroless-rofix` sets 755 at build time (one `COPY --chmod`), and then the read-only case passes.
3. **Contract changes distroless imposes** (not applied anywhere): `node` is `/nodejs/bin/node` and not on PATH, so `docker exec <c> node ...` (used by the self-host kit and test scripts) and the Dockerfile `HEALTHCHECK` must use the absolute path; the image runs as uid 65532 (not 1000); the migration job needs a Node entrypoint (`migrate-deploy.mjs`) and every test that does `--entrypoint sh` needs rewriting. The self-host kit (`deploy/self-host`, `scripts/self-host-test.sh`) was **not** run against these images.
4. **Migration job without a shell**: success, idempotence, missing URL (exit 64), wrong credentials (no password in output), unreachable host and malformed URL (non-zero, not a hang), P3005 refusal with the database untouched, a new broken migration (P3018, history recorded by Prisma as designed) - all on an `--internal` network, i.e. the bundled schema engine works without downloading anything on Debian 13 / OpenSSL 3.5.
5. **Test-harness gap**: `scripts/runtime-image-checks.js` does not notice an unspawnable Bare binary (adversarial E5b); a check that runs `bare --version` through the wrapper would.

## Not tested
Full self-host kit on distroless; managed-platform behaviour; PostgreSQL 18; a long soak; image signing/provenance; the other session's observation that `@qvac/*` ships prebuilds for 9 platforms (5.1 GB of the 6.2 GB `node_modules`) was not verified here.
