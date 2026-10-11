# ST-1 PostgreSQL concurrency experiment - evidence ledger

Branch: `gatekeeper/st1-postgres-concurrency-experiment`
Scope: experiment. The only production files changed on this branch are
`src/modules/open-settlement/dispute-pending-reconciliation.ts` (the provisional ST-1 cleanup) and a read-through
parameter on `loadDisputeRulingRecord()` in `dispute-outcome.ts`. No frozen economic contract is touched.

> *Corrigido 2026-10-10:* the previous revision of this file stated "NOT EXECUTED" and listed the application-level
> matrix as unimplemented. Both are superseded by this revision; the history is in git.

## 1. Evidence classes - kept separate on purpose

| Class | What it can prove | What it cannot prove |
|---|---|---|
| **Synthetic probe** (`scripts/st1-postgres-lock-probe.cjs`, workflow `ST-1 Experimental PostgreSQL Probe`) | PostgreSQL 16 grants D then E consistently, detects an inverted order as `40P01`, and a bounded retry works - properties of the database itself | anything about this application's code. It never touches an application table or function |
| **Real integration** (`tests/integration/st1TemporalCleanupAuthority.test.ts`, `staleDisputeCleanupSignatureRace.test.ts`, run against PostgreSQL) | the production functions' behaviour for the interleavings the tests force | absence of every possible cycle in the codebase |

### 1.1 Baseline workflow (synthetic probe) - what ran

Run `38090384206`, conclusion `success`, exact tested commit: merge ref `c486ebd0d812ab80ed5b5dfe5a2ee6d4ae4f23c3`
(`e6795092a2a706f1d2cde9c23f1d54b898bdee9f` merged into `be6d3bc2ddfc384cfafa4276e01b8aacc096d421`), PostgreSQL
`16.15`, migrations applied to a disposable database. One test program ran, three scenarios:

| Scenario | Result | SQLSTATE |
|---|---|---|
| D -> E same order, two workers | `PASS` (one granted, one waiting, observed in `pg_locks`) | - |
| deliberate E -> D against D -> E | `EXPECTED_DEADLOCK` - **the deliberate `40P01` was observed** | `40P01` (and the survivor `acquired`) |
| bounded retry after the abort | `PASS`, attempt 1 | - |

It did **not** run any Jest suite, any application function or any application table. By the CTO's own reading it
shows neither ST-1 temporal safety nor the absence of deadlocks in the real functions.

## 2. What changed in the cleanup (provisional ST-1 code)

`deletePendingRoundIfStillUnsigned()` now decides inside ONE transaction, after **D** (`economic-disposition:<disputeId>`)
and then **E** (`hashtext(escrowId)`), with `lock_timeout` 3 s:

1. the exact round (id + escrow) exists with zero signatures and is exactly the recorded ruling generation;
2. the dispute row (read `FOR UPDATE`) is still `RESOLVED` for that generation (round, arbiter, ruling, signature, escrow);
3. no committed Economic Disposition Authorization names the round;
4. the generation's own durable Outcome (read through the transaction, by the generation's appeal round) exists;
5. the translation guard, re-run on the stored PSBT, still rejects it - only then the conditional delete (same
   generation, zero signatures).

Anything that cannot be proven returns without deleting. `DELETED_NO_OUTCOME` no longer exists: an absent or empty
Outcome is reported as failed (`OUTCOME_ABSENT`). A guard that passes leaves the round alone (`GUARD_PASSED`).

## 3. Transactional graph (production code, as read and as observed)

| Actor | Locks, in acquisition order | Code |
|---|---|---|
| stale-round cleanup (this branch) | D -> E -> dispute row `FOR UPDATE` -> pending delete (cascades signatures) | `dispute-pending-reconciliation.ts` |
| Outcome commit | D -> dispute row `FOR UPDATE` -> dispute update -> record insert | `dispute-outcome.ts` `commitAuthoritativeDisputeRuling` |
| appeal() | D -> dispute update -> appeal-fee insert | `dispute.service.ts` |
| ruling revert (dispatch failed) | D -> E (`rulingRevertTarget`) -> dispute update | `dispute.service.ts` |
| signature acceptance | E -> pending read -> signature upsert (FK key-share on the pending row) | `escrow-pending-tx.ts` |
| round dispatch / supersession | E -> pending delete + create | `escrow-pending-tx.ts` |
| economic gate | D only, in its own transaction, after E was released | `economic-disposition-authority.ts` |
| escrow terminal transition | E -> escrow update -> dispute MOOT update | `escrow-lifecycle.ts` |
| guard-failure delete (live dispatch) and C4 recovery guard-failure delete | **none** (single `DELETE ... WHERE escrowId`) | `dispute.service.ts` `applyRulingCoreAuthoritative`, `dispute-dispatch-recovery.ts` |

