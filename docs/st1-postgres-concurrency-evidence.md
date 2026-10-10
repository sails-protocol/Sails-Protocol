# ST-1 PostgreSQL concurrency experiment — evidence ledger

Branch: `gatekeeper/st1-postgres-concurrency-experiment`
Base: `07224a0c47d240805b83b6bad5a6a53847e05663`
Scope: experiment only. No production modifications in this branch.

## Execution status

**LOCK PROBE EXECUTED AND GREEN ON PR MERGE SHA; PRODUCTION INTEGRATION NOT EXECUTED.** The isolated GitHub Actions run #38090384206 completed successfully on 2026-10-10. The workflow was associated with branch HEAD `e6795092a2a706f1d2cde9c23f1d54b898bdee9f`, but `git rev-parse HEAD` in the job printed the temporary PR merge commit `c486ebd0d812ab80ed5b5dfe5a2ee6d4ae4f23c3`. This is **not** exact branch HEAD CI. PostgreSQL `SHOW server_version` returned `16.15`. The D->E two-worker advisory lock scenario passed and `pg_locks` showed PID 537 waiting on an advisory lock (`granted=false`) held by PID 536. The deliberately reversed E->D vs D->E scenario emitted `EXPECTED_DEADLOCK` with SQLSTATE `40P01` and `acquired`. The bounded retry scenario reported PASS at `attempt:1`; it **did not demonstrate a retry after an actual 40P01**. All application-level economic tests remain unexecuted in this workflow. Raw logs: https://github.com/sails-protocol/Sails-Protocol/actions/runs/38090384206 ; uploaded artifact ID `11683623173` (artifact SHA-256 `e5715075dafc5d7b93e1100b84bbc5e07f78908d23cc10f8e400a0bb9dc0c873`). The temporary PR #434 was closed without merge because its historical diff spanned 127 commits / 290 files. No new PR or trigger is authorized.

## Experimental lock probe

```sh
ST1_TEST_DATABASE_URL='postgresql://user:pass@localhost:5432/st1_disposable' node scripts/st1-postgres-lock-probe.cjs
```

The probe covers (1) D->E ordering across independent connections, (2) an intentional E->D / D->E deadlock yielding SQLSTATE 40P01, and (3) bounded retry after transaction abort. The probe does not write production tables. It must run only against a disposable DB.

## Mandatory application-level real-Postgres matrix (NOT EXECUTED IN ST-1 WORKFLOW; some historical tests exist but do not prove ST-1 predicate)

| Scenario | Barrier / scheduling | Required assertion |
|---|---|---|
| N->N+1 before cleanup | pause cleanup before D; commit appeal; release | no delete, pending unchanged |
| cleanup N before appeal | pause appeal before D; commit authorized cleanup; release | exactly one authorized delete |
| signature before cleanup | pause cleanup before E; commit signature; release | signature and pending remain |
| cleanup before signature | pause signer before E; commit cleanup; release | signer rejected; no recreation |
| reversal after ruling | force provider failure; race revert D->E and cleanup | no invalid generation deletion |
| concurrent reconcilers | hold D while two reconcilers contend | <=1 deletion, no duplicate effects |
| missing Outcome | persisted pending with absent durable Outcome | no delete, reported fail-closed |
| ambiguous provenance | null/mismatched fields or cooperative round | no delete, no assumption of authority |
| committed economic authorization | persist durable authorization before appeal | preserve committed authority and effects |
| restart/replay | kill worker at deterministic barrier and restart | converges without extra delete/effect |
| deadlock 40P01 | reverse lock order in disposable test only | rollback and bounded retry, never silent |
| row-lock dependency | D/R, D/E, E/R, FK and update locks | no unexamined cycle or unbounded wait |

Each application-level test must log PID, SQLSTATE, event sequence, `pg_locks`, final pending/signature/dispute/outcome/authorization state and economic-effect counts. Require `lock_timeout` and `statement_timeout` and deterministic barriers. A test using mocks only is not acceptance evidence.

