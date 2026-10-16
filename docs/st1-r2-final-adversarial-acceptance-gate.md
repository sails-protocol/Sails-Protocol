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

## Target-lock and active-backend evidence checkpoint (2026-10-15)

- `f9b496833c9155ea94f7109d9dd0904e7745270e`, [run 38687269993](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38687269993): migrations, unit tests, real-PostgreSQL integration, and log upload individually succeeded; workflow overall was still reported **in_progress** at inspection. Do not label overall GREEN until completed.
- `3be8f68bfa7a9b4bbb0f8935eadb4cad394f2763`, [run 38687283298](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38687283298): migrations/unit GREEN, integration still running at inspection. Target E-lock waiter count assertion added.
- `2b8812884a8c434cf2b8742b3b6a131ddd472e5b`, [run 38688636312](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38688636312): migrations GREEN, unit in progress at inspection.
- `28484f76cfd6d51c038b6282c4941f5da14b5457`: additionally requires the target waiter PID to be present as an active `pg_stat_activity` backend before SIGKILL. **This does not establish that the backend belongs to the child OS process**; there is no child-to-backend PID correlation in the test. Do not overclaim identity or Gate 1 completion.
- Formal gate score remains **0/6**; engineering progress estimate **65%**, provisional and unchanged.

## Exact-head CI recovery and current boundary (2026-10-15)

