# ST1-R2 final adversarial acceptance gate (2026-10-14)

Status: **REVIEW REQUIRED. DRAFT. NO MERGE. NO FREEZE.** Issue #453 remains open.

This checkpoint is a test plan, **not** execution evidence. It must not be counted as passing CI or closing the remaining findings.

## Established evidence

- `tests/integration/st1TemporalCleanupAuthority.test.ts` has real-PostgreSQL cases V3, V3-S, V3-R, V3-I and generation/lock tests.
- V3-I isolates a Jest module graph with a separate Prisma client. **It does not restart an OS process.**
- The `resolveDispute()` error handler locks D then E, conditionally reverts the exact dispute generation, and deletes the associated Outcome in the same database transaction.
- The Outcome key is `(interactionId, transitionType, appealRound)`; this is not by itself proof that no durable economic authorization can be invalidated.

## Exact-head execution checkpoint (2026-10-14)

- **GREEN:** `c17dea0ca74ac0b499cf4b5f1c846e876636a907`, [GitHub Actions run 38657825715](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38657825715), job `116171691835`: database migrations, bounded unit lane, real-PostgreSQL integration lane and log upload all SUCCESS.
- **GREEN:** `857172f6b2d41f068e004e42f06b0d589b252b33`, [run 38653139351](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38653139351): V3-PG injects a **real PostgreSQL division-by-zero SQL error** inside the D→E rollback transaction, after the Dispute update and before Outcome deletion. The assertion requires original RESOLVED ruling, signature and one Outcome to survive.
- **GREEN:** `c17dea0` strengthens post-fault signed-decision replay: ruling remains RESOLVED/RELEASE, signature survives, exactly one Outcome remains, no pending exists. **This is a rejected replay under another dispatch fault, not proof of successful retry/exactly-once execution.**
- Gate 2 is therefore **PARTIAL**, not closed. The existing SQL injection is executed through the transaction's live PostgreSQL connection but intercepted at the Prisma delegate boundary. A successful recovery after removal of the fault and exact-once dispatch are still required.
- Gate 1 is **OPEN**: R1 kills a PostgreSQL backend; V3-I isolates Jest modules. Neither starts a new OS process after forcibly terminating the first.
- Gate 3 is **PARTIAL**: V3-E proves fail-closed with injected EDA/pending-loss state; production reachability and pending N+1 replacement remain unproven.
- Gate 4 is **PARTIAL**: synthetic legacy appeal N+1 coverage exists; deterministic old-catch pause across connections remains unproven.
- Gate 5 is **OPEN**: no disposable-branch behavioral mutation RED/GREEN evidence.
- Gate 6 is **GREEN for c17dea0 only** and must be repeated on final acceptance HEAD.

**Do not equate 99% implementation maturity with 6/6 acceptance gates.** This checkpoint records evidence and residual blockers without changing the merge gate.

## OS-process reconciler checkpoint (2026-10-14)

- **GREEN:** `cc5179ef60cbf65ab120624a6a73e0e82ad011dd`, [GitHub Actions run 38666051639](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38666051639). This validates R1-P: a fresh Node.js OS child, a separate Prisma connection, and the real reconciliation entrypoint against persisted PostgreSQL state.
- Earlier RED runs 38662074916, 38663058395 and 38664117043 exposed a test-output parser defect: splitting on the literal backslash-n rather than the actual newline. The parser fix is covered by the GREEN run above.
- The R1-P follow-up also asserts stable replay after the child exits. **It does not kill process A after a ruling is committed**; Gate 1 remains PARTIAL.
- `b20c132` adds child stdout/stderr diagnostics; its exact-head CI must be checked separately. No subsequent commit inherits an earlier run's GREEN status.
- Required next step: a deterministic OS-level SIGKILL of process A at a proven post-commit boundary, followed by process B's fresh Prisma pool, real reconciliation, generation/signature/Outcome preservation, and repeatable replay.

## OS SIGKILL / second-process recovery checkpoint

- **GREEN:** `522bc401ad929eb3d034d743e05dbbbf49660c7f`, [run 38669531625](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38669531625). R1-K SIGKILLs a separate Node.js process after a real ruling is durable and while the cleanup is waiting on an E advisory lock. It asserts that the ruling, pending round, Outcome, and EDA state remain intact.
- **GREEN:** `9b7c4f73648206dfb32886a6409f1810924f3ace`, [run 38673827478](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38673827478). A **second independent OS process** runs the real reconciler after SIGKILL, verifying the exact pending ID, Outcome, unchanged dispute, no EDA and ALREADY_GONE replay.
- **Remaining Gate 1 distinction:** the process killed in R1-K is the *cleanup worker*, not the *original ruling writer*. The exact required writer-process crash at the post-commit boundary remains unproven even if R1-K becomes GREEN. Do not close Gate 1 by conflating these failure windows.

## Confirmed second-process recovery (2026-10-15)

