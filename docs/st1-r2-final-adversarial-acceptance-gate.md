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

### Gate 3 terminal pending deletion lifecycle audit (2026-10-15)

- `escrow-pending-tx.ts` replaces an incomplete cooperative pending only inside `withEscrowFundingLock` after `assertSupersedableByThisDispatch`; the same transaction creates the arbitrated replacement. This is **not** a generic arbitrated pending deletion.
- `escrow-pending-tx.ts` normal completion calls `emitEscrowTransition` before best-effort `escrowPendingTransaction.delete({id:pending.id})`; deletion is skipped on fee-recording failure. Thus removal follows settlement completion, but the transition and deletion are not proven atomic by this excerpt.
- `escrow-settlement-reconciliation.service.ts` completion-effects recovery records correspondence before best-effort pending deletion, and defers deletion when fee evidence is missing. Separate fee-recovery path deletes only after `recordBroadcastAndAdvance` succeeds.
- The EDA is keyed by pending operation and remains durable after pending deletion; D→E catch checks EDA escrow-wide. **Residual audit required:** prove escrow terminalization excludes a stale `resolveDispute()` rollback and inspect asynchronous readers that can commit EDA after a pending has been removed. No Gate 3 signoff yet.

### Gate 3 residual: escrow terminal status not read by D→E catch (2026-10-15)

- Inspected the entire D→E catch transaction in `dispute.service.ts`. It acquires dispute D then escrow E advisory locks, reads current pending, checks any escrow-wide EDA, checks exact-generation pending, conditionally updates the dispute, and deletes the generation-scoped Outcome. **It does not explicitly read or require a nonterminal escrow status.**
- Terminal pending cleanup in `escrow-pending-tx.ts` and settlement reconciliation is best-effort and can leave no pending; therefore **absence of pending alone is not evidence that settlement did not occur**. The existing EDA guard protects arbitrated execution when EDA was committed, but the current catch does not independently establish terminal exclusion for other settlement rails or historical/legacy paths.
- This is a **review finding, not yet a proven exploitable interleaving**: verify whether all settlement paths capable of terminalizing this escrow necessarily commit EDA before effects and whether the D→E catch can execute afterward. If not universally provable, add a conditional escrow-terminal-status guard under the existing D→E locks with PostgreSQL regression coverage. Do not silently mark Gate 3 safe.

### Gate 3 terminal-state finding correction: existing MOOT restoration (2026-10-15)

- **Correction to the preceding checkpoint:** `dispute.service.ts` already has `rulingRevertTarget(tx, escrowId, displacedStatus)`, invoked in the D→E catch under escrow E lock. For `OPENED`, `EVIDENCE_SUBMITTED`, `ARBITRATED`, `AUTO_PROPOSED` displaced statuses it checks a durable `escrowEvent` with terminal `toStatus` in `COMPLETED/REFUNDED/SPLIT` and restores `MOOT` with `mootedByTransitionId` when present. It deliberately leaves displaced `APPEALED` unchanged. Earlier wording that the catch had no terminal-state awareness was incomplete.
- **Residual distinction:** this helper changes the *restored dispute status*, but the outer D→E transaction still conditionally clears ruling/authority and deletes the generation-scoped Outcome after the helper returns. It is not itself a fail-closed terminal **exclusion**. The escrow-wide EDA guard remains the decisive protection for previously authorized disputed execution.
- Gate 3 must establish whether any terminal transition lacking a durable EDA could race with the dispatch catch, and whether removing that ruling's Outcome is legal in that case. Do not conflate MOOT semantics with preserved ruling authority. Review required; no merge.

### Gate 3 MOOT/Outcome regression specification (2026-10-15)

- The existing PostgreSQL `V3-N` case proves a no-persist dispatch exception restores the pre-ruling status and deletes Outcome when **no terminal transition** exists. It does not prove the terminal/MOOT branch of `rulingRevertTarget()`.
- Required positive case: create a genuine terminal `escrowEvent` through the production settlement transition (not a fabricated direct row), then induce the in-flight dispatch failure. Check whether the terminal transition can coexist with missing EDA, whether the catch restores `MOOT`, and whether deleting the ruling Outcome is permissible. Assert `mootedByTransitionId` equals the actual event id, ruling/authority signature and Outcome count, and terminal escrow status.
- Required protected case: EDA already committed for the arbitrated pending and terminal completion removes that pending. The outer dispatch catch must reject rollback and preserve RESOLVED ruling, signed authority, EDA digest and Outcome, even though pending is absent. Existing `V3-E` tests EDA + injected pending deletion but **not terminal completion**.
- If production completion necessarily commits EDA, an EDA-less terminal scenario must be explicitly classified unreachable and supported by call-path evidence, not treated as an expected valid rollback. No invented terminal event, no gate approval based on mock-only proof.

### Gate 3 execution ordering: authorization precedes provider effect (2026-10-15)

- In `escrow-pending-tx.ts` production pending-finalization path, `await authorizeDisputedPendingExecution(pending)` executes before `authorizePendingExecution(pending)`, the atomic execution claim, and any provider-side effect. The EDA function commits a durable authorization under dispute D lock for a disputed pending; this is the actual ordering protecting a normal arbitrated MULTISIG settlement.
- After provider finalization, `emitEscrowTransition` runs before best-effort pending deletion. Thus for this path an arbitrated terminal transition must be preceded by a committed EDA; missing pending after terminalization is not grounds for D→E rollback. The escrow-wide EDA guard is designed for precisely this case.
- Scope limit: this verifies the pending-finalization path only. Other rails and direct `releaseFunds/refundFunds/splitFunds` paths still require separate authority/terminal-event audit; do not generalize this ordering to all escrows. Gate 3 remains open.

### Gate 3 direct-settlement rail split (2026-10-15)

- Audited production `escrow.service.ts` direct `releaseFunds()`, `refundFunds()`, and `splitFunds()`. Each validates the transition and capabilities and calls `claimEscrowTransition` **before** the side-effecting provider. WDK uses its outbound authority plan/failure handling. None of these direct methods calls `authorizeDisputedPendingExecution()`, because no signed pending PSBT is involved.
- `dispute.service.ts` dispatch selects direct settlement when `needsSignatureCollection` is false, passing disputeId as event provenance for direct RELEASE/REFUND; SPLIT uses the direct method without a disputeId parameter. These rails therefore **cannot be declared protected by the pending-operation EDA proof**.
- For direct rails, the critical proof is whether an irreversible or uncertain provider side effect can be followed by a thrown error that reaches D→E catch and removes ruling/Outcome, despite a claimed or terminal escrow transition. `claimEscrowTransition` and `revertEscrowStatus` must be inspected for unknown-outcome semantics, and `rulingRevertTarget` only consults terminal escrow events for MOOT restoration, not an explicit prohibition on authority deletion.
- **Gate 3 review finding:** direct-rail dispatch failure after provider side effect needs independent fail-closed regression coverage. Do not infer the EDA safety guarantee applies to direct rails. No merge until analyzed.