## New application-level regression cases (UNEXECUTED)

On experimental branch commits `b7649aa5`, `bb9f3d8`, and `dd377536`, the existing real-PostgreSQL test suite `tests/integration/staleDisputeCleanupSignatureRace.test.ts` gained ST1-A through ST1-E. These invoke the actual production deletion function and assert: missing caller generation rejection, mismatched supplied generation rejection, changed durable dispute generation rejection, **missing SemanticTransitionRecord must fail closed**, and provenance-less pending rejection. They have **not** been executed. ST1-D is an intentionally red acceptance gate against the current provisional implementation: the current function checks dispute, signature and committed authorization but does not require a durable Outcome before deletion. The test is not evidence of a runtime failure until actually executed. The fixture uses a direct dispute update in ST1-C, not a real `appeal()` concurrency race. ST1-E tests ambiguous provenance, not an independently created cooperative economic operation.

A future run must execute the focused suite against a disposable PostgreSQL database, preserve raw logs, then test the actual `appeal()` and reversal entry points with deterministic barriers and record row/FK lock graphs. No PASS can be assigned based solely on these added tests. No frozen economic authority was changed.

## CI preparation on experimental branch (NOT RUN)

Commit `be107205` updates the isolated ST-1 workflow to checkout the PR head SHA rather than the synthetic merge SHA, assert the checkout matches the expected SHA, execute the focused real-PostgreSQL integration suite after the synthetic probe, and upload both raw logs even if the integration step fails. The focused suite contains intentionally failing ST1-D (missing durable Outcome) against provisional production code; an all-green run is **not expected** until the policy conflict is resolved with CTO authority. This commit did not trigger a new run. Existing GitHub connector actions expose rerun of an old job but no workflow_dispatch, and rerunning the old run would not test the new HEAD. Do not claim CI PASS or rerun old evidence as new proof.

## Historical CI failures inspected (not exact current HEAD)

The historical PR run also had failing general CI jobs: `CI Tests` run #38090384074, job #114325438195, and `CI` run #38090383969, job #114325437697. In `CI Tests`, Jest could not compile `src/modules/open-settlement/dispute-pending-reconciliation.ts:175` because the helper accepted `{id, escrowId}` and cast it to full pending provenance (TS2352). This is a concrete defect, separate from ST-1 economic proof. Experimental commit `46899f7c` corrects the helper argument type to require complete provenance and removes the unsafe cast. This is **not validated by a new run**. The broader CI jobs remain failures and must not be described as green. The previous synthetic probe run was separately green.

## Open material findings

1. The provisional cleanup holds E but not D. It cannot serialize appeal N->N+1.
2. The provisional `DELETED_NO_OUTCOME` path must fail closed under the CTO's new predicate.
3. D->E global cycle absence remains unproved for implicit row/FK locks and indirect calls. The lock probe does not exercise row/FK locks.
4. Historical signer/multiworker/restart integration tests exist, and ST1-A..E are now authored, but none was executed in the ST-1 CI; N/N+1 appeal and reversal production races remain unproven.
5. Green synthetic probe ran on PR merge SHA, not exact branch HEAD; no exact-head production integration CI, mutation proof, independent Opus review, merge or FREEZE.
6. The reported bounded retry PASS used attempt 1 and is not proof of actual 40P01 recovery.
7. Existing `tests/integration/staleDisputeCleanupSignatureRace.test.ts` has real production signer/cleanup entry points and advisory-lock barriers, but the ST-1 workflow did not execute it and its historical assertions cannot substitute for the N/N+1 D->E authority predicate.

**Gate: LOCK PROBE PASS (PR merge SHA only); ST-1 ECONOMIC INTEGRATION BLOCKED.** The branch-only `workflow_dispatch` cannot be assumed runnable through the available connector: no dispatch action is exposed; the prior PR trigger was closed and the CTO prohibited another PR. No additional run is claimed.

