# Self-hosting: acceptance criteria and open items

Status: CURRENT (2026-10-24, P3-R3). This is a checklist with the state of each line, not a readiness claim. A line is
"evidenced" only where the evidence named next to it exists and was run; everything else is open. CI green is not
production authorisation. Self-hosting as built today is **not approved for production**.

Legend: EVIDENCED = a test or run exists and passed (named); PARTIAL = covered in part, gap stated; OPEN = not done.

## A. Acceptance criteria for "a technically capable operator can self-host a node"

| # | Criterion | State | Evidence / gap |
|---|---|---|---|
| A1 | Clean install on an empty Docker host brings up database, evidence store and server, ready on `/health/ready` | EVIDENCED (CI + local, throwaway Compose project) | `scripts/self-host-test.sh` |
| A2 | Update applies migrations before the new server starts; a failing migration leaves the previous server serving | EVIDENCED | `scripts/self-host-test.sh`, migration gate in 3 layers (script, compose condition, server boot gate) |
| A3 | A migration with an unknown result does not start the new server and does not silently continue | EVIDENCED | same script; mutation evidence is in the P3-A report (not reproducible from the repository, see section B) |
| A4 | A server started by hand on an unmigrated database refuses to boot | EVIDENCED | `tests/migrationGate.test.ts`, self-host script |
| A5 | Rollback starts the previous image | PARTIAL | Works; the kit cannot verify the previous version tolerates the newer schema (it warns). See `docs/MIGRATIONS.md` |
| A6 | Backup and restore of the database | PARTIAL | Exercised in the script on throwaway data. Not exercised with production-sized data, nor with the evidence store |
| A7 | Evidence store holds files with server-side encryption (SSE-S3) | PARTIAL | Works with the 32-byte key from `WEED_S3_SSE_KEK`; **custody and backup of that key are not tested**: losing it makes stored evidence unreadable |
| A8 | No secret appears in logs or process listings | EVIDENCED (grep-based) | `scripts/self-host-test.sh`; a grep is not a proof of absence |
| A9 | Images carry no known HIGH/CRITICAL advisory | **NOT MET** | Application-dependency advisories fixed in #521; Trivy still reports base-image findings (125 on `b6f79bcd`). Gate is in observe mode (`security/trivy-gate.json`) |
| A10 | Image provenance: signed images, SBOM published | OPEN | No cosign, no SBOM, nothing published (by design: no image publication yet) |
| A11 | External base/service images pinned by digest | PARTIAL | Node base image is digest-pinned; compose service images (PostgreSQL, SeaweedFS and others) are to be verified and pinned |
| A12 | Concurrent `sails-node update` runs cannot corrupt state | OPEN | Not tested |
| A13 | QVAC works offline (no network at start) | OPEN | Not tested |
| A14 | Docker volume lifecycle: documented cleanup, no accidental data loss on `down -v` | OPEN | Not tested |
| A15 | Install and recovery on a real VPS (fresh Linux, non-root operator, reboot, disk full) | OPEN | Never run; all evidence is Windows/WSL plus GitHub Actions |
| A16 | Interoperability with a second implementation (P3-B) | OPEN | Not started |

## B. Operational and production pending items

| Item | Owner | Note |
|---|---|---|
| Decide the disposition of the Debian base-image findings (will_not_fix / affected): accept with expiry, change base image, or rebuild | CTO | Nothing is excepted today; exceptions need CTO authorisation per finding |
| Switch the Trivy gate from `observe` to `enforce` | CTO | After P3-R2 lands and the previous item is decided |
| P3-R2: remove `npm`/`corepack` from the runtime image | Peer session | Not part of this branch |
| SSE key custody and restore drill (A7) | Operator/dev | Required before any real evidence is stored |
| VPS install and recovery run (A15) | Partner dev | Needs a real host |
| Make `sails-node rollback` aware of contract migrations | Backlog | See `docs/MIGRATIONS.md` |
| Mutation-test harness reproducibility: harness lives outside the repo | Backlog | K-series results cannot be re-run by a third party today |
| Independent periodic audit of the images | Automated | `image-security-audit.yml` (weekly); a human review of its reports is not scheduled yet |

## C. Limits of the earlier audits

- P3-A (accepted head `d82d805b`): GREEN for its scoped technical criteria only. It did not cover production, a VPS, backup
  key custody, supply-chain provenance or P3-B.
- P3-R1 (#521 `b6f79bcd`): YELLOW. Scanner results at that time showed the residual findings; `npm audit` and Trivy
  disagree in time and scope, and one CI discrepancy (fast-uri) was never explained mechanically.
- Evidence was produced on one developer machine (Windows 11 + WSL2 + Docker Desktop) and GitHub-hosted runners.
