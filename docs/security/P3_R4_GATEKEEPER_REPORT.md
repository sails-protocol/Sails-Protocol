# P3-R4 Gatekeeper report

Status: **YELLOW**. Production: **NO-GO**. Self-hosting is **not** declared ready, Day 0 is **not** declared approved.
Date: 2026-10-25. Chain base: PR #529 (`7763c3f8813d84ebbc5b68516d1f548a7bb74726`, CI green). This work: PR #532 (draft).
Decision legend: PASS = the stated invariant was observed by the named evidence; FAIL = an unsafe behaviour was observed;
NOT VERIFIED = no evidence, or only a projection. **A validated mechanism is not operational security**: where a row says
PASS it means the mechanism behaves as stated in the stated conditions, not that a real node is safe.

Prohibitions respected: no merge, no deploy, no shared-database migration, no change of economic authority, no automatic Trivy
exception, enforce NOT enabled, no PR closed, no other session's branch modified (#530, #525, #531 only read).

## 1. Requirement / evidence table

| # | Requirement (verifiable invariant) | Implementation (file @ SHA) | Test (command, result) | Security (CVEs / residual) | CI | Integration | Decision |
|---|---|---|---|---|---|---|---|
| 1 | The shipped images are scanned by a pinned Trivy on every PR and weekly; findings are reported; a broken exception file or an unrunnable scan never passes silently | `scripts/trivy-image-gate.js`, `scripts/trivy-scan-image.sh`, `security/trivy-*.json`, `.github/workflows/ci.yml`, `.github/workflows/image-security-audit.yml` @ `7763c3f8` | `npx jest tests/trivyImageGate.test.ts` 16/16 | The gate is in **observe** mode: it does not block. Weekly workflow added, **not yet executed** | #529 CI: [40153737046](https://github.com/sails-protocol/Sails-Protocol/actions/runs/40153737046) success (Trivy step success, artifact uploaded) | Needs #521 under it | PASS (mechanism); NOT VERIFIED (weekly run) |
| 2 | The 125 findings reduce to a known set, none hidden by an exception | `docs/security/P3_R4_TRIVY_TRIAGE.md`, `p3-r4-evidence/trivy-findings-125.json` | Artifact of run 40153737046 re-analysed: 125 raw, 63 unique triples, **18 distinct CVEs**; `security/trivy-exceptions.json` has 0 entries (asserted by a unit test) | 13 OS CVEs without upstream fix; 5 Node CVEs all in the base image's bundled `npm` | same run | n/a | PASS (triage complete); **FAIL (images are not clean: 1 CRITICAL, 17 HIGH)** |
| 3 | Debian findings can be reduced by a different base | `P3_R4_IMAGE_ALTERNATIVES.md`, `base-*.json` | Pinned Trivy over 5 candidate bases: bookworm 1C/61H, trixie 0C/48H, alpine 0C/5H, distroless-d13 0/0, distroless-d12 0C/6H | Base-image scans only; mutable tags | n/a | Touches the same Dockerfile stages as #530 | PASS (comparison); NOT VERIFIED (any candidate as a full image) |
| 4 | Full trixie `runtime` and `migrate` images pass `runtime-image-checks.js` and Trivy | `p3-r4-evidence/Dockerfile.trixie` (generated outside the repo) | Image built once (34 min), **removed by a disk cleanup before the checks ran**; rebuild stopped when the Docker engine stopped responding | n/a | n/a | n/a | **NOT VERIFIED** |
| 5 | Distroless server image is viable | `P3_R4_IMAGE_ALTERNATIVES.md` section 2 | Analysis of the Dockerfile and the base only; no build/run | `migrate` cannot be distroless (needs `sh`, `apt`) | n/a | Coordinate with #530 | **NOT VERIFIED** |
| 6 | The server image size is explained | `image-size-probe*.sh` | `du` in a built runtime image: `/app/node_modules` 6.25 GB, `@qvac` 5.07 GB, each engine ships prebuilds for 9 platforms | n/a | n/a | Proposal only; not implemented | PASS (root cause); NOT VERIFIED (proposed prune) |
| 7 | A restore without the correct SSE key fails safely | `scripts/self-host-recovery-probe.js` (E4) | `node scripts/self-host-recovery-probe.js`: 13 cases, 12 PASS, 1 INFO, 0 FAIL | No plaintext or wrong bytes returned (SeaweedFS 4.48) | Not in CI (pulls a 724 MB image) | Independent of the other PRs | PASS (mechanism, throwaway containers) |
| 8 | An incomplete backup cannot be declared intact | probe cases E5, E5b, D1-D4; gaps G1-G3 | Truncated tar detected by `tar -tzf`; **`pg_restore --list` accepts a truncated dump**; default restore leaves a partial database | **The kit writes no checksum/signature/MAC for any backup** | n/a | Kit not modified | **FAIL for the kit** (G1-G3); PASS for the tools |
| 9 | Controlled SSE key rotation | probe E7, E8; procedure in `SELF_HOST_BACKUP_AND_KEYS.md` | Copy A->B, verify 5/5 objects, new store works without old key/volume | Rotation is manual (G4) | n/a | n/a | PASS (procedure), **no automation** |
| 10 | The `migrate` service is as protected as `server` | `deploy/self-host/compose.yml` @ `7763c3f8` | Read: `server` has `no-new-privileges` + `cap_drop: [ALL]`, `migrate` has neither | setuid `mount`/`umount`/`su` present in the image (util-linux CVEs) | n/a | Kit not modified | **FAIL** (G6, proposal only) |
| 11 | Recovery preserves signing identity and authority | n/a | The kit generates and backs up no node signing identity | n/a | n/a | Post-Master-Backlog-Day-0 decision | **NOT VERIFIED** (not a test gap, a design decision) |
| 12 | The 37 historical migrations cannot change | `scripts/migration-lint.js`, `scripts/migration-lint.baseline.json` @ `bbc614ca` | Baseline SHA-256 of all 37 equals the bytes on `origin/main` (0 mismatches); edit, CRLF-only edit and whitespace-only edit fail | n/a | #529 CI step "Migration lint and old-version compatibility probe" success; this PR's CI below | Chain adds no migration (0 files under `prisma/`) | PASS |
| 13 | New destructive migrations are blocked unless justified; evasions do not pass as additive | same + `tests/migrationControls.test.ts` | `npx jest tests/migrationControls.test.ts`: **23/23** with a real PostgreSQL 16 (local, throwaway; 18 + 5 DB cases), 34 passed / 5 skipped without a database | `DO $$` blocks never additive; annotation only in the leading comment block | CI step of this PR (below) | n/a | PASS (mechanism); lint reads SQL text, not behaviour |
| 14 | Old server version stays compatible with the new schema | `scripts/migration-compat-probe.js` | Probe on real history flags `offers.requiresKyc: removed`; adversarial cases: varchar narrowing, DEFAULT removal | **Schema compatibility is not query compatibility** (`docs/MIGRATIONS.md`) | CI step | n/a | PASS (schema shape); NOT VERIFIED (queries) |
| 15 | Integration order is known and conflicts are real | `scripts/verify-pr-chain.js`, `chain-verify-529.txt` | See section 2 | n/a | n/a | See section 2 | PASS (simulation); nothing merged |
| 16 | Weekly independent image audit executes | `.github/workflows/image-security-audit.yml` | Not run yet (needs the schedule or a dispatch on the default branch) | n/a | none | n/a | **NOT VERIFIED** |
| 17 | Full local unit suite on this branch | n/a | Did not complete locally (session restarts); the CI of #529 ran it: "CI Tests" 2537 passed, 4 skipped | n/a | run 40153077478 success | n/a | PASS via CI only |

