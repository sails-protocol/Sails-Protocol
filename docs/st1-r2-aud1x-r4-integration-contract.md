# ST1-R2 × AUD1X-R4 — isolated integration contract

Status: **OPEN / NOT MERGED / NOT ACCEPTED**. This document is an integration checkpoint, not a claim that the two implementations have been combined.

## Pinned inputs
- Gatekeeper PR #436: `1ab60a891ed40b76060482519768e387f50c477a` (CI 39057105108: success).
- Claude PR #443: `fe3523a5fb13ead11086ef6ba8c24044a1d7c62b` (CI 38979408599: success).
- Both are draft, diverged from merge base `58d39503c22f5a1747968f12e11f628c30b0129f`.
- Individual green CI **does not** validate a composed HEAD.

## Conflict contract (must be proven on the actual combined code)
1. `dispute.service.ts`: retain V3 post-persist fail-closed behavior, D→E locks, exact ruling-generation checks and atomic Outcome rollback. Reconcile AUD1X-R4 `decideRulingRevert`/`revertCommittedRuling` with those invariants; do not replace either whole file.
2. `escrow.service.ts` and `multisig.provider.ts`: retain existing transport-loss / ambiguous broadcast oracles (LIVE, PASS 0/1, C8) and preserve AUD1X authority checks. Never introduce blind rebroadcast or unconditional revert.
3. `tests/integration/st1TemporalCleanupAuthority.test.ts`: union regression coverage, including V3 post-persist, SIGKILL, signed round, generation N→N+1, EDA, restart and concurrent cleanup; do not discard either suite.
4. Integrate `prisma/schema.prisma` and migration `20261019120000_eda_ruling_identity_evidence` with database schema validation before any application-code adoption.
5. Keep exact signature/Outcome-scoped deletion and fail-closed authorization. No deletion based solely on a pending ID or stale observation.

## Evidence required before acceptance
- Build/typecheck + unit tests + PostgreSQL integration/mutation regressions on **one composed commit SHA**.
- Verify negative oracles (expected RED when guard removed), then GREEN restored.
- Independent CTO review of combined diff and schema migration.
- No merge into PR #436, PR #443 or protected branch, no deploy/freeze until explicit Gate 3 authorization.

## Current execution checkpoint
Sandbox initially points to #436. **AUD1X-R4 code has not yet been composed**. This checkpoint deliberately prevents an accidental green claim based on a documentation-only commit.