Edges between advisory locks: **D -> E only**. No path was found, and none was observed (test X1), that takes D while
holding E. Row locks: the cleanup takes the dispute row after D and E; every other writer of that row takes it after D or
after E; a cycle would need a path holding the dispute row and then asking for D or E - none exists.

Empirical evidence for the order, from `pg_locks` (test L1): with E held elsewhere the cleanup holds D and waits on E;
with D held elsewhere it holds nothing and waits on D. Test X1 records the lock acquisitions of the production
transactions of five actors and asserts: `D -> E` observed, `E -> D` never, advisory subgraph acyclic. Row-level edges
are logged per table only - a table-level order is not a deadlock criterion (a cycle needs the same row in opposite
order), so they are evidence for review, not a predicate.

## 4. Real-PostgreSQL test matrix

`tests/integration/st1TemporalCleanupAuthority.test.ts` (production escrow/trade/dispute services, real `resolveDispute()`
commit and dispatch, real `appeal()`, `submitTransactionSignature()`, `authorizeDisputedPendingExecution()`; an explorer
stub serves one funding UTXO). Interleavings forced by holding D or E on a separate connection and confirming through
`pg_locks` that each contender is queued, in a known order, before releasing.

| Mission item | Tests | Assertion |
|---|---|---|
| (1) N / N+1 | N1, N2 | a nomination for generation N cannot touch the round of N+1 (id and generation); N+1 is judged against its own Outcome |
| (2) concurrent appeal | A1, A2, A3, A4, A5 | appeal first -> cleanup rejects; cleanup first -> decides under the proven authority, appeal proceeds; between nomination and decision -> rejects; status-only writer -> rejects; a writer outside D -> the row lock makes the cleanup wait, then reject |
| (3) signatures | S1, S2, S3 (+ the 8 tests of `staleDisputeCleanupSignatureRace`) | signer first -> signature durable, round kept; cleanup first -> signer fails closed with no orphan; signature after an appeal is kept |
| (4) reversal / committed effects | V1, V2 | a production revert after the round was persisted -> cleanup has no authority; a committed authorization is never deleted, before or after an appeal |
| (5) absent Outcome | O1 | fails closed, reported, no `DELETED_NO_OUTCOME` |
| (6) ambiguous provenance | P1, P2 | partial / absent / foreign provenance -> never deleted |
| (7) multiple reconcilers | M1, M2 | six concurrent decisions -> one delete; three full reconcilers -> one delete reported once |
| (8) restart / replay | R1, R2 | backend killed holding D and waiting on E -> nothing changed, no lock survives, an independent module graph converges once; replays change nothing durable |
| (9) deadlocks | L1, X1, G1, G2, K1 | order observed; advisory graph acyclic; stress (4 escrows x cleanup, cleanup, signer-then-gate, appeal) with no `40P01` / `55P03`; control: an inverted acquirer IS detected as a deadlock; a stalled holder yields a bounded lock timeout |

## 5. Mutation evidence

16 defects injected into `dispute-pending-reconciliation.ts`, each run against the three suites
(`disputePendingReconciliation`, `st1TemporalCleanupAuthority`, `staleDisputeCleanupSignatureRace`). **16 of 16 killed.**
Two survived the first sweep (dispute status not checked; dispute row not `FOR UPDATE`); tests A4 and A5 were added and
kill them.

| Mutant | Killed by |
|---|---|
| M01 no dispute lock | L1, A1, K1, G2, unit |
| M02 order inverted | L1, A1, X1, G2, unit |
| M03 no escrow lock | L1, S1, R1, G2, T2, T3, T3b, unit |
| M04 dispute status not checked | A4 |
| M05 dispute appeal round not checked | unit |
| M06 dispute escrow not checked | P2, unit |
| M07 dispute authority signature not checked | unit |
| M08 Outcome of round 0 instead of the round's own | N2 |
| M09 absent Outcome deletes | O1, unit |
| M10 signatures not re-checked | S1, S3, T2, T6, unit |
| M11 committed authorization ignored | V2, unit |
| M12 generation not compared | unit |
| M13 delete by escrow, not by round | unit |
| M14 guard not re-run | N2, unit |
| M15 dispute row not locked | A5 |
| M16 lock wait unbounded | K1 |