## 2. Integration (read-only simulations on `origin/main` `456d3e52`, no merge performed)

| Question | Result |
|---|---|
| Ancestry | #512 -> #515 -> #519 -> #521 -> #529 linear. #516 is not an ancestor of any of them |
| Is #516 redundant? | Yes: 13 of 13 commits are patch-id-equivalent to commits inside #529. Merging #529 makes #516 redundant. Not closed |
| Is #518 superseded? | Yes: its lock pins fastify 5.12.6, zod 4.4.3, brace-expansion 5.0.9; #529 ships 5.12.7 / 4.6.7 / 5.0.12. Merged after #529 it conflicts in `package.json` and `package-lock.json`. Not closed |
| Is #492 redundant? | Yes: source-map-js 1.2.2 equals what #529 ships; it merges clean after #529 but adds nothing. Not closed |
| #529 alone onto `main` | Clean; tree equals #529's except the two docs that landed on `main` (ROADMAP.md, Paykit RFC draft) |
| #529 x #530 (P3-R2, `5ef5e22d`) | **Conflict in `CHANGELOG.md` only**, in either order (both prepend under "### Security"). `ci.yml`, `Dockerfile`, `docs/DEPLOYMENT.md` and the lockfile do not conflict |
| #529 / #530 x #531 (docs, `4382a7fa`) | Clean in every order tried |
| #529 after #518 + #492 (dependabot first) | Conflict in `package.json` and `package-lock.json` |
| Recommended sequence for the CTO to authorise | #529 (merge commit) -> #530 (resolve `CHANGELOG.md`) -> #531; then close #516, #518, #492 as superseded. Re-run `node scripts/verify-pr-chain.js` immediately before |

## 3. Open blockers (why this stays YELLOW)

1. The images are not clean: 1 CRITICAL (zlib, not reachable per the evidence) and 17 HIGH. No disposition has been decided; no exception exists.
2. Kit gaps G1-G3 and G6 (no backup integrity, partial restores, `migrate` unprotected) are FAIL against the stated requirements and are unimplemented by order of this mission.
3. Identity/authority recovery is NOT VERIFIED and depends on a design decision.
4. Trixie/distroless full images, and the weekly audit run, are NOT VERIFIED.
5. No VPS run, no real-key custody drill, no P3-B interoperability, no supply-chain provenance (cosign/SBOM).

## 4. CI for the published head

See the PR #532 checks and the run links appended to the PR description. A documentation-only commit changes no code path; its
CI is the full-suite evidence for this head.
