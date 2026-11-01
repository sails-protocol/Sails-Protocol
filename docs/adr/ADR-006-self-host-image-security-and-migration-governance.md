# ADR-006: Self-host image security, integration of the P3 chain and migration governance

Status: PROPOSED (2026-10-24, P3-R3; draft PR, not merged). Becomes ACCEPTED only when the CTO says so.
Scope: how the P3 self-hosting images are scanned, how the chain #512 -> #521 is to be integrated, how Prisma migrations are
controlled, and which decisions were taken or rejected on the way. It does not change any protocol, escrow, settlement,
identity or transport behaviour.

## Context

P3 delivers a provider-agnostic self-hosting kit (Docker Compose, `sails-node`, migration job and gate, SeaweedFS evidence
store). Technical closure of P3-A (accepted head `d82d805b`) was GREEN for its scoped criteria; production use is NO-GO.
P3-R1 (validation of #521, head `b6f79bcd`) was YELLOW: the known HIGH advisories in application dependencies were removed,
but Trivy still reports CRITICAL/HIGH findings in the base image (Debian packages with no fix, and the `npm` bundled in the
Node base image). A self-hosted operator has no vendor to patch for them, so the controls must be continuous and visible.

## Decisions

### D1. Trivy is a CI gate on both shipped images, starting in observe mode

- Scanner pinned by digest (`security/trivy-scanner.json`); its vulnerability database is downloaded at scan time and is not
  pinned, so each report records the DB version.
- Policy in `security/trivy-gate.json`. `observe` reports exactly what **would** fail and exits 0; `enforce` fails on any
  CRITICAL/HIGH without a valid exception. Moving to `enforce` is a reviewed one-line change.
- Exceptions (`security/trivy-exceptions.json`) need CVE/GHSA id, package, image (`server` or `migrate`), a reason of 20+
  characters, an owner and an expiry date; they are scoped exactly and expire by date; unused and expired ones are reported.
  A malformed exceptions file fails the gate in both modes. **The file is empty and stays empty until the CTO authorises
  specific exceptions**; the current findings are not excepted.
- A weekly workflow (`image-security-audit.yml`) rebuilds both images from the default branch and re-scans with a fresh
  database, because advisories appear after a PR is merged.
- Measured on `b6f79bcd` (before P3-R2): 125 blocking findings (server 62: 57 OS + 5 Node; migrate 63: 58 OS + 5 Node).
  In observe mode the gate reports this and passes; in enforce mode it would fail. This is not hidden by the choice of mode.

### D2. Integrate the consolidated #521 tree, preserving commit history

Verified 2026-10-24 on `origin/main` `456d3e52` with throwaway worktrees (no merge performed anywhere real):

- #512 -> #515 -> #519 -> #521 is a linear ancestry chain; #516 is **not** an ancestor of #519 or #521.
- All 13 commits of #516 are patch-id-equivalent to commits inside #519, so #516 adds nothing once #519/#521 are in.
- Merging #521 alone into current `main` is clean; the resulting tree equals #521's tree plus the two documentation files
  that landed on `main` since (ROADMAP.md, the Paykit/Pubky RFC draft).
- Merging the five PRs sequentially conflicts in `docs/DEPLOYMENT.md` at #519 and again at #521, because #516 carries an
  older copy of the same file. Merging #512, #515, #516 and then #521 conflicts the same way.

Decision proposed: merge #521 (a merge commit, not a squash, so the commits of #512/#515/#519/#521 stay traceable) and close
#516 as superseded by #519, with its patch-equivalence recorded in the closing comment. Re-run `node scripts/verify-pr-chain.js`
immediately before merging, because `main` and the heads move (on 2026-10-24 the script reports: ancestry as above, #512/#515/#516/#519
patch-equivalent 5/5, 7/7, 13/13, 40/40 to commits of #521, clean merge). **No merge is performed by this work.**

Expected interaction with in-flight work (to re-check at merge time): P3-R2 (peer session, Dockerfile and
`scripts/runtime-image-checks.js`; no PR was visible on 2026-10-24) edits files this ADR's CI step sits next to, so a
textual conflict in `ci.yml` is possible but not semantic; Dependabot #518 and #492 touch lock entries #521 already pins;
the P4 branches (#522-#527) do not touch the P3 files and are not stacked on this chain.

Rollback plan for the integration: the merge is one merge commit on `main`; reverting it (`git revert -m 1 <merge>`)
removes the chain in one step because nothing is squashed. The chain changes nothing under `prisma/` (checked with
`git diff origin/main <#521 head> -- prisma`: 0 files), so reverting it cannot leave a database ahead of the code; the
self-host kit and its images are not deployed anywhere by the merge itself.

### D3. Prisma migrations are classified, frozen and probed

See `docs/MIGRATIONS.md`: lint with a SHA-256 baseline (immutability), a required reasoned annotation for any new
non-additive migration, and a probe that applies old then new migrations to a throwaway database and fails on changes that
break the previous server version. Expand/contract is the documented way to make breaking changes.

## Rejected or deferred (recorded so they are not re-proposed unseen)

| Option | Outcome | Why |
|---|---|---|
| `npm ci --omit=optional` to shrink the image | Rejected | It removes `bare-runtime-linux-x64`, the native runtime the QVAC worker needs; the image would build and fail at run time. |
| Replace SeaweedFS by MinIO (or keep MinIO) | Rejected | MinIO's community edition was archived; SeaweedFS is the evidence store of the kit. Revisit only on a security or licence event. |
| Rely on Prisma alone to notice an edited applied migration | Rejected | Prisma does not re-check checksums of applied migrations in `migrate status/deploy`; the server's boot gate compares them against the bytes the image ships, and CI now also freezes the bytes (D3). Neither replaces the other. |
| Accept the current Trivy findings through exceptions | Not done | Needs CTO authorisation per finding; nothing was excepted. |
| Treat `npm audit` as the image verdict | Rejected | It is time-dependent (feed lag) and not image-aligned; the image-aligned audit plus Trivy are used instead. One CI discrepancy (fast-uri) was never explained mechanically. |
| Fastify / dependency findings | Fixed in #521 (fastify, zod, brace-expansion, source-map-js) | Dependabot #518 (fastify 5.12.6) targets a version **below** the 5.12.7 #521 ships, so it is superseded and must not merge first; #492 (source-map-js 1.2.2) equals what #521 ships. Both touch lock entries #521 already pins: expect lockfile conflicts and close them after #521. |
| Remove `npm`/`corepack` from the runtime image | Owned by P3-R2 (peer session) | Not touched here. Expected to remove the Node-package findings that live in the base image's `npm`; the Debian findings remain. |

## Limits of the evidence behind this ADR

- The P3-A audit and the P3-R1 validation were run on one Windows/WSL machine plus GitHub Actions. Mutation evidence
  (K3/K4/K6) is reproducible only with the local harness, which is not in the repository.
- Trivy's result depends on the database at scan time; a green scan today is not a green scan next week.
- Nothing here was tested on a VPS, with real backup custody, or against another implementation (P3-B). These are open
  items in `docs/SELF_HOST_ACCEPTANCE.md`.
- CI green is not production authorisation.

## Consequences

- A new HIGH/CRITICAL in either image is visible on every PR and weekly; in observe mode it does not block, so somebody
  must decide when to enforce (recommended: once P3-R2 lands and the Debian findings have an accepted disposition).
- Contract migrations require an annotation and cannot be rolled back by image alone; documented, not automated.
- Adding the scan costs CI minutes (two scans per run) and one network fetch of the vulnerability database.