Honest note: M05, M07, M12 and M13 are killed by the unit suite only; the real-PostgreSQL suite does not drive those
particular defects. They are properties of a pure comparison; the unit mocks are the right instrument for them.

## 6. Material findings and residual risks - none hidden

| ID | Severity | Finding |
|---|---|---|
| ST1-R1 | **High (liveness), pre-existing** | The round of a ruling that was reverted, or whose generation was appealed, is reclaimable by **nothing**. The cleanup does not nominate it (dispute not `RESOLVED`) and, being generation-bound, would reject it anyway; C4 recovery skips it (`blocksRulingDispatch`); the next ruling is refused by the dispatch gate (`dispatch already occurred for this exact semantic authorization`) or by `assertSupersedableByThisDispatch`. Test V3 reproduces it through production code. Safety is intact (the gate refuses the orphan's execution); the escrow is stuck. Needs a Tier-3 decision: a "dead generation" reclaim under D + E, bounded by zero signatures and no committed authorization. Not implemented here: it is a new authority rule, not a revalidation of an existing one. |
| ST1-R2 | Medium | Two deleters are unbound and unlocked: `deleteMany({ where: { escrowId } })` after a failed translation guard in `applyRulingCoreAuthoritative()` and in C4 recovery. They hold no D/E lock, do not bind the round id or generation, and cascade-delete signatures. They delete the round just created, but nothing proves it is still that round. Same class as #244; same in both lineages (ST1-F6). Out of this mission's authorized scope (the provisional cleanup only). |
| ST1-R3 | Medium (reachability) | Generation N+1 is unreachable for MULTISIG today: `appeal()` refuses an escrow with a script-committed arbiter identity (database trigger forbids deleting it) and the dispatch refuses one without. The N / N+1 tests therefore use a legacy-shaped fixture (trigger bypassed for the fixture transaction, `session_replication_role`) and persist round N+1 with the provenance copy the dispatch makes. The cleanup's contract is generation-bound regardless; this is what proves it. |
| ST1-R4 | Low | The economic gate does not verify the round still exists: invoked on a stale row object it commits an authorization for a deleted round. In production it runs only for a round that has all its signatures, which the cleanup never deletes. |
| ST1-R5 | Low | A sweep now takes D and E for every nominated round, including legitimate guard-passing ones, for the duration of a PSBT parse. Contention is bounded (3 s lock timeout) and brief; the alternative (deciding the pass case outside the locks) was rejected as two code paths. |
| ST1-R6 | Info | The provisional cleanup had never run in CI before this mission. Its unit suite had one failing test (a mock once-queue leaked between tests after the call order changed); fixed. |
| ST1-R7 | Info | "No cycle found" is not "no cycle exists": the stress and the recording cover the actors of this graph; row-level order is evidenced per table, not per row. |

## 7. Gate

The experiment is complete as an experiment. This file is evidence for the CTO's review; it is not an ST-1 temporal
acceptance, a merge approval or a FREEZE.

## Appendix A - ledger entries written by a parallel session on this branch (preserved verbatim)

Between the baseline probe and this revision another session pushed 22 commits to this branch
(`19864e7`..`c1367cf`): CI hardening (exact-SHA checkout, `npm run build`, `pipefail`), a stronger synthetic probe
(retry of the actual `40P01` victim), the ST1-A..E fail-closed regressions in
`staleDisputeCleanupSignatureRace.test.ts`, and an earlier D -> E implementation. Its text is kept below because it
records material facts (the historical `CI Tests` TS2352 failure, the incompatible fixtures, the unit tests that
encoded `DELETED_NO_OUTCOME`). Statements below that say "unexecuted", "NOT RUN" or "BLOCKED" describe the state at
the time they were written and are **superseded by sections 2 - 6 above**. The implementation in this revision is a
superset of that session's (it additionally re-runs the guard and reads the Outcome through the transaction, reads
the dispute `FOR UPDATE`, bounds the lock wait, and reports `OUTCOME_ABSENT`).
ST1-D now expects `OUTCOME_ABSENT` instead of `PROVENANCE_REJECTED`, and the shared `fixture()` of that suite now
commits a real Outcome (so that the deletion-positive tests T3-T6 are authentic).