- **GREEN exact HEAD:** `9b7c4f73648206dfb32886a6409f1810924f3ace`, [workflow 38673827478](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38673827478). R1-K SIGKILLs an OS cleanup worker while PostgreSQL E-lock-blocked, then a separate OS process with a fresh module graph/Prisma connection runs the real reconciliation entrypoint. It asserts the same pending ID was deleted, subsequent replay is ALREADY_GONE, dispute and Outcome unchanged, and no EDA.
- **Scope restriction:** the original ruling was created by the Jest parent before worker startup. This is strong cleanup-crash recovery evidence, **not** a post-commit writer-process crash. Gate 1 is still PARTIAL.
- No GREEN evidence from this run is automatically transferable to a later documentation or code HEAD. Do not merge until the final SHA's full CI and remaining gates are accepted.

## Current measurable acceptance checkpoint (2026-10-15)

**Evidence-weighted engineering progress estimate: 65% (provisional, not a formal gate score).** This is an estimate of remaining adversarial verification work, **not** a measured acceptance rate; formal gate closure is **0/6** until the six cases are individually signed off. The estimate must not be extrapolated to production readiness or merge approval.

- **GREEN:** `60ff912936a97800395803f914f70220ba492d8e`, [run 38681101815](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38681101815): full reconciler replay after OS recovery is inert.
- **GREEN:** `067d2cd35d4b888755e2eed6b995f69d5aa23ebb`, [run 38684309285](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38684309285): child diagnostic capture and bounded lock wait.
- **GREEN:** `593bf42c9efe32cb9b570812b15c8a37ded8bb34`, [run 38684323205](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38684323205): watchdog cleanup.
- **IN PROGRESS at this checkpoint:** `f9b496833c9155ea94f7109d9dd0904e7745270e` [run 38687269993](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38687269993) and `3be8f68bfa7a9b4bbb0f8935eadb4cad394f2763` [run 38687283298](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38687283298). Both had successful migrations and unit lanes; PG integration was still running. These changes scope the observed waiter to the target E advisory lock and assert uniqueness.
- **No claim of Gate 1 closure:** the ruling writer was not the killed OS process. Gates 2-5 retain their documented outstanding adversarial cases; Gate 6 must be repeated on the final SHA.
- **Next acceptance order:** writer post-commit SIGKILL -> successful SQL-fault recovery -> N/N+1 interleaving -> two behavioral mutations RED -> final exact-head CI. Record failures and do not merge on a green partial subset.

## Required executable acceptance cases

1. **OS-process restart:** Process A creates a real pending ruling round and is forcibly terminated after persistence. Process B starts from a fresh module graph and a fresh Prisma pool and runs the real reconciliation entrypoint. Assert the same pending ID, same generation, same Outcome, no lost signature, no duplicate dispatch, and stable replay. Do not use Jest isolation as a substitute.
2. **Atomic fault:** Inject a database error **inside** the D→E transaction after the conditional dispute update and before Outcome deletion. Assert both the dispute and Outcome remain at their pre-transaction values. Re-run with the fault removed and prove exact-once behavior.
3. **Committed economic authorization without pending:** Construct the production-valid state or prove it unreachable under constraints. If reachable, inject dispatch failure and assert no reversal of the committed economic authority. Repeat with a replaced pending of a different generation. Any unproven state must fail closed.
4. **Generation N/N+1:** Deterministically pause the old catch before its D lock, advance appeal to N+1 on another connection, then release. Assert the old catch cannot revert or delete the newer dispute or Outcome.
5. **Mutation sensitivity:** On disposable branches, remove the exact-generation guard and separately split Outcome deletion outside the transaction. Each mutation must produce a meaningful failing assertion (RED), while the unchanged implementation passes (GREEN). Compile failures are not behavioral RED evidence.
6. **Regression and exact-head CI:** Run unit + complete real-Postgres integration lanes, including cooperative RACE-B/L/L2, security preflight and the ST1 suite. Record the exact branch HEAD SHA, workflow run ID, failed/passed counts, and any residual finding.

## Newly verified fixture limitation (2026-10-14)

The ST1 integration fixture `makeAppealable()` deliberately bypasses a PostgreSQL trigger using `SET LOCAL session_replication_role = replica` and removes the script-committed arbiter key. Its own source comment explains that a newly created production MULTISIG escrow normally has an immutable arbiter commitment, so `appeal()` cannot reach N+1 on that production path today. **V3-G proves the conditional cleanup guard against an artificially reachable historical/legacy state, not that ordinary production MULTISIG appeal can reach that state.** Keep this distinction in the audit; do not remove the fixture because legacy or migrated state still merits defensive proof.

The R1 case terminates a PostgreSQL backend holding a lock, whereas V3-I uses `jest.isolateModules()`. Neither is an OS-process restart of the full reconciler. The missing process-level proof remains a separate release gate.

## Mandatory gate

Do not merge PR #436, close #453, or claim 100% until all six items have reproducible evidence, with no weakened tests or bypassed preflight. Any finding must be documented with severity, reproducer, owner and disposition.

NO MATERIAL FINDING UNDER THE RUG.