- **GREEN:** `948af31b4758e9b09af718be9d856bc21c7e8f7d`, [workflow #38750655417](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38750655417), rerun of failed jobs completed SUCCESS. The initial attempt failed in `tests/integration/docker.test.ts` during Docker image `npm ci --ignore-scripts`; the available logs do not establish its root cause. Do not classify it as an ST1 logic failure or assume an external registry outage without evidence.
- **GREEN:** `396cd1893e34e0c8e177b136bea0bb8a21f42947`, [workflow #38742610103](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38742610103): V3-OS recovery through two separate fresh Node OS processes after an **in-process simulated post-persist writer exception**. Exact pending identity, generation, authority signature, Outcome count and unchanged parent dispute are asserted in subsequent HEADs.
- **Boundary:** neither V3-OS nor R1-K kills the **actual writer OS process** after it commits the ruling. Gate 1 remains OPEN. Do not count independent reconciler processes as the writer crash.
- **Boundary:** V3-PG proves SQL rollback and rejected replay. The public `resolveDispute` endpoint intentionally rejects already RESOLVED disputes, so a second call is not a successful dispatch retry. Gate 2 remains OPEN until a valid recovery path is proven.
- **Boundary:** the V3-GR D-lock test currently releases the lock **before** the appeal, so it cannot prove appeal N+1 wins the old catch race. Gate 4 remains OPEN.
- **Formal gate closure: 0/6.** PR #436 remains DRAFT, NO MERGE, NO FREEZE. Next implementation must target a missing adversarial case, not add redundant assertions or cosmetic test comments.

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

## Writer SIGKILL and deterministic N/N+1 checkpoint (2026-10-15)

- **GREEN:** `4261e4490498a79635f7adbd2f0a7b426024280f`, [workflow #38796336315](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38796336315), completed SUCCESS. V3-WK launches the actual ruling writer in a separate Node OS process, waits for the persisted pending marker, SIGKILLs the writer, then runs recovery in two independent OS processes. The test checks stable pending identity/generation, Outcome, unsigned round, no EDA and no duplicate pending. **This is strong Gate 1 evidence**, subject to formal gate-by-gate review and final exact-head CI.
- **IN PROGRESS when inspected:** `aff32618fb292028f709e81f428e65bc0e025e14`, [workflow #38798462004](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38798462004). V3-GI queues a production appeal ahead of stale N cleanup while both wait on economic D, then checks the old cleanup rejects the superseded generation and preserves pending, dispute, Outcome and EDA count. Do not count this test as GREEN until the run completes.
- **Scope limitation:** V3-GI uses the test-only `makeAppealable` legacy fixture; it does not prove that a new script-committed MULTISIG escrow can appeal. The production appeal path explicitly rejects immutable committed-arbiter identity.
- **Unclosed:** Gate 2 successful recovery/exactly-once dispatch, Gate 3 production reachability, Gate 5 two isolated behavioral mutations RED, and Gate 6 final HEAD CI. Formal acceptance stays **0/6** pending sign-off; PR #436 stays DRAFT, NO MERGE, NO FREEZE.

## Gate 5 mutation execution checkpoint (2026-10-15)

Two intentionally broken implementations are isolated from PR #436:

1. `experiment/st1-r2-mutation-remove-generation-guard` at `cb2152247a3386bd2c208ca7323862ccef815907`: disables the live dispute appeal-round comparison in `deletePendingRoundIfStillUnsigned`. This is only one of several guards, so an unchanged GREEN suite would not by itself prove mutation sensitivity.
2. `experiment/st1-r2-mutation-outcome-outside-transaction` at `b5187b94b8df2c711843c787e74d83e08bb18445`: replaces the transaction-scoped Outcome deletion with a root Prisma client deletion inside the interactive transaction callback, deliberately breaking the atomicity invariant and potentially causing lock contention.

**Execution evidence is absent:** no pull-request-triggered GitHub Actions runs were returned for either mutation SHA. Branch creation and code mutation do not count as behavioral RED. Do not close Gate 5 or claim a passing baseline comparison until both mutations are executed with captured failures and the unchanged implementation's equivalent suite passes. Run mutations only in disposable branches; never merge their commits into the acceptance branch.

### Mutation A observed RED (2026-10-15)

Disposable PR [#476](https://github.com/sails-protocol/Sails-Protocol/pull/476), SHA `cb2152247a3386bd2c208ca7323862ccef815907`, workflow [38804688317](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38804688317), completed FAILURE. `tests/disputePendingReconciliation.test.ts` fails its assertion that a moved dispute generation must be reported and never deleted: expected a `pending ruling generation no longer authorizes cleanup` error, received `[]`. Unit result: 191 suites passed, 1 failed; 3006 tests passed, 1 failed. This is behavioral RED from removal of live `appealRound` guard, not a compilation failure. Gate 5 remains OPEN until mutation B is behaviorally killed and unchanged exact-head GREEN is established. Never merge experiment PRs.

### Mutation B observed RED (2026-10-15)

Disposable PR [#477](https://github.com/sails-protocol/Sails-Protocol/pull/477), SHA `b5187b94b8df2c711843c787e74d83e08bb18445`, [workflow 38804700194](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38804700194), completed FAILURE in real-PostgreSQL integration. `tests/integration/st1TemporalCleanupAuthority.test.ts` failed V3-A and V3-PG: expected injected `atomic Outcome deletion failure` and `division by zero` respectively, but both received the original dispatch error. Integration result: 84 suites passed, 1 failed; 1155 tests passed, 2 failed. Mutation uses root `prisma.semanticTransitionRecord.deleteMany` outside the transaction delegate, so the fault hooks at the transactional Outcome deletion boundary were bypassed. This is test sensitivity to the mutation, **not** proof of an actual improper economic deletion or of the intended atomicity safety property under the mutant. Gate 5 remains OPEN pending unchanged exact-head GREEN and adversarial assessment of whether the mutation's RED constitutes a sufficiently strong behavioral kill.

### Baseline retry GREEN and mutation comparison (2026-10-15)

- Unchanged baseline `e3668e4ce601900f2c9faf77c64b3e920e33a244`, [workflow 38803309121](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38803309121), latest failed-job rerun job `116663972394` **SUCCESS**. Original attempt job `116657640244` failed during Docker `npm ci --ignore-scripts` (exit 152); this is a retry GREEN, not a clean first-attempt GREEN.
- Mutation A [#476](https://github.com/sails-protocol/Sails-Protocol/pull/476), workflow 38804688317: behaviorally RED in `disputePendingReconciliation.test.ts` after removing the live generation guard.
- Mutation B [#477](https://github.com/sails-protocol/Sails-Protocol/pull/477), workflow 38804700194: RED in V3-A/V3-PG because the root-client Outcome delete bypassed transaction-scoped fault injection. This does not independently demonstrate an actual improper deletion; review strength of kill before formal acceptance.
- Both experiment PRs must remain unmerged. Latest documentation HEAD requires its own CI; no earlier SHA's GREEN can certify it. Gate 5 still awaits signoff on mutation B evidence; Gate 6 awaits final exact-head GREEN and remaining adversarial gates.

### Exact-head CI checkpoint (2026-10-15)

- **GREEN:** documentation HEAD `fcdedf5030f6beb83f2ded6838bcab9f4adadbe5`, [workflow 38810022974](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38810022974), job `116680608327` completed SUCCESS, including real-PostgreSQL integration. This validates that HEAD only; it does not close the outstanding adversarial acceptance gates.
- The mutation comparison now has unchanged GREEN at `fcdedf5`, mutation A behavioral RED at `cb21522`, and mutation B RED at `b5187b9` with the previously documented transaction-delegate fault-hook limitation. Keep both experimental PRs DRAFT/unmerged and require independent Gate 5 review.
- Gate 6 is not closed: final exact-head CI must run again after all acceptance changes and gates 1–5 signoff. **NO MERGE / NO FREEZE.**

### Gate 2 recovery API distinction and Gate 3 reachability checkpoint (2026-10-15)

- Inspected `tests/integration/st1TemporalCleanupAuthority.test.ts` V3-A/V3-PG: both fault-inject at the transactional Outcome delete boundary and verify RESOLVED/signature/Outcome survive. The subsequent `resolveDispute` call is **rejected** because the dispute remains RESOLVED; it is not a successful recovery or exactly-once economic dispatch. Do not close Gate 2 using this replay.
- V3-E invokes real `initiateRelease` and persists EDA, but deliberately deletes the pending row via direct test Prisma injection. That establishes fail-closed behavior for an adversarial state, **not** a production-reachable loss of pending. Gate 3 requires identifying a normal production code path or proving impossibility under the actual lifecycle and database constraints.
- Gate 2 acceptance must name and invoke a legitimate persisted-ruling recovery entrypoint with fault removed, then assert exactly-once economic authorization/dispatch under fresh process/connection and replay; if none exists, record a design gap rather than fabricating successful retry.
- Exact-head CI for `a77dcd4` was still in progress when inspected ([workflow 38813892789](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38813892789)); no GREEN claim until completion.

### Recovery-path code inspection (2026-10-15)

- Inspected `src/modules/open-settlement/dispute-pending-reconciliation.ts`: `deletePendingRoundIfStillUnsigned()` is a guarded **cleanup** operation for an existing unsigned pending, with dispute/escrow locks and generation/Outcome/EDA checks. It is not an entrypoint to re-dispatch a persisted RESOLVED ruling with **no** pending after the D→E SQL fault.
- The reconciler's documented `GUARD_PASSED` behavior preserves a legitimate unsigned pending awaiting signatures; it does not manufacture a missing pending. Consequently, V3-PG's post-fault `pending=null` state is **not** recovered by this cleanup API. A separate safe replay/re-dispatch design or proof that this state must remain operator-review-only is required before Gate 2 can close.
- No production change authorized by this inspection. Do not mislabel a rejected `resolveDispute` replay or a cleanup-only reconciliation as successful economic recovery.

### Gate 3 production guard inspection (2026-10-15)

- Inspected `src/modules/open-settlement/dispute.service.ts` catch path: after acquiring advisory D then E locks, it queries `tx.economicDispositionAuthorization.findFirst({ where: { escrowId } })` **before** any conditional dispute rollback or Outcome deletion. If any committed escrow-wide EDA exists, it returns `false`, and `St1R2DeletionRefused` preserves durable authority even if pending is absent or replaced. The check is conservative across generations.
- If no EDA exists, it checks the exact pending ruling provenance (`disputeId`, `rulingAppealRound`, `rulingArbiterId`, `rulingOutcome`, `rulingAuthoritySignature`, `rulingAuthorityIssuedAt`) before permitting conditional rollback. This is a code-level fail-closed guard, **not** a proof that pending loss is production-reachable or unreachable.
- Remaining Gate 3 evidence: enumerate normal pending deletion/replacement call sites and establish their lock/EDA ordering under concurrency and crash; test a reachable path or prove its exclusion. No claim of Gate 3 closure.

### Gate 2 correction: existing C4 dispatch recovery found (2026-10-15)

- **Correction to earlier inspection:** `dispute-pending-reconciliation.ts` is cleanup-only, **but a separate production module already exists**: `src/modules/open-settlement/dispute-dispatch-recovery.ts` (M9-R). Its header explicitly covers C4: committed RESOLVED ruling and Outcome, nonterminal MULTISIG escrow, **no pending** after writer crash. It reuses real `escrowService.initiateRelease/Refund/Split` from immutable stored Outcome and historical destination binding; it does not ask the arbiter to sign again. Existing pending uniqueness and escrow lock handle concurrent workers.
- Therefore the previous wording suggesting that the codebase has no missing-pending recovery mechanism was incomplete. Gate 2 must test **this actual production recovery entrypoint** after V3-PG SQL fault, assert recovery candidate eligibility, one pending and unchanged signed authority/Outcome, repeat reconciliation inert, no duplicate EDA/dispatch, including fresh OS process if applicable.
- Production `escrowPendingTransaction.delete` sites also exist in `escrow-pending-tx.ts` and `escrow-settlement-reconciliation.service.ts`; `dispute-dispatch-recovery.ts` has guard-failure deleteMany. Their EDA/lock/generation semantics require path-specific audit for Gate 3, not a blanket unreachable claim.
- This is an inspection correction, **not** a passing Gate 2 test. No production changes and no gate closure.

### Gate 2 C4 recovery evidence (2026-10-15, exact-head)

- Real PostgreSQL test `V3-PG` in `tests/integration/st1TemporalCleanupAuthority.test.ts` now injects SQLSTATE 22012 at the Outcome-delete boundary of the D→E catch, verifies transactional rollback preserves the signed RESOLVED ruling and its one Outcome with no pending, and invokes the **production** `reconcileMissingDispatch(100)` entrypoint after removing the fault.
- Recovery creates a pending with the same dispute and appeal generation, preserves the signed ruling and one Outcome, and leaves EDA count zero (unsigned round, no economic execution authority committed). A public `resolveDispute` replay remains rejected and must preserve the recovered pending.
- Two simultaneous recovery invocations before pending creation are tested: exactly one reports a resumed dispatch, and exactly one pending persists. Two more simultaneous recovery invocations after creation are inert and leave the same pending id and Outcome.
- Exact-head GitHub Actions: [`fdbb08a` workflow 38825209164](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38825209164) **SUCCESS**; [`96070b3` workflow 38825434596](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38825434596) **SUCCESS**, including PostgreSQL integration.
- **Scope limitation:** this is same-process concurrency against real PostgreSQL, not a fresh OS-process C4 crash/recovery proof. Gate 2 still requires a separate process/connection replay and a reviewer signoff. No formal gate closure, merge, or freeze from these results alone.

### Gate 3 pending-deletion lifecycle inventory (2026-10-15)

- `escrow-pending-tx.ts` **supersession**: inside `withEscrowFundingLock(escrowId, tx => ...)`, the existing pending is loaded with signatures, `assertSupersedableByThisDispatch(current, arbitratedDispatch, escrowId)` is called, and only then `tx.escrowPendingTransaction.delete({id})` and replacement `create` execute in the **same** transaction. Must still inspect the supersession predicate for signed/economic-authorized rounds; do not equate escrow-only lock with D→E ordering.
- `escrow-pending-tx.ts` **completed settlement**: pending delete occurs after successful finalization and `emitEscrowTransition`; it is skipped on failed fee recording. A legitimate terminal settlement can therefore have EDA and no pending; the catch's escrow-wide EDA check is necessary.
- `escrow-settlement-reconciliation.service.ts` **completion/fee recovery**: pending deletes occur after completion projection/correspondence or after durable fee-evidence convergence; these are terminal/reconciliation paths, not automatically evidence of an unsafe deletion during an active ruling.
- `dispute-dispatch-recovery.ts` **guard failure**: current branch delegates pending deletion to `deletePendingRoundIfStillUnsigned(pending.id, escrowId, generation)`, which revalidates generation/Outcome/EDA under D→E locks. Do not rely on older default-branch search snippets showing unguarded `deleteMany`.
- This is an inspection inventory, not yet a concurrency proof or a formal Gate 3 acceptance. Next: check `assertSupersedableByThisDispatch` and all EDA commits against deletion ordering, then test a production-reachable adversarial interleaving.

### Gate 3 supersession predicate inspection (2026-10-15)

- The production `assertSupersedableByThisDispatch()` in `escrow-pending-tx.ts` rejects replacement unless the new dispatch is arbitrated **and** the current pending has `disputeId === null` (cooperative). It rejects fully signed rounds via `blocksRulingDispatch(current)`, and rejects legacy partial rounds lacking signature confidentiality via `isSupersedableByRuling(current)`. Only a confidential, incomplete cooperative round can be replaced, in the same `withEscrowFundingLock` transaction that deletes and creates the pending.
- Consequently this production supersession path does **not** normally delete a pending already bound to an arbitrated ruling; it cannot by itself demonstrate a lost arbitrated pending after committed EDA. This is a code-path exclusion, **not** a proof against all races or direct settlement cleanup.
- Gate 3 still needs the escrow-wide EDA lifecycle and lock-order audit, with a PostgreSQL test of a reachable concurrent interleaving. Keep REVIEW REQUIRED / NO MERGE.

### Gate 2 exact-head verification and Gate 3 escrow-wide authority check (2026-10-15)

- Exact-head CI `add6bcb` [workflow 38829746705](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38829746705) completed **SUCCESS**, including PostgreSQL integration. This verifies the fresh OS-process C4 **replay after initial recovery**, not first recovery by a new process after the writer crash. The stronger crash-to-first-recovery scenario remains open.
- Exact-head CI `33ca473` [workflow 38833168476](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38833168476) completed **SUCCESS**. These results do not constitute gatekeeper signoff.
- Re-inspected D→E catch in `dispute.service.ts`: after D and escrow advisory locks, it queries `economicDispositionAuthorization.findFirst({ where: { escrowId } })` before `dispute.updateMany` and Outcome deletion. This escrow-wide check does **not** depend on the current pending id or appeal generation, which is essential when a completed pending has already been removed. It is conservative for N/N+1.
- The normal settlement completion and reconciliation paths can remove pending after completion; supersession explicitly excludes arbitrated pending. This supports the necessity of the EDA guard but does not establish the reachable nonterminal lost-pending state required by Gate 3. Do not assert production impossibility until the EDA write/commit lifecycle and lock ordering have been proven.

### Gate 3 EDA commit source audit (2026-10-15)

- Located the actual production EDA writer: `src/modules/open-settlement/economic-disposition-authority.ts`, `authorizeDisputedPendingExecution(pending)`. It calculates `economicDispositionOperationDigest` over pending id, escrow, economic operation and signed ruling-generation provenance, then uses a **PostgreSQL transaction**.
- Within that transaction it first acquires `pg_advisory_xact_lock(hashtext(economicDispositionLockKey(disputeId)))`, the same dispute-level authority lock used by D→E catch and appeal/ruling transitions. It looks up an existing EDA by `pendingOperationId` and permits reuse only with exact escrow, dispute and digest match. For a first commit, it reads the live dispute and requires RESOLVED status, exact appeal round, arbiter, ruling and authority signature before `economicDispositionAuthorization.create`.
- D→E catch takes this **D lock before E lock**, and checks for **any** committed EDA by escrow before changing the ruling or deleting Outcome. The writer's D lock serializes a first EDA commit against rollback of that ruling; if EDA wins, rollback must observe it and refuse. If rollback wins, the EDA writer's live-generation check must reject the stale pending. This is a lock-order argument, **not yet** an adversarial PostgreSQL interleaving proof.
- EDA reuse intentionally survives later appeal and pending cleanup, bound to the exact operation digest. Cooperative pending without provenance returns null only when no historical dispute exists, except a fully signed bilateral round frozen before dispute. These paths do not create an EDA and should not be confused with an arbitrated authorization.
- Remaining Gate 3: instrument a real concurrent first EDA commit versus D→E catch and assert both winning orders under PostgreSQL, plus validate pending-deletion lifecycle. Do not mark Gate 3 accepted.

### Gate 3 test-coverage distinction (2026-10-15)

- Existing `V3-E` exercises **EDA committed before injected dispatch failure**, with an artificially deleted pending, and now asserts the exact committed EDA record/digest survives reconciliation. It is **not** a naturally occurring pending deletion and does not race the EDA writer against the rollback catch.
- Existing `V3-N` exercises **dispatch failure before pending persistence**, followed by rollback of ruling and Outcome, but there is **no competing EDA writer**. It is not the reverse ordering of a real EDA/rollback concurrency race.
- A valid Gate 3 concurrency proof must use the real `authorizeDisputedPendingExecution()` and real `resolveDispute()` catch with a durable pending and controlled advisory D-lock ordering, not just concurrent promises or a fabricated EDA row. Assert both possible serializations: (1) EDA commits first, catch preserves ruling and Outcome; (2) rollback commits first, first EDA authorization refuses the now-stale generation. Verify EDA count, pending generation, ruling signature and Outcome count in both cases.
- **Practical caveat:** the normal `resolveDispute()` catch only rolls back when the dispatch has not durably persisted its own exact pending. Creating an authentic competing EDA writer while meeting that precondition may be unreachable in normal production. If so, prove exclusion from real call paths and database constraints rather than force an impossible state into a test. Keep Gate 3 REVIEW REQUIRED.

### Gate 3 reachability checkpoint (2026-10-15)

- Re-read the real MULTISIG dispatch in `dispute.service.ts`: the ruling write commits first, then `escrowService.initiateRelease/Refund/Split` persists the arbitrated pending; only an exception enters the D→E rollback catch. In that catch, an exact-generation pending **blocks** rollback, and any committed escrow-wide EDA independently **blocks** rollback.
- Real `authorizeDisputedPendingExecution(pending)` requires an existing pending carrying its ruling provenance, and commits EDA under the same dispute D lock. Therefore an ordinary first EDA writer for this ruling cannot race with a rollback that is eligible to delete that ruling: if its pending is still present, rollback must refuse; if pending is absent, that writer has no normal new operation to authorize. The injected V3-E deletion models the exceptional historical-authority case and confirms the escrow-wide guard.
- This is a **conditional reachability argument**, not a complete proof: pending can be removed by settlement completion/reconciliation and must be checked for races with the rollback catch; legacy/direct cleanup paths and any asynchronous pending readers must also be excluded. Do not manufacture an impossible simultaneous first EDA write + eligible rollback test merely to satisfy a checklist. Keep Gate 3 open pending path-complete evidence and review.