Branch: `gatekeeper/st1-postgres-concurrency-experiment`
Base: `07224a0c47d240805b83b6bad5a6a53847e05663`
Scope: experiment only. No production modifications in this branch.

### Execution status

**LOCK PROBE EXECUTED AND GREEN ON PR MERGE SHA; PRODUCTION INTEGRATION NOT EXECUTED.** The isolated GitHub Actions run #38090384206 completed successfully on 2026-10-10. The workflow was associated with branch HEAD `e6795092a2a706f1d2cde9c23f1d54b898bdee9f`, but `git rev-parse HEAD` in the job printed the temporary PR merge commit `c486ebd0d812ab80ed5b5dfe5a2ee6d4ae4f23c3`. This is **not** exact branch HEAD CI. PostgreSQL `SHOW server_version` returned `16.15`. The D->E two-worker advisory lock scenario passed and `pg_locks` showed PID 537 waiting on an advisory lock (`granted=false`) held by PID 536. The deliberately reversed E->D vs D->E scenario emitted `EXPECTED_DEADLOCK` with SQLSTATE `40P01` and `acquired`. The bounded retry scenario reported PASS at `attempt:1`; it **did not demonstrate a retry after an actual 40P01**. All application-level economic tests remain unexecuted in this workflow. Raw logs: https://github.com/sails-protocol/Sails-Protocol/actions/runs/38090384206 ; uploaded artifact ID `11683623173` (artifact SHA-256 `e5715075dafc5d7b93e1100b84bbc5e07f78908d23cc10f8e400a0bb9dc0c873`). The temporary PR #434 was closed without merge because its historical diff spanned 127 commits / 290 files. No new PR or trigger is authorized.

### Experimental lock probe

```sh
ST1_TEST_DATABASE_URL='postgresql://user:pass@localhost:5432/st1_disposable' node scripts/st1-postgres-lock-probe.cjs
```

The probe covers (1) D->E ordering across independent connections, (2) an intentional E->D / D->E deadlock yielding SQLSTATE 40P01, and (3) bounded retry after transaction abort. The probe does not write production tables. It must run only against a disposable DB.

### Mandatory application-level real-Postgres matrix (NOT EXECUTED IN ST-1 WORKFLOW; some historical tests exist but do not prove ST-1 predicate)

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

### New application-level regression cases (UNEXECUTED)

On experimental branch commits `b7649aa5`, `bb9f3d8`, and `dd377536`, the existing real-PostgreSQL test suite `tests/integration/staleDisputeCleanupSignatureRace.test.ts` gained ST1-A through ST1-E. These invoke the actual production deletion function and assert: missing caller generation rejection, mismatched supplied generation rejection, changed durable dispute generation rejection, **missing SemanticTransitionRecord must fail closed**, and provenance-less pending rejection. They have **not** been executed. ST1-D is an intentionally red acceptance gate against the current provisional implementation: the current function checks dispute, signature and committed authorization but does not require a durable Outcome before deletion. The test is not evidence of a runtime failure until actually executed. The fixture uses a direct dispute update in ST1-C, not a real `appeal()` concurrency race. ST1-E tests ambiguous provenance, not an independently created cooperative economic operation.

A future run must execute the focused suite against a disposable PostgreSQL database, preserve raw logs, then test the actual `appeal()` and reversal entry points with deterministic barriers and record row/FK lock graphs. No PASS can be assigned based solely on these added tests. No frozen economic authority was changed.

### CI preparation on experimental branch (NOT RUN)

Commit `be107205` updates the isolated ST-1 workflow to checkout the PR head SHA rather than the synthetic merge SHA, assert the checkout matches the expected SHA, execute the focused real-PostgreSQL integration suite after the synthetic probe, and upload both raw logs even if the integration step fails. The focused suite contains intentionally failing ST1-D (missing durable Outcome) against provisional production code; an all-green run is **not expected** until the policy conflict is resolved with CTO authority. This commit did not trigger a new run. Existing GitHub connector actions expose rerun of an old job but no workflow_dispatch, and rerunning the old run would not test the new HEAD. Do not claim CI PASS or rerun old evidence as new proof.