## ST-1 follow-up: fail-closed CI and fixture inconsistency (unexecuted)

- The isolated workflow's synthetic probe previously piped `node ... | tee` without `set -o pipefail`, so a failing probe could be reported as a successful step when `tee` exited zero. Commit `f4c5cbe` adds `set -o pipefail`; **no run has validated this change**.
- `tests/integration/staleDisputeCleanupSignatureRace.test.ts` T3, T3b, T4, T5 and T6 expect an unsigned dispute round to be deleted using the common `fixture()`. That fixture creates a `RESOLVED` dispute but **no** durable `SemanticTransitionRecord` Outcome. ST1-D deliberately expects the opposite, fail-closed behavior. These assertions are mutually incompatible with the intended missing-Outcome policy; even after the implementation is corrected, the older deletion-positive fixtures must create an authentic, generation-matched durable Outcome before their success expectations are valid. Do not weaken ST1-D or fabricate an Outcome merely to make CI green.
- The provisional production helper still lacks an Outcome requirement inside its transaction, and the reconciler still exposes `DELETED_NO_OUTCOME`. This is a material policy conflict, not a proven safe cleanup. A policy-authorized implementation change and PostgreSQL execution are prerequisites for final ST-1 evidence.

## ST-1 additional unit-test policy contradiction (inspection only)

`tests/disputePendingReconciliation.test.ts` still positively asserts `DELETED_NO_OUTCOME` in **two tests**, for absent `SemanticTransitionRecord` and `outcomeContent: null`. Its `concurrent run already cleaned` test also uses `mockLoadDisputeRulingRecord(null)` to reach the delete path. These unit tests actively encode the behavior ST1-D must reject; updating only the integration suite cannot make the policy coherent. The current mock `prisma.$transaction` exposes `escrowPendingTransaction`, `dispute`, and `economicDispositionAuthorization` but **no** `semanticTransitionRecord` accessor, so a future in-transaction durable-Outcome check requires an aligned mock and new fail-closed assertions. Do not treat mock-based green tests as real Postgres concurrency proof. This finding is not a production change and has not been executed.

## ST-1 actual deadlock-victim retry probe (UNEXECUTED)

Commit `3d8b3f72eea374cac48167c71dea4c84c25f6cbd` changes only `scripts/st1-postgres-lock-probe.cjs`. The bounded-retry scenario now reuses the **actual PostgreSQL 40P01 victim** from the deliberate lock-order deadlock, asserts SQLSTATE `25P02` while its transaction remains aborted, rolls back both workers, and retries the victim under D→E order with at most three total attempts. A PASS requires a committed retry after a demonstrated `40P01`, rather than a first-attempt success. This is a stronger synthetic lock probe, **not an application-level economic proof**, and it has not been executed on the updated HEAD. No production economic code or frozen authority changed.

## CTO-authorized ST-1 authority implementation (UNVERIFIED)

The CTO explicitly authorized fail-closed missing-Outcome correction and experimental D→E locking. Commits `1d4530ad`, `253d0b75`, `cbbe6c71` implement the following on the isolated branch: remove `DELETED_NO_OUTCOME` deletion and log a failed reconciliation while preserving the pending row; acquire economic-disposition advisory lock by **dispute ID** before escrow advisory lock; inside that same transaction recheck pending generation, dispute, durable SemanticTransitionRecord Outcome and committed economic authorization before conditional delete; align unit mocks and missing-Outcome expectations. These changes are **not CI-tested**. The existing real-Postgres integration fixture lacks a durable Outcome for historical positive-delete cases; those tests must be made authoritative before claiming PASS. No N/N+1 actual appeal/reversal barrier test or indirect row/FK lock graph has been executed. Prior synthetic retry commits `3d8b3f72` and `894eda65` also remain unexecuted. The ST-1 experimental branch is not a release or freeze candidate.