### Gate 3 direct-rail post-provider uncertainty checkpoint (2026-10-15)

- `escrow-lifecycle.ts` `claimEscrowTransition` performs a conditional DB claim before provider side effects; for direct execution it freezes the requested disposition via `claimDirectExecution`. A conflicting claim is refused. `revertEscrowStatus` delegates to ownership-sensitive `escrowRepository.revertStatus`, but its call sites in `escrow.service.ts` use it after a provider throws (non-WDK rails), which by itself does **not** prove that no external effect happened.
- `settlementSucceededButLocalStepFailed` explicitly preserves the claimed terminal state after the provider **returns success** but local persistence/event publishing fails. This prevents one class of rollback; it does not establish the handling of a provider that moves funds and then throws with an unknown outcome.
- WDK direct calls take a distinct `wdkOutboundFailure` path, requiring separate durable outbound-authority review. Non-WDK direct paths can call `revertEscrowStatus` on provider exceptions, then propagate to `dispute.service.ts` D→E catch. This is a concrete **unknown-outcome risk surface** requiring fail-closed evidence, not a demonstrated exploit.
- Next acceptance evidence: inspect provider-specific failure semantics, claim/revert durable authority and status transitions, and write a real-DB test where a direct provider throws after a simulated irreversible effect. Assert no unsafe ruling/Outcome rollback or duplicate economic execution. Do not approve Gate 3 on pending-EDA tests alone.

### Gate 3 concrete direct-rail unknown-outcome authority hazard (2026-10-15)

**Code-confirmed, not yet reproduced:** `escrow-repository.ts` `claimDirectExecution()` persists the arbitrated intent (`arbitratedDisposition`, optional `splitBuyerBps`, `arbitratedTriggeredBy`) and atomically changes status before provider execution. However, `revertStatus()` on provider exception checks **only** `{id, status: claimedStatus}` and resets status, leaving frozen intent fields. `escrow-lifecycle.ts` `revertEscrowStatus()` swallows revert failures. For non-WDK direct RELEASE/REFUND/SPLIT, `escrow.service.ts` catches any provider exception, calls this revert, and rethrows. The `dispute.service.ts` D→E catch can then remove the ruling and Outcome when no pending or EDA exists; the direct path does not create pending EDA. The frozen intent alone is not a D→E rollback exclusion in the inspected catch.

**Hazard:** a provider that executed externally but throws (timeout/unknown result) can leave a reverted escrow status and a removed signed ruling/Outcome while irreversible funds movement has occurred. The atomic status claim protects against simultaneous double dispatch but **does not** establish provider-outcome certainty. This requires a real-DB injected unknown-outcome test and explicit fail-closed policy for direct settlement. Do not fix by indiscriminately treating all provider exceptions as success; retain claimed/uncertain authority and reconcile or quarantine until outcome is proven.

**Gate status: BLOCKED.** No declaration of exploitability or provider behavior without targeted reproduction and provider-specific review. No merge/freeze.

### Gate 3 regression acceptance matrix for direct unknown outcomes (2026-10-15)

The next code change must include real-PostgreSQL tests, not merely documentation:

1. **Unknown provider outcome:** direct arbitrated release/refund/split claims the frozen intent, provider simulates an externally executed transfer then throws. Require durable uncertainty and preservation of the exact signed ruling, authority signature, and Outcome. No fresh divergent economic dispatch.
2. **Proven no-effect rejection:** provider fails before any side effect with positive no-effect evidence. Only then may the exact ruling and Outcome be reverted atomically, preserving generation fencing and concurrent-worker safety.
3. **Success then local failure:** provider returns success, result/event persistence fails. Preserve the terminal claim and ruling/Outcome for reconciliation; do not retry provider.
4. **Concurrent recovery/retry:** two workers and a fresh process must not execute a second transfer while the first outcome is unknown; test exact persisted claim and frozen disposition.
5. **Rail scope:** MULTISIG pending/EDA is not evidence for direct MOCK/WDK/other rails. Identify actual production-supported direct providers and their exception/outbound authority contracts before declaring coverage.

**Acceptance:** tests must initially expose any current unsafe behavior and then pass after a minimal, reviewed fail-closed implementation. Do not weaken assertions to match unsafe current behavior. Do not approve Gate 3 or merge merely because CI is green.

### Gate 3 routing correction: legacy direct rails do not use the Core D→E catch (2026-10-15)

Source inspection of `dispute.service.ts` establishes **two different ruling implementations**:

- `applyRulingCoreAuthoritative()` is used for MULTISIG and owns the ST1-R2 D→E rollback with semantic Outcome deletion, pending-round/EDA checks, and D/E locks.
- Legacy `applyRuling()` is still used for LIGHTNING_HODL, SAFE_GUARD_EVM, MOCK, and WDK_USDT_EVM (per the source's own M8-R2 scope comment). It commits a ruling then calls direct `escrowService.releaseFunds/refundFunds/splitFunds` on non-signature rails. Its exception handler performs a generation-conditional `dispute.updateMany` rollback under D lock, **without the Core path's pending/EDA checks and without its semantic Outcome delete**.

**Correction to prior risk wording:** the direct-rail exception does **not** enter the Core D→E catch. The possible authority loss remains serious but is a *separate legacy rollback path*, and the semantic Outcome deletion claimed for that path was not supported by the inspected source. A test must inspect its actual persisted semantic records rather than assume they mirror Core.

The direct provider's `claimDirectExecution` freezes intent; on exception, non-WDK paths invoke status-only `revertStatus` and then legacy `applyRuling()` may clear the signed ruling even if the external provider outcome was uncertain. Investigate the legacy rollback and the direct-rail result ledger as an independent security finding; do not patch Core D→E expecting to cover this path.

### Gate 3 CI checkpoint and remaining acceptance (2026-10-16)

- Exact HEAD `0150953986ac50b3756f16c54677d5c8503a64c0`: CI run `38856840845` completed SUCCESS, including unit and PostgreSQL integration steps. Previous HEADs `163dd04c` and `7bf0f30b` also completed SUCCESS in both lanes. This is CI evidence, **not** acceptance of the full adversarial matrix.
- `V3-DIRECT` tests now cover a MOCK provider exception after a direct claim, terminal uncertainty quarantine, no fabricated receipt, rejected retry, SPLIT frozen 5000 bps, rejected changed 6000 bps, and seller rejection before an assigned-arbiter SPLIT. `settlementResultIntegrity` also asserts rejected RELEASE retry after unknown provider exception.
- Source reinspection of legacy `dispute.service.ts` `applyRuling()` confirms `directDispatchAttempted = true` is set immediately before each direct RELEASE/REFUND/SPLIT call. The catch rethrows without reverting the signed dispute ruling if direct dispatch was attempted. This is a separate guard from Core D→E and must be independently regression-tested with real signed authority and Outcome persistence.
- Still unproven: injected direct provider side effect followed by thrown error with exact signed ruling/Outcome survival; independently evidenced provider no-effect rollback; two-process restart and concurrency against an uncertain provider; production-rail-specific WDK/provider semantics; Gate 4 exact interleaving and Gate 5 mutant RED/GREEN. MOCK is never Day 0 evidence.
- Formal gates remain unaccepted pending their own reproducible proofs. **NO MERGE / NO FREEZE**.

### Gate 5 mutation experiment: generation guard, interpretation boundary (2026-10-16)

- Disposable branch `gatekeeper/st1-r2-mutant-generation-guard-red`, draft PR #478, mutant commit `0ea21d32c13e623c61ddf2257916bcecd0a68061`, removes only the comparison `dispute.appealRound !== generation.rulingAppealRound` in `deletePendingRoundIfStillUnsigned`. Original baseline `7485e9c1cad423262a86796a22d5fff3c792f849` remains untouched.
- Mutant workflow #38923304506 and baseline workflow #38922867575 were still in progress at observation. **No RED/GREEN claim yet.** The experiment must never be merged.
- Interpretation caveat: the production guard also requires `dispute.status === RESOLVED`, and a real N+1 appeal changes status to APPEALED. Therefore this single-guard mutation may survive existing tests due to independent defense in depth. A surviving mutant is not proof of a security defect or adequate Gate 5 evidence; it requires a discriminating reachable fixture or a different mutation that causes an observable unsafe state.
- Gate 5 requires a second independent mutant moving Outcome deletion outside the transaction, and confirmed meaningful RED mutants against GREEN original with exact run IDs and assertions. No merge/freeze.

### Gate 5 verified mutation RED/GREEN evidence (2026-10-16)

- GREEN original `7485e9c1cad423262a86796a22d5fff3c792f849`, workflow [#38922867575](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38922867575): **success**, unit and real-PG integration. The later documentation-only head `42e56f65bca16a12e9c82dfece231a82a80a9bf1`, workflow [#38923524501](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38923524501), also **success** in both lanes.
- RED mutation 1 `0ea21d32c13e623c61ddf2257916bcecd0a68061`, draft PR #478, workflow [#38923304506](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38923304506): unit **failure**, 1/3007 failed in `tests/disputePendingReconciliation.test.ts`, specifically `the dispute is no longer RESOLVED for the recorded generation ... the round no longer authorizes cleanup`. Expected failed report `pending ruling generation no longer authorizes cleanup`; received empty report. PostgreSQL lane skipped. This is a discriminating unit-test failure caused by removal of the exact appeal-round guard; it is **not** real-PG mutant evidence.
- RED mutation 2 `0892771e53fd623b16863a46a10cfa49e0e7b134`, draft PR #479, workflow [#38923663204](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38923663204): unit **success** 3007/3007; real-PG **failure** 2/1165 in `tests/integration/st1TemporalCleanupAuthority.test.ts`. `V3-A` expected injected atomic Outcome deletion error but received pre-persistence dispatch failure; `V3-PG` expected SQL division-by-zero from the transaction but received pre-persistence dispatch failure. This is meaningful detection that Outcome deletion escaped the intercepted transactional boundary; the PG tests were run, but the fault injection did **not** execute inside the mutation's transaction. Do not claim actual SQL rollback evidence on the mutant.
- Both mutants are deliberately unsafe disposable branches and **must never be merged**. The RED/GREEN contrast for the two specified mutations is observed. Gate 5 evidence can be marked *technical mutation contrast obtained*, pending any separate acceptance/reviewer decision; this does not by itself accept the other five gates or authorize merge/freeze.

### Gate 1-4 acceptance reconciliation after mutation evidence (2026-10-16)

- Gate 1: `V3-WK` explicitly SIGKILLs the writer **after the real pending has persisted**, then uses independent recovery. This proves durability/replay after a persisted pending, not the crash window after a signed ruling and Outcome commit **before** first pending persistence. Keep that distinct failure window open until a fresh-OS-process first recovery proves it.
- Gate 2: `V3-PG` executes real PostgreSQL SQLSTATE 22012 within the D-to-E transaction and checks rollback. The same test invokes `reconcileMissingDispatch` concurrently, checks one durable pending, and replays from a fresh OS process. These are strong tested subcases; the first-recovery-after-crash window is still not covered merely by replaying a recovered pending.
- Gate 3: direct-rail `applyRuling()` sets `directDispatchAttempted` immediately before `releaseFunds`/`refundFunds`/`splitFunds`, then rethrows without reverting signed authority on provider error. `V3-DIRECT` tests provider unknown outcome on MOCK and verifies no fabricated receipt or redispatch, but does **not** prove the full signed-dispute/Outcome path against a real production rail. Required: signed ruling + durable Outcome, provider side-effect-then-throw, process restart and independent evidence of the side effect/no effect. Keep open.
- Gate 4: `V3-GI` uses two independent waiting PostgreSQL backends after commit `6af950033acbd0f4f03cb25d00016a7ff9b91e9c`; workflow [#38931457802](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38931457802) was still in progress at inspection. It queues appeal before cleanup while D is held; this is not a proof of old cleanup paused *after* entering the critical section, then N+1 committing first. Legacy `makeAppealable` bypasses immutable arbiter commitment for the fixture; current production MULTISIG N+1 appeal is structurally disallowed. Do not overclaim exact interleaving.
- Gate 5: see recorded RED/GREEN runs for PRs #478/#479 above. Formal acceptance requires reviewer confirmation and final exact-head CI.
- Gate 6: only exact-head complete CI counts. The previous documentation-only head `42e56f65` passed unit+PG; the new test head `6af95003` remains pending. No merge/freeze.

### Gate 4 and first-OS-process C4 CI checkpoints (2026-10-16)

- `6af950033acbd0f4f03cb25d00016a7ff9b91e9c`, [CI #38931457802](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38931457802): **SUCCESS**, unit and real PostgreSQL. This validates the V3-GI distinct waiting backend assertion on this exact head. It does **not** prove the stronger old-cleanup-entered-critical-section interleaving, nor production MULTISIG N+1 appeal reachability.
- `7da4033161ce3a1bd1cabaf9aae68c9106c6b8ed`, [CI #38932098118](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38932098118): **SUCCESS**, unit and real PostgreSQL, documentation-only reconciliation.
- `688dc03a89a16b5182d7d98123dd3556c3ed78ae`, [CI #38932803392](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38932803392): unit **SUCCESS**, PostgreSQL **IN PROGRESS** at inspection. V3-PG now requires a fresh OS process and Prisma pool to perform the **first** C4 recovery while signed ruling/Outcome are persisted and pending is absent; later in-process workers must not redispatch. Do not mark this new proof green before PostgreSQL completes.
- The new V3-PG test does **not** kill the original writer process at that specific pre-pending point; the signed/Outcome/no-pending state is produced by injected dispatch failure and SQL rollback. A literal crash-at-that-window SIGKILL remains a separate adversarial scenario.
- All six formal gates remain subject to evidence review and final exact-head CI. **NO MERGE / NO FREEZE**.


## 2026-10-16 — Fresh-process C4 recovery CI closure (evidence only)

The first recovery after a durable signed ruling and Outcome with **no pending transaction** now runs in a fresh operating-system process with a separate Prisma pool. The child initializes the real intent/event handlers and uses only a deterministic Bitcoin explorer transport fixture; it invokes the production `reconcileMissingDispatch(100)` and asserts the target escrow is claimed and resumed, with no target failure. In-process concurrent replays must not create another dispatch.

Exact-head GitHub Actions evidence:

- `0fd95c452ffc9ef1a12e1ce2736f5e528fc51d30`: run [38941283090](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38941283090), **SUCCESS**, unit and PostgreSQL integration.
- `339c04d5469ec21a33ae1fee881033b0dc61883e`: run [38941653640](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38941653640), **SUCCESS**, unit and PostgreSQL integration.
- `dc233559b3b18b488dca11fde1b4e899ecbe707c`: run [38941742946](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38941742946), **SUCCESS**, unit and PostgreSQL integration.

**Important remaining Gate 1 distinction:** V3-WK proves real writer SIGKILL **after** the pending transaction persists; V3-PG proves first recovery in an independent OS process **without** pending, but constructs that state through controlled dispatch failure and PostgreSQL fault, not by killing the writer between the durable Outcome commit and the first pending write. A combined real-writer pre-pending SIGKILL plus fresh-process first recovery is **not yet proven**. This gap must not be marked accepted merely because the above CI runs are green. Formal Gate 3 and Gate 4 adversarial limitations remain as documented. **NO MERGE / NO FREEZE.**


## 2026-10-16 — Gate 1 pre-pending writer SIGKILL validated on real PostgreSQL

The new `V3-PRE` integration scenario starts the actual `resolveDispute` writer in a child OS process. A test-only interception at `escrowService.initiateRelease` checks the **committed signed Dispute and Outcome** in PostgreSQL, and checks that no pending transaction exists, then blocks the writer. The parent issues a real `SIGKILL` and verifies the durable state before launching the **first** C4 reconciliation in a fresh OS process with a new Prisma pool. It asserts a single pending transaction tied to the exact dispute ID, appeal round, arbiter, outcome, signature and issued-at timestamp; a second independent C4 replay must not resume again or change the pending, Outcome, signature, or pre-signature EDA count.

Exact-head CI evidence, unit and real PostgreSQL integration both **SUCCESS**:

- [38949028917](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38949028917), HEAD `49abf083f8ab55e711df0def89de6d663825e891`.
- [38949273022](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38949273022), HEAD `e4926a0f64c9a0592970411038d06553be057082`.
- [38949477864](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38949477864), HEAD `67f9c3e1fc33e9018ba4bb7cf3ce05ecb675ed73`.

**Gate 1 evidence is now green for both sides of the pending-write boundary** (V3-PRE before pending; V3-WK after pending). Scope caveat: V3-PRE intercepts the adapter entry point in the test process, without modifying production code; it does not prove every instruction-level crash point or every settlement rail. Gate 3/4 residuals and full final acceptance review remain open. **NO MERGE / NO FREEZE** until the full gate matrix is accepted.

## 2026-10-16 — Gate 3/4 adversarial audit and release disposition

This review does **not** add production code or claim fresh behavioral evidence. It separates tests of fail-closed logic from proof that the same states are reachable through production transitions.

### Gate 3: durable economic authority without pending

- Existing V3-E injects a durable EDA and missing pending and checks that rollback does not erase economic authority. This is a **fail-closed safety test**, not evidence that the precise EDA/no-pending state is reachable through the production MULTISIG state machine.
- Missing acceptance: trace and prove the real writer/authorization/pending lifecycle that could yield this state, or demonstrate the invariant that makes it unreachable. If reachable, test an unknown external provider outcome, then a replacement pending of a different generation, and assert **no rollback, no duplicate external side effect, no cross-generation deletion**.
- External provider effects must be checked against provider-specific evidence; a database EDA count alone does not prove the absence of a second broadcast or payout.

### Gate 4: appeal generation interleaving

- The V3-GI test establishes distinct live PostgreSQL backend PIDs for old cleanup and N+1 appeal and checks the generation guard. The `makeAppealable()` fixture uses a legacy-only bypass of the immutable MULTISIG arbiter commitment; do **not** report this as a normally reachable new-MULTISIG appeal.
- Missing acceptance: confirm the old catch is paused **before** acquiring D, the independent N+1 appeal commits while it is paused, and the old catch is released only afterward. Verify N+1 dispute/Outcome identity and the absence of any old-generation deletion. Record PostgreSQL backend correlation and lock ordering in the CI evidence.

### Remaining release requirements

Gate 5 behavioral mutant RED/GREEN has prior evidence but must remain separated from production branches. Gate 6 requires exact-head unit, full real PostgreSQL, security preflight and final review after all accepted changes. The latest green pre-pending writer crash evidence supports Gate 1 only; it does not close Gates 3/4. **NO MERGE / NO FREEZE.**


## 2026-10-16 — C4/EDA missing-pending candidate safety patch (awaiting exact-head CI)

- Production change `181a07cf84657d8dd50009267f4fb78c3950c7e6`: `claimCandidates()` in `dispute-dispatch-recovery.ts` excludes escrows with **any** committed `economic_disposition_authorizations` row. This is intentionally conservative: EDA is irreversible economic-execution authority and survives the loss of its pending row.
- Regression `23efa168b40fb7e0faa115b2b70e3bc553a19be6`: the existing V3-E real-PostgreSQL fixture now invokes actual C4 recovery after an authorized pending disappears and asserts the escrow is neither claimed nor resumed; original EDA, Outcome and missing-pending state are preserved. Preceding `36f8eef1` additionally pins the full Outcome identity across the stale-pending sweep.
- **Race analysis, not yet a proof:** `authorizeDisputedPendingExecution()` requires a concrete pending and commits EDA under the D lock. C4 candidate selection requires no eligible pending. The missing-pending + EDA fixture intentionally deletes a pending after EDA commit; the new candidate predicate blocks that stable state. A snapshot predicate alone does not prove absence of all races involving concurrent pending deletion, EDA commit and C4 initiation. Deterministic interleaving or an invariant proof remains required before claiming Gate 3 closure.
- **Provider limitation:** EDA persistence is an authority record, not provider acknowledgement. No external broadcast/payment exactly-once claim is supported by this test.
- At documentation time, [run 38954760092](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38954760092) for `23efa168` remained in progress. **NO MERGE / NO FREEZE.**


## 2026-10-16 — C4/EDA integration CI diagnostic and follow-up

- Run [38959167963](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38959167963) at `203132a5`: **FAIL**, unit PASS; PostgreSQL **1165 PASS / 1 FAIL**. Failure is the M9-R STARVATION oracle, not the ST1 suite. Its `queuedCandidateEscrowIds()` included escrows with committed EDA, while production `claimCandidates()` correctly excluded them after `181a07cf`. The set equality assertion compared different candidate universes. This does not establish a production starvation failure.
- `cc5b86f82327fcf618ffcc243758242dd68a1d7f` updates the test's SQL oracle with the same EDA exclusion, preserving the original round-robin, starvation-bound, recovery and exactly-once assertions. Requires **fresh exact-head PostgreSQL GREEN** before accepting.
- `2edc6e8cbea477a68d470864c625c4049dc881a2` adds a second durable EDA check immediately before C4 initiates settlement. This narrows the check-to-use interval but is **not** a linearization point or deterministic proof of all races. No provider exactly-once assertion is made.
- **Gate 3 remains open. Gate 4 remains open. NO MERGE / NO FREEZE.**


## 2026-10-16 — C4 check-to-use adversarial review

Review of `dispute-dispatch-recovery.ts` at `0b8983ca` establishes three distinct decision points: (1) `claimCandidates()` excludes durable EDA using a SQL anti-join and stamps the candidate under a PostgreSQL row lock; (2) `evaluateDisputeDispatchEligibility()` checks the historical Outcome and existing pending/terminal escrow but **does not consult EDA**; (3) C4 re-reads EDA immediately before calling `escrowService.initiateRelease/Refund/Split`. The row lock in (1) is released at claim transaction end. The re-read in (3) is a separate query. **Neither forms a serializable lock with EDA authorization**, which takes `pg_advisory_xact_lock(hashtext(economicDispositionLockKey(disputeId))::bigint)` on its own transaction. A concurrent EDA commit after (3) remains a TOCTOU gap unless the initiation path itself proves exclusion.

**Required deterministic test before Gate 3 approval:** two independent PostgreSQL connections/workers, C4 paused after its final EDA-negative check and before `initiateRelease/Refund/Split`; a competing transaction commits EDA for the same escrow/dispute using the actual authority path; resume C4. Assert no conflicting pending, no second execution authority, no changed Outcome/generation, and no duplicate external-provider side effect. An injected pause must observe real SQL and actual production initiation code; mocks alone are not acceptance. If EDA requires an existing pending, construct the interleaving at the last reachable point and explicitly prove reachability rather than manufacturing impossible database state. Also exercise the inverse commit order and worker restart.

**Do not patch the shared live `evaluateDisputeDispatchEligibility()` based only on this C4 finding:** that primitive also serves the live ruling path and has different lifecycle preconditions. Establish the serialization point and production reachability first. No assertion of external exactly-once until provider evidence exists. **NO MERGE / NO FREEZE.**


## 2026-10-16 — Reachability refinement after EDA authorization code inspection

Exact-head CI evidence: `cc5b86f8` run [38963263500](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38963263500), `0b8983ca` run [38963420854](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38963420854), and `ecaf0f14` run [38963732185](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38963732185) all **SUCCESS** (unit + real PostgreSQL). `99858bdd` V3-E3 concurrent C4 test remains unaccepted until its own exact-head CI completes.

Important reachability constraint: `authorizeDisputedPendingExecution(pending)` authorizes a **pre-existing pending operation** and commits EDA keyed by that exact `pending.id`, under the dispute advisory lock. Therefore the proposed ordering “C4 observes *no pending*, EDA commits for that same escrow, then C4 initiates” requires an independent pending creation and/or deletion between those steps. It cannot be assumed possible from the EDA API alone. A valid deterministic race test must first demonstrate the actual production pending lifecycle that makes this ordering reachable, including the relevant row/unique constraints, and then prove its invariant. V3-E/V3-E2/V3-E3 deliberately inject missing pending *after* EDA and establish safe refusal for that adversarial state; they do **not** establish a provider side effect or a naturally reachable concurrent EDA commit.

No production lock or EDA schema changes are authorized by this review alone. Gate 3 remains conditional, and Gate 4 still needs reachable N+1 appeal proof. **NO MERGE / NO FREEZE.**


## 2026-10-16 — V3-E3 exact-head PostgreSQL acceptance evidence

`99858bdd93b2489e131caeeba938ba73d7d79a7f`, run [38963900030](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38963900030), **SUCCESS**: unit tests and real PostgreSQL integration tests both green. V3-E3 ran two concurrent production C4 sweeps against a real database after a committed EDA's pending row was adversarially removed. Neither sweep claimed or resumed the escrow; EDA, ruling, and Outcome remained unchanged and no pending was rebuilt. This accepts **only** the pre-existing-EDA exclusion scenario, not a mid-flight EDA commit, production-natural pending loss, or provider exactly-once. Gate 3 remains **OPEN** pending reachability and serialization evidence. Gate 4 remains **OPEN** pending normal-path appeal reachability. **NO MERGE / NO FREEZE.**


## 2026-10-16 — Gate 4 normal-path reachability and product decision

Inspected the actual `DisputeService.appeal()` precondition. Before selecting any appeal panel, it invokes `findCommittedArbiterId(escrowId)` and **throws** if the escrow has a script-committed arbiter. This is an explicit cryptographic guard: a new arbiter identity cannot sign the existing MULTISIG script. `V3-GI` obtains N+1 by `makeAppealable()`, which executes `SET LOCAL session_replication_role = replica` and deletes the arbiter commitment. That is an intentional legacy-state fixture, **not a reachable new-write production appeal**.

Gate 4 acceptance must therefore distinguish two claims: (A) for new script-committed MULTISIG escrows, the product behavior is **appeal refused**, which should be regression-tested without bypassing the trigger; (B) for genuinely legacy no-commitment escrows, N+1 may be reachable, and the existing `V3-GI` demonstrates generation-safe cleanup only under its simulated legacy fixture. Do not rewrite the appeal guard or promise N+1 support on immutable-script MULTISIG as part of ST1. A change to the arbitration model requires an explicit product/security architecture decision and separate design.

Remaining action: add a negative normal-path appeal regression assertion using the intact arbiter commitment, with no dispute/Outcome/pending mutation; then decide whether Gate 4's legacy simulation is sufficient for the supported legacy scope. **NO MERGE / NO FREEZE.**


## 2026-10-16 — Gate 4 scope ruling for Day 0 review

The acceptance claim is split by *reachable production scope*, not by an invented universal N+1 path:

1. **New-write MULTISIG, immutable script-committed arbiter:** the required behavior is refusal of `DisputeService.appeal()` before mutation. `V3-G0` tests the actual public service API and exact preservation of Dispute, Pending, Outcome, EDA and committed key. Await exact-head PostgreSQL green before accepting.
2. **Legacy escrow without arbiter commitment:** `V3-GI` proves generation-bound stale cleanup against a genuine queued N+1 appeal and independent PostgreSQL backend connections *after* creating a simulated legacy shape by bypassing a trigger. This is a conditional legacy-state concurrency proof, **not** evidence that current MULTISIG creates such an escrow.
3. **Future appeal-capable rails:** out of ST1-R2 scope; no implied support or release promise. An explicit ADR/product decision is required before changing the immutable-script guard.

Proposed Gate 4 disposition once V3-G0 is green: **ACCEPT for current MULTISIG fail-closed scope; CONDITIONAL for legacy compatibility**. This is not global Gate 4 closure until legacy support policy is explicitly adopted. Gate 3 remains open. **NO MERGE / NO FREEZE.**


## 2026-10-16 — V3-G0 current MULTISIG production guard GREEN

Exact-head `c953daa65cb02837fe584edd3071ffc6af024e16` run [38968808688](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38968808688) **SUCCESS**, unit + real PostgreSQL. Exact-head `d4db6d321941624b31889e2dcd83b364437828d5` run [38968985743](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38968985743) **SUCCESS**, unit + real PostgreSQL. `V3-G0` exercises `appeal()` with an intact script-committed arbiter and asserts refusal without mutation to dispute, pending, Outcome, EDA or committed key. **Current MULTISIG N+1 is intentionally unreachable and its rejection is now regression-tested GREEN**. `V3-GI` remains a simulated legacy-state generation race; whether to include legacy compatibility in formal Gate 4 scope remains a release-policy decision. Gate 3 still requires production-reachable concurrent EDA/provider proof. **NO MERGE / NO FREEZE.**


## 2026-10-16 — CTO Gate 3 red CI triage and transaction boundary audit

CI [38978133961](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38978133961) for `a170d781` failed only V3-E4 (1168/1169 PostgreSQL tests passed). The spy counted all `initiateRelease()` invocations in a `reconcileMissingDispatch(100)` **batch**, including other eligible escrows, and injected target EDA authorization after unrelated calls. Thus `Received: 6` was not proof of six target executions; the test instrumentation itself was incorrect. Commit `9707e047` now scopes instrumentation and the one-attempt assertion to the target escrow and forwards unrelated calls without EDA injection. **Await exact-head CI before claiming fix green.**

Production path audit: `escrowService.initiateRelease/Refund/Split` delegates to `escrow-pending-tx.ts` `initiateSignatureCollectionCore()`. That flow builds an **unsigned PSBT** and persists `escrowPendingTransaction` in a transaction; it does not broadcast funds at initiation. The separate `authorizeDisputedPendingExecution()` takes the dispute advisory transaction lock **later**, on a pre-existing pending operation, and commits EDA. C4's last EDA read is not held under that dispute lock through initiation. A unique pending-per-escrow constraint prevents two simultaneous *persisted pending rows*, but is not by itself proof of one economic authority or one external provider submission after pending deletion. No new lock is justified without checking transaction/lock order and external lifecycle.

The corrected V3-E4 establishes a **sequential** C4 initiation → pending → EDA → no-replay sequence under a fault-injected missing-pending fixture. It is neither a cross-process C4/EDA race nor an external broadcast exactly-once proof. Gate 3 **OPEN**, NO MERGE / NO FREEZE.


## 2026-10-16 — CTO architecture decision: current MULTISIG vs MULTISIG 2 Taproot

**Approved Day 0 behavior:** retain the existing cryptographic arbiter commitment for current MULTISIG. `DisputeService.appeal()` must fail closed if replacing the script-committed arbiter; do not change signing commitments, fabricate an appeal path, or weaken the V3-G0 regression just to close Gate 4. V3-G0 has real-PostgreSQL green evidence on `c953daa6` and `d4db6d32`.

**Deferred architectural track, AFTER Master Backlog closure:** MULTISIG 2 / Taproot. Evaluate Taproot spending-path design, appeal-generation authority changes, cryptographic signature policies, compatibility with settlement, EDA, dispatch recovery and reconciliation, and migration/coexistence with prior MULTISIG escrows. Taproot alone does **not** imply that a script-committed arbiter can be replaced. This is explicitly **out of scope** of ST1-R2 / PR #436; no Taproot implementation or changes to current commitments in this PR.

**Legacy historical escrows:** inventory actual configurations and evidence of historical reachability before selecting support policy. `V3-GI` simulates a legacy state via a database-trigger bypass and cannot alone establish deployed historical populations.

**Gate 4 disposition:** current MULTISIG fail-closed security behavior accepted as CTO architectural scope, with V3-G0 green; historical legacy support inventory remains separate and must not be misrepresented as a normal Day 0 appeal path. This does **not** close overall ST1-R2.

**Immediate priority unchanged:** Gate 3 C4/EDA concurrent economic exclusion, corrected V3-E4 exact-head CI, provider side-effect/idempotency and crash recovery evidence. **NO MERGE / NO FREEZE.**


## 2026-10-16 — C4 initiation lock and pending uniqueness audit

`src/modules/open-settlement/escrow-pending-tx.ts` `initiateSignatureCollectionCore()` builds an unsigned PSBT, then uses `withEscrowFundingLock(escrowId, async tx => ...)` for the authoritative pending write. Under that transaction it re-reads the escrow's unique pending, rejects any existing disputed round, and may supersede only a provably dead, incompletely signed cooperative round. `tx.escrowPendingTransaction.create()` persists the new pending. A unique-index collision `P2002` becomes `EscrowError('...concurrent initiate')`. Thus two concurrent C4 initiations cannot both durably persist different pending rows for the same escrow at once; provider PSBT *build* can nevertheless be attempted before acquiring the write lock, and this is not proof of a single external provider *broadcast*.

`authorizeDisputedPendingExecution()` uses the separate dispute advisory transaction lock to authorize an **existing** pending, before first external provider side effect on signature submission. Its lock is not held by the C4 worker across PSBT building/pending insertion. The acceptance proof must explicitly distinguish: (a) duplicated PSBT-building attempts, (b) persisted pending cardinality, (c) EDA cardinality/immutable digest, (d) provider transmission and unknown-outcome recovery. Do not infer exactly-once from a unique pending index.

CI runs [38986547203](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38986547203) and [38986576570](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38986576570) both failed only V3-E4 because the test compared all Dispute columns: `dispatchRecoveryAttemptedAt` correctly changes from null to a timestamp when C4 claims the candidate. Commit `de93b656` now requires that operational marker while asserting every other Dispute field unchanged. Await real PostgreSQL exact-head result. Gate 3 **OPEN**; NO MERGE / NO FREEZE.


## 2026-10-16 — Provider finalize error-boundary audit (Gate 3 OPEN)

Inspected `src/modules/open-settlement/escrow-pending-tx.ts` `submitTransactionSignature()` on the current PR branch. The sequence is: (1) durable Outcome previously committed; (2) pending unsigned PSBT and signatures persist; (3) `authorizeDisputedPendingExecution(pending)` commits EDA; (4) capability execution authorization; (5) `claimEscrowTransition()`; (6) `provider.finalizeRelease/Refund/Split()` sends to provider; (7) provider-returned txId is recorded with `updateSignatureCollectionResult(... { operation: { pendingOperationId: pending.id } })`; (8) downstream fee/evidence and pending cleanup/reconciliation. Post-success **local** exceptions deliberately retain the claim and pending for C8 reconciliation.

**Material unresolved error boundary:** the `catch` immediately around `provider.finalize*` unconditionally calls `revertEscrowStatus()` on any thrown error. A provider can have broadcast successfully and then throw (timeout/lost response/unknown outcome); a thrown finalize error alone does not prove the side effect did not happen. The existing comment assumes `failing PROVIDER finalize` permits reverting the claim. Before treating this as safe, audit each active provider's finalize contract and any transaction-id/idempotency/reconciliation evidence. In particular, distinguish definite pre-broadcast failure from post-broadcast ambiguous failure. Do **not** change the catch or claim retry semantics blindly: this is a potential economic safety gap requiring a deterministic post-send/pre-ack failure test and an architecture-consistent remedy.

The earlier V3-E4 C4-only test does not exercise `finalize*` and cannot close this finding. **Gate 3 OPEN; NO MERGE / NO FREEZE.**


## 2026-10-16 — MULTISIG explorer ambiguity narrowed

`multisig.provider.ts` `finalizeSpend()` deterministically computes `tx.getId()` **before** calling `broadcast(rawTxHex)`. Its `broadcast()` makes a single bounded `POST /tx` with **no automatic retry**, but may throw on timeout, HTTP non-2xx, or unreadable response even when the explorer already accepted the transaction. `submitTransactionSignature()` currently reverts the claimed escrow status for *every* thrown `finalize*` error. The safe retry/recovery path already exists in `reconcilePendingSettlement()`: reconstruct the exact signed transaction/txid, query network existence, then check funding outpoint and quarantine anomaly; its `beforeFirstBroadcast` callback rechecks execution authority before an actual recovery broadcast.

**Concrete acceptance gap:** prove with a deterministic provider fixture that `POST /tx` accepts the transaction but the response is lost, and that subsequent execution cannot create a different economic spend, discard pending/EDA, or assume a definitely failed broadcast. Evaluate whether the pre-existing reconciliation can be reused on the finalize error boundary; do not indiscriminately remove status revert for provably pre-broadcast validation errors. The computed txid enables a principled ambiguity distinction, but its existence alone does not prove confirmed inclusion. This finding remains material and **Gate 3 OPEN**.



## 2026-10-16 — V3-E4 CI GREEN confirmed

Exact-head workflow [38988995755](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38988995755) for commit `de93b65678cad40ecd2ab9457b209e33ddec8026` completed **SUCCESS**: unit tests and real PostgreSQL integration tests both passed. The follow-up documentation commit `74310127520782a33639514e78d29a4982ad83dd`, workflow [38989152620](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38989152620), also completed **SUCCESS** for both lanes. This closes the specific V3-E4 test-oracle regression, not Gate 3's remaining independent-process concurrency and ambiguous provider-response acceptance requirements. Do not confuse green earlier commits with an exact-head green for a later documentation commit. **NO MERGE / NO FREEZE.**


## 2026-10-16 — PASS 1 reconciliation also shares ambiguous-provider-error boundary

Read `src/modules/open-settlement/escrow-settlement-reconciliation.service.ts` PASS 1. Its `reconcilePendingSettlement(... beforeFirstBroadcast)` callback authorizes EDA + execution and claims the escrow status immediately before the *first* recovery broadcast; the provider first checks expected txid existence and funding UTXO. However, the PASS 1 catch currently invokes `revertEscrowStatus()` whenever `claimedBeforeBroadcast` and the provider call throws. As in live `submitTransactionSignature()`, a POST accepted by the explorer with a lost response can throw after transmission. Thus a correction or acceptance test must cover **both live finalize and PASS 1**; fixing only the live path would leave the same ambiguity in recovery. Repeated network reads cannot be assumed authoritative during temporary propagation delays. Retain pending/EDA and quarantine unknown outcome until chain truth is established. No production patch is authorized by this audit alone; design and test both boundaries before changing claim state semantics. **Gate 3 OPEN / NO MERGE / NO FREEZE.**


## 2026-10-17 — RED-to-GREEN evidence: unknown-broadcast quarantine attempt reverted

The experimental blanket quarantine commits `1f638b93` and `f9074e0f` were **RED** on real PostgreSQL CI: [38992123425](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38992123425) and [38992140627](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38992140627). On the latter, unit tests were 3007/3007 green, but PostgreSQL integration had **17 failures / 1169 tests, four failing suites**. Representative failing tests in `signingRoundStateCompatibility.test.ts`, `signatureAuthorityConvergence.test.ts`, and `pendingRoundSupersession.test.ts` expected a definite explorer HTTP 503 refusal to restore the nonterminal escrow state, allowing a subsequent dispute; blanket retention left `COMPLETED` and caused `Invalid escrow transition: COMPLETED → DISPUTED. Allowed: none`. This is a genuine contract regression, not a test-oracle defect.

Production changes were restored without weakening tests in `25aa63f5` and `23fe2c2d`. The corrected exact HEAD `23fe2c2def1d4693731df13b7d9278bf946a4a25` passed [CI 38994577283](https://github.com/sails-protocol/Sails-Protocol/actions/runs/38994577283) **SUCCESS**. This green is evidence of regression rollback only, **not** evidence that accepted-but-unacknowledged broadcasts are safely classified. Gate 3 requires deterministic tests for (1) provably rejected before transmission versus (2) externally accepted but acknowledgment lost, in both live finalize and PASS 1, and a safe design compatible with the existing dispute/round state contracts. No mocks replacing PostgreSQL. Integration ST1-R2 / AUD1X-R4 remains pending, **NO MERGE / NO DEPLOY / NO FREEZE**.


## 2026-10-17 — Existing unknown-broadcast adversarial coverage inventory

Read-only source audit of `tests/integration/signingRoundStateCompatibility.test.ts` on branch `gatekeeper/st1-r2-exact-delete-authority` confirms **existing real-PostgreSQL tests** which must not be misrepresented as missing:
- `M/N`: C8 crashes after pre-broadcast claim; a separate reconciler recovers terminal escrow with a deterministic transaction ID while the old attempt is held.
- `O/P`: an explorer accepts a refund but returns an ambiguous 502; the live path reverts to `FUNDS_LOCKED`, a subsequent payment transition prevents unauthorized REFUNDED convergence and triggers manual review, and a later dispute permits C8 to converge to `ALREADY_BROADCAST` without a duplicate transaction.
- `L/L2`, `RACE-A`, `G/H`: terminal/dispute authority, concurrent reversal and live/C8 contention.

These are concrete existing oracles, not proposed tests. The remaining Gate 3 question is **authority-preserving liveness and classification of a lost response when the provider accepted the transaction, especially PASS 1 failures**. The current `broadcast()` throws the same general error contract for an HTTP rejection; a rejected HTTP status alone is not an independent Bitcoin network proof that the transaction was never accepted. Do not assume the absence of a successful response proves non-broadcast. Any further production change must preserve the O/P manual-review behavior, M/N terminal recovery, and H1 dispute eligibility. No merge/freeze until an exact-head PostgreSQL run validates the new change and remaining ST1-R2/AUD1X-R4 integration evidence.


## 2026-10-17 — PASS 0/PASS 1 failure-classification implementation contract

Inspection of `reconcileUnclaimedFullySignedPending()` in `src/modules/open-settlement/escrow-settlement-reconciliation.service.ts` confirms that PASS 0 calls `multisigProvider.reconcilePendingSettlement(..., beforeFirstBroadcast)`, where `beforeFirstBroadcast` authorizes and claims the terminal transition, sets `claimedBeforeBroadcast=true`, and the catch **unconditionally reverts** that claim on a thrown provider error. The live signature-finalize path likewise unconditionally reverts its terminal claim on a thrown finalize error. These two code sites are the actual classification seam. The existing O/P test exercises ambiguous **HTTP 502** acceptance and eventual C8 chain-truth convergence from the reverted state; M/N exercises recovery after the terminal claim. Neither by itself proves that a thrown transport failure after network acceptance is handled with the right liveness and authority behavior in both entrypoints.

Required acceptance matrix before changing production:
1. Definite simulated nonacceptance (existing HTTP 503 refusal): restore original state, keep signed round and dispute eligibility; existing H1 tests remain GREEN.
2. Accepted transaction + lost transport response in **live finalize**: preserve deterministic tx identity and signed pending; ensure C8 observes on-chain truth, converges without a distinct second spend, and does not permit an unauthorized competing transition.
3. Accepted transaction + lost transport response in **PASS 0 first broadcast**: exercise the callback claim and catch; verify C8 converges, terminal transition record and dispute MOOT behavior, and no starvation.
4. Provider status/body ambiguity and read-side explorer outage: fail closed with visible manual review or retry; never equate a network timeout with a proven rejection, never invent chain truth.
5. PASS 1 terminal/no-txid recovery remains GREEN for both already-known transaction and genuinely unspent funding, including multi-instance contention.

A proposed fix must state what constitutes *proven nonacceptance* versus *unknown*, what persisted marker prevents contradictory authorization while chain truth is unavailable, and how the scheduler guarantees recovery. Tests must use real PostgreSQL and real PSBTs; the controlled explorer is permitted only as an external network fixture. No change to status machine or exception taxonomy is approved merely by this document. Gate 3 remains OPEN.


## 2026-10-17 — Transport-loss oracle CI evidence

- `5e243df8`, workflow `39002967428`: unit 192/192 suites and 3007/3007 tests GREEN; PostgreSQL 84/85 suites and 1169/1170 tests GREEN, **one failure in unrelated** `tests/integration/timelockExpiryBoundedness.test.ts` test 13 (stale worker after another node expires its batch). Assertion expected `requiresManualRecovery` empty but received one escrow ID. This is not evidence that the new PASS 0 transport-loss test failed; the failure is real and should be investigated separately, not dismissed as flaky without reproduction.
- `dae595dd`, workflow `39003441949`: unit and PostgreSQL integration steps both **SUCCESS**. This HEAD includes the PASS 0 accepted-broadcast/transport-rejection oracle and the LIVE accepted-broadcast/transport-rejection oracle in `tests/integration/signingRoundStateCompatibility.test.ts`. Their presence in a successful full integration run is evidence of GREEN for these controlled-explorer fixtures, **not** proof that the current exception/reversion policy closes all external uncertainty windows.
- The acceptance matrix remains open for provider-specific failure classification, independent Bitcoin network truth during read-side outage, and the ST1-R2/AUD1X-R4 integration review. Gate 3 remains OPEN; no merge/deploy/freeze.