### Historical CI failures inspected (not exact current HEAD)

The historical PR run also had failing general CI jobs: `CI Tests` run #38090384074, job #114325438195, and `CI` run #38090383969, job #114325437697. In `CI Tests`, Jest could not compile `src/modules/open-settlement/dispute-pending-reconciliation.ts:175` because the helper accepted `{id, escrowId}` and cast it to full pending provenance (TS2352). This is a concrete defect, separate from ST-1 economic proof. Experimental commit `46899f7c` corrects the helper argument type to require complete provenance and removes the unsafe cast. This is **not validated by a new run**. The broader CI jobs remain failures and must not be described as green. The previous synthetic probe run was separately green.

### Open material findings

1. The provisional cleanup holds E but not D. It cannot serialize appeal N->N+1.
2. The provisional `DELETED_NO_OUTCOME` path must fail closed under the CTO's new predicate.
3. D->E global cycle absence remains unproved for implicit row/FK locks and indirect calls. The lock probe does not exercise row/FK locks.
4. Historical signer/multiworker/restart integration tests exist, and ST1-A..E are now authored, but none was executed in the ST-1 CI; N/N+1 appeal and reversal production races remain unproven.
5. Green synthetic probe ran on PR merge SHA, not exact branch HEAD; no exact-head production integration CI, mutation proof, independent Opus review, merge or FREEZE.
6. The reported bounded retry PASS used attempt 1 and is not proof of actual 40P01 recovery.
7. Existing `tests/integration/staleDisputeCleanupSignatureRace.test.ts` has real production signer/cleanup entry points and advisory-lock barriers, but the ST-1 workflow did not execute it and its historical assertions cannot substitute for the N/N+1 D->E authority predicate.

**Gate: LOCK PROBE PASS (PR merge SHA only); ST-1 ECONOMIC INTEGRATION BLOCKED.** The branch-only `workflow_dispatch` cannot be assumed runnable through the available connector: no dispatch action is exposed; the prior PR trigger was closed and the CTO prohibited another PR. No additional run is claimed.

### ST-1 follow-up: fail-closed CI and fixture inconsistency (unexecuted)

- The isolated workflow's synthetic probe previously piped `node ... | tee` without `set -o pipefail`, so a failing probe could be reported as a successful step when `tee` exited zero. Commit `f4c5cbe` adds `set -o pipefail`; **no run has validated this change**.
- `tests/integration/staleDisputeCleanupSignatureRace.test.ts` T3, T3b, T4, T5 and T6 expect an unsigned dispute round to be deleted using the common `fixture()`. That fixture creates a `RESOLVED` dispute but **no** durable `SemanticTransitionRecord` Outcome. ST1-D deliberately expects the opposite, fail-closed behavior. These assertions are mutually incompatible with the intended missing-Outcome policy; even after the implementation is corrected, the older deletion-positive fixtures must create an authentic, generation-matched durable Outcome before their success expectations are valid. Do not weaken ST1-D or fabricate an Outcome merely to make CI green.
- The provisional production helper still lacks an Outcome requirement inside its transaction, and the reconciler still exposes `DELETED_NO_OUTCOME`. This is a material policy conflict, not a proven safe cleanup. A policy-authorized implementation change and PostgreSQL execution are prerequisites for final ST-1 evidence.

### ST-1 additional unit-test policy contradiction (inspection only)

`tests/disputePendingReconciliation.test.ts` still positively asserts `DELETED_NO_OUTCOME` in **two tests**, for absent `SemanticTransitionRecord` and `outcomeContent: null`. Its `concurrent run already cleaned` test also uses `mockLoadDisputeRulingRecord(null)` to reach the delete path. These unit tests actively encode the behavior ST1-D must reject; updating only the integration suite cannot make the policy coherent. The current mock `prisma.$transaction` exposes `escrowPendingTransaction`, `dispute`, and `economicDispositionAuthorization` but **no** `semanticTransitionRecord` accessor, so a future in-transaction durable-Outcome check requires an aligned mock and new fail-closed assertions. Do not treat mock-based green tests as real Postgres concurrency proof. This finding is not a production change and has not been executed.

