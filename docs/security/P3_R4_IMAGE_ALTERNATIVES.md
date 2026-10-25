# P3-R4 Front A/B: base-image alternatives, Distroless assessment and the image-size finding

Status: CURRENT (2026-10-25). Read-only comparison in disposable environments. **No production Dockerfile was changed.** #530
(P3-R2, `security/r2-selfhost-image-hardening`, owner: another session) edits the same Dockerfile; everything here is evidence and
proposal, and any change belongs to that PR or to a later one decided by the CTO. Raw data: `docs/security/p3-r4-evidence/`.

## 1. Base images scanned (Trivy 0.76.1 pinned by digest, HIGH/CRITICAL, base image only)

| Base | OS | Size | CRITICAL | HIGH | Distinct CVEs | Notes |
|---|---|---|---|---|---|---|
| `node:24.22.1-bookworm-slim@sha256:55fb5f5a...` (current) | Debian 12.15 | 315 MB | 1 | 61 | 17 | `node:24-bookworm-slim` today resolves to the same findings |
| `node:24-trixie-slim` | Debian 13.7 | 319 MB | 0 | 48 | 13 | zlib CRITICAL, gzip and two util-linux CVEs gone; 4 util-linux + libacl, systemd, ncurses, perl CVEs and the 5 bundled-`npm` CVEs remain |
| `node:24-alpine` | Alpine 3.24.3 | 232 MB | 0 | 5 | 5 | Only the bundled-`npm` CVEs. **musl, not glibc**: the QVAC native prebuilds, `bare-runtime-linux-x64` and Prisma's schema engine are glibc builds. Not built and not tested here: NOT VERIFIED, expected to break |
| `gcr.io/distroless/nodejs24-debian13` | Debian 13.7 | 205 MB | 0 | **0** | 0 | No shell, no package manager, no `npm`; see section 2 |
| `gcr.io/distroless/nodejs24-debian12` | Debian 12.13 | 194 MB | 0 | 6 | 7 | One of the seven is `libssl3` (CVE-2026-84782); six CVEs that the current base does not report |

Scans are of the **base image alone**. They say nothing about the application layers: the application's own Node dependencies
had no HIGH/CRITICAL finding in the #521 images (all five Node findings are inside the base image's bundled `npm`).
Base images are mutable tags; a re-scan next week will differ. The current image is digest-pinned, the candidates here are not.

## 2. Distroless (Debian 13) for the server image: assessment

What the existing Dockerfile needs and what distroless changes (a throwaway Dockerfile, `Dockerfile.distroless`, was generated
outside the repository to test this; **its build and run were not completed in this mission**, see section 4):

| Requirement | Compatible? | Why |
|---|---|---|
| `CMD ["node","dist/src/main.js"]`, `HEALTHCHECK` using `node -e` | Yes, with edits | exec form; the entrypoint of the distroless image is already `node`; HEALTHCHECK must use the absolute `/nodejs/bin/node` |
| `USER node` and `--chown=node:node` | Needs edits | distroless has no `node` user; its non-root user is uid 65532 |
| `migrate` image: `ENTRYPOINT ["sh", "scripts/migrate-deploy.sh"]` and `apt-get install libssl3` | **No** | no shell and no `apt`; the migration job would need a Node rewrite of `migrate-deploy.sh` and the `libssl3` the schema engine needs. So `migrate` stays on a Debian slim base |
| `scripts/runtime-image-checks.js` step 6 (`npm ls`) | No | no `npm` in the image; the dependency-tree check would have to move to the builder stage (P3-R2 already restructures these checks) |
| Operator debugging (`docker exec ... sh`) | No | no shell; a `:debug` variant or an ephemeral debug container is needed |
| QVAC `bare-runtime-linux-x64`, native addons | Not verified | glibc, so plausible; needs a run |
| Trivy result | 0 HIGH/CRITICAL on the base | removes every OS finding in the matrix for the `server` image |

Assessment: **distroless Debian 13 is a plausible base for the `server` image only**, with a split base (distroless `server`,
trixie-slim `migrate`). It removes the shell, `apt`, `npm`, setuid binaries and all 18 CVEs from the server image's base, at the
cost of debuggability and of a Dockerfile change that touches the same stages as #530. It also changes what "an operator can
inspect" means for a self-hosted node. That trade-off is the CTO's. **Not recommended to implement concurrently with #530.**

## 3. Image size: why the `server` image is ~6.5-8.8 GB

Trivy reported `Metadata.Size` 6,586,986,496 bytes for the CI runtime image (migrate: 507,235,840). Measured in a built
`runtime` image (`docker run ... du`, script `p3-r4-evidence/image-size-probe*.sh`):

| Path | Size |
|---|---|
| `/app` | 6.26 GB |
| `/app/node_modules` | 6.25 GB |
| `/app/node_modules/@qvac/*` (21 packages) | 5.07 GB |
| `/usr` (everything the OS provides) | 0.21 GB |

Each `@qvac` engine ships native prebuilds for **nine** platforms (`android-arm64`, `darwin-arm64`, `darwin-x64`, `ios-arm64`,
`ios-arm64-simulator`, `ios-x64-simulator`, `linux-arm64`, `linux-x64`, `win32-x64`), 11 engines carry `prebuilds/`. Example,
`@qvac/llm-llamacpp/prebuilds` (592 MB): `linux-x64` 154 MB, `android-arm64` 131 MB, `linux-arm64` 131 MB, `win32-x64` 115 MB,
the rest 12-13 MB each. A `linux/amd64` server needs only `linux-x64` (plus `bare-runtime-linux-x64`, already kept).

Proposal (**not implemented**): in the final stage, delete the prebuild directories of other platforms, then run the image
checks and a QVAC start. Expected saving: of the 5.07 GB in `@qvac`, roughly three quarters (the `linux-x64` share is about
26% per engine). This is *not* the rejected `--omit=optional`: it removes files for platforms the image cannot run, keeps every
package, and must be proven by the checks that guard QVAC (`bare-runtime-linux-x64` resolvable, workers start). Risk: QVAC
resolving a prebuild by something other than `process.platform`/`process.arch` (not verified). A multi-arch image would need the
`linux-arm64` prebuilds back. Interaction with #530: none in these lines, but both edit the final stage.

## 4. What was and was not verified

| Item | State |
|---|---|
| Base-image Trivy scans (5 bases + current) | Verified, data in `p3-r4-evidence/base-*.json` |
| Size breakdown of the runtime image | Verified by measurement |
| Full `runtime` and `migrate` images on trixie-slim: build | The runtime image was built once (about 34 min; `docker images` listed it at 8.81 GB) and the migrate image after it, **then removed in a disk cleanup before the checks were run**. A rebuild was started and stopped when the Docker engine became unresponsive |
| `runtime-image-checks.js` and Trivy on the full trixie images | **NOT VERIFIED** (see above); the expected finding set is the trixie base set plus the unchanged application tree, which is a projection, not a scan |
| Distroless image build/run | **NOT VERIFIED**; section 2 is an analysis of the Dockerfile and of the base image's contents |
| Alpine compatibility | NOT VERIFIED (expected to fail on glibc-only prebuilds) |

To close this honestly: rebuild `Dockerfile.trixie` with at least 12 GB free host disk and a healthy Docker engine, run
`runtime-image-checks.js` inside it, scan it with the pinned Trivy, then repeat for the distroless server stage. Not a
decision needed from the CTO, only free disk and time.
