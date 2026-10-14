# ST1-R2 final adversarial acceptance gate (2026-10-14)

Status: **REVIEW REQUIRED. DRAFT. NO MERGE. NO FREEZE.** Issue #453 remains open.

This checkpoint is a test plan, **not** execution evidence. It must not be counted as passing CI or closing the remaining findings.

## Established evidence

- `tests/integration/st1TemporalCleanupAuthority.test.ts` has real-PostgreSQL cases V3, V3-S, V3-R, V3-I and generation/lock tests.
- V3-I isolates a Jest module graph with a separate Prisma client. **It does not restart an OS process.**
- The `resolveDispute()` error handler locks D then E, conditionally reverts the exact dispute generation, and deletes the associated Outcome in the same database transaction.
- The Outcome key is `(interactionId, transitionType, appealRound)`; this is not by itself proof that no durable economic authorization can be invalidated.

## Required executable acceptance cases

1. **OS-process restart:** Process A creates a real pending ruling round and is forcibly terminated after persistence. Process B starts from a fresh module graph and a fresh Prisma pool and runs the real reconciliation entrypoint. Assert the same pending ID, same generation, same Outcome, no lost signature, no duplicate dispatch, and stable replay. Do not use Jest isolation as a substitute.
2. **Atomic fault:** Inject a database error **inside** the D→E transaction after the conditional dispute update and before Outcome deletion. Assert both the dispute and Outcome remain at their pre-transaction values. Re-run with the fault removed and prove exact-once behavior.
3. **Committed economic authorization without pending:** Construct the production-valid state or prove it unreachable under constraints. If reachable, inject dispatch failure and assert no reversal of the committed economic authority. Repeat with a replaced pending of a different generation. Any unproven state must fail closed.
4. **Generation N/N+1:** Deterministically pause the old catch before its D lock, advance appeal to N+1 on another connection, then release. Assert the old catch cannot revert or delete the newer dispute or Outcome.
5. **Mutation sensitivity:** On disposable branches, remove the exact-generation guard and separately split Outcome deletion outside the transaction. Each mutation must produce a meaningful failing assertion (RED), while the unchanged implementation passes (GREEN). Compile failures are not behavioral RED evidence.
6. **Regression and exact-head CI:** Run unit + complete real-Postgres integration lanes, including cooperative RACE-B/L/L2, security preflight and the ST1 suite. Record the exact branch HEAD SHA, workflow run ID, failed/passed counts, and any residual finding.

## Mandatory gate

Do not merge PR #436, close #453, or claim 100% until all six items have reproducible evidence, with no weakened tests or bypassed preflight. Any finding must be documented with severity, reproducer, owner and disposition.

NO MATERIAL FINDING UNDER THE RUG.