### ST-1 actual deadlock-victim retry probe (UNEXECUTED)

Commit `3d8b3f72eea374cac48167c71dea4c84c25f6cbd` changes only `scripts/st1-postgres-lock-probe.cjs`. The bounded-retry scenario now reuses the **actual PostgreSQL 40P01 victim** from the deliberate lock-order deadlock, asserts SQLSTATE `25P02` while its transaction remains aborted, rolls back both workers, and retries the victim under D→E order with at most three total attempts. A PASS requires a committed retry after a demonstrated `40P01`, rather than a first-attempt success. This is a stronger synthetic lock probe, **not an application-level economic proof**, and it has not been executed on the updated HEAD. No production economic code or frozen authority changed.

### CTO-authorized ST-1 authority implementation (UNVERIFIED)

The CTO explicitly authorized fail-closed missing-Outcome correction and experimental D→E locking. Commits `1d4530ad`, `253d0b75`, `cbbe6c71` implement the following on the isolated branch: remove `DELETED_NO_OUTCOME` deletion and log a failed reconciliation while preserving the pending row; acquire economic-disposition advisory lock by **dispute ID** before escrow advisory lock; inside that same transaction recheck pending generation, dispute, durable SemanticTransitionRecord Outcome and committed economic authorization before conditional delete; align unit mocks and missing-Outcome expectations. These changes are **not CI-tested**. The existing real-Postgres integration fixture lacks a durable Outcome for historical positive-delete cases; those tests must be made authoritative before claiming PASS. No N/N+1 actual appeal/reversal barrier test or indirect row/FK lock graph has been executed. Prior synthetic retry commits `3d8b3f72` and `894eda65` also remain unexecuted. The ST-1 experimental branch is not a release or freeze candidate.

### ST-1 additional safety regressions (UNEXECUTED)

Commit `27c0fb4943aa1a51f38afc4e800f8a63a3c584c1` adds mocked transactional-boundary assertions for (1) durable Outcome disappearing after scan but before the locked delete, (2) an already-committed economic disposition authorization, and (3) a changed dispute generation. All must reject deletion. These tests are unit regression only, not PostgreSQL concurrency proof. Earlier `8b79e139` adds a real-Postgres D-lock wait barrier using a fixture mutation rather than production appeal(); `c5aa32f6` adds the unit lane to the isolated workflow. No execution or exact-head CI result is available for these changes. Historical T3/T3b/T4/T5/T6 positive-deletion fixtures still lack an authoritative durable Outcome; do not report them as passing until a legitimate Outcome fixture or real ruling path exists. No PR merge, deploy, restack or FREEZE.

### ST-1 additional PostgreSQL scenario staged, not run

Commit `339170e8b2977820499b4ae6be54a5caaba647fb` adds ST1-G: two independent Prisma/module instances concurrently call production `deletePendingRoundIfStillUnsigned()` against a real PostgreSQL fixture intentionally missing a durable Outcome; both must return `PROVENANCE_REJECTED`, preserve the pending row and signature count, and preserve that result on replay. This is a *staged test*, not a PASS. Existing T3/T3b/T4/T5/T6 still demand deletion of a missing-Outcome fixture, which is incompatible with CTO-authorized fail-closed policy; they must be replaced with real authoritative Outcome fixture/prod ruling setup, not weakened to synthetic `outcomeContent`. The workflow still has no exact-HEAD run. Do not claim `READY_FOR_CTO_ST1_AUTHORITY_IMPLEMENTATION_REVIEW`.

### ST-1 immutable Outcome binding hardening (UNEXECUTED)

Commits `af345086203f1f3ef0e2c5491e5de8829d4d27c5` and `96cae6779a1dcfd3353531c2cff48f545e396b82` tighten the cleanup predicate: the live Dispute authority issuance timestamp must match the pending generation, and the durable SemanticTransitionRecord must have `toState=RESOLVED` and an Outcome ruling matching the pending generation. Unit regressions reject a mismatched immutable ruling and a changed issuance timestamp. No CI or real PostgreSQL evidence has been obtained on this HEAD. Existing integration fixtures are not yet authoritative. Preserve BLOCKED and no FREEZE.

### ST-1 fixture conflict resolved as fail-closed negative proof, not positive deletion proof

Commit `2f7b9a39e7ab0a9d13d91d28e14ccb08deaa1732` replaces historical T3/T3b/T4/T5/T6 assertions that demanded deletion of a pending operation without any durable Core-authoritative Outcome. The revised real-Postgres scenarios assert the CTO-required fail-closed preservation under signer ordering, concurrent workers and independent-module replay. This does NOT count as evidence of the authorized positive deletion path: that still requires a legitimate `commitAuthoritativeDisputeRuling()` record with attributed authority, signature and bound Outcome, plus proof that a failed translation guard can delete safely. No suite was executed on this commit; no exact-HEAD CI, no production appeal N/N+1 or reversal race proof. Do not merge or FREEZE.

### ST-1 fixture issuance and malformed record guards (UNEXECUTED)

`c2abacac74b80ed3d981aa6a90df295dbb3ef32f` aligns the synthetic PostgreSQL fixture's Dispute `authorityIssuedAt` with the pending generation (previously only `resolvedAt` was set, making the newer authority-time revalidation reject even before checking missing Outcome). This fixture remains deliberately without a durable Outcome and is not positive deletion proof. `fd1ff39350107475d869d4550463d4b21da4ef6f` adds unit guards for a non-RESOLVED transition and malformed JSON without a ruling. All are unexecuted. An actual signed and attributed authority decision, production appeal/reversal interleavings, crash/replay and exact-HEAD CI remain required before READY or FREEZE.

### ST-1 stale documentation corrected and mocked positive branch (UNEXECUTED)

`c4f5f168294a53717c63d3a197fa90cfc3e85030` removes the unsafe historical assertion that zero signatures alone authorizes unconditional deletion, explicitly documenting D→E, immutable Outcome, generation and economic authorization checks. `a3651b0d4fd5291b9363eecb39731e19dbba1b62` adds a unit-level positive-branch assertion using a mocked terminal Outcome, not a real economic authority or Postgres proof. Neither test nor build was executed. A real attributed signature, production-created SemanticTransitionRecord and N/N+1, reversal, crash/replay, `40P01`/`25P02` and exact-HEAD CI remain open. This branch must remain BLOCKED, with no READY/FREEZE.

### ST-1 legacy/cross-escrow/provenance negative unit regressions (UNEXECUTED)

`5e3f9cd1719a4ca08455fc3d4ec3bf2b15cc4f64` adds mocked service-boundary tests that reject missing caller generation before lock acquisition, an escrowId mismatch before Outcome lookup, and changed pending authority signature before Outcome lookup. These do not replace real PostgreSQL proof. No execution evidence or exact-head CI; positive attributed Outcome, N/N+1 appeal, reversal and crash/replay remain unresolved. Keep PR #343 BLOCKED.

### ST-1 scan-time authority consistency (UNEXECUTED)

`ce140c437f53bcec04716d4148ea39e27e2e45d3` requires the scan's live RESOLVED Dispute to match the pending authority issuance timestamp, and requires the loaded immutable Outcome to match the pending ruling and terminal RESOLVED state before translation. This is defense in depth; only the D→E transactional revalidation authorizes destructive effects. `007854004bb8425e3aa59b3c864b1b4a679a7d34` adds mocked negative regressions for ruling mismatch and nonterminal record. Not run; no exact-head CI or real positive PostgreSQL authority proof. PR #343 remains BLOCKED.

## ST1-H/I PostgreSQL regressions (UNEXECUTED)

`183a6d2d24ef0189e8e56095eca9dd8a969378b6` adds real-Postgres tests (not yet run) that mutate the Dispute's live authority issuance timestamp and attempt cleanup using a different escrow ID. Both must reject with the original and unrelated pending rounds preserved. These are negative synthetic fixture tests, not real authority issuance, production appeal/reversal or positive deletion evidence. Do not infer execution success or FREEZE.

### ST-1 exact authority issuance scan predicate (UNEXECUTED)

`cec69db4e0be8d938e4ed805621d032dcb91161c` asserts that scan-time `dispute.findFirst` includes `authorityIssuedAt` equal to the pending ruling generation, and does not load Outcome or delete after a failed re-check. Production `commitAuthoritativeDisputeRuling` writes this field from `new Date(payload.issuedAt)`. This is mocked negative coverage only. CI and real-Postgres authority positive/appeal/reversal evidence are still absent. No approval or FREEZE.
