# RECOVERY_RECONCILIATION_CONFORMANCE_EVIDENCE.md

### Recovery / Reconciliation Conformance Mission — Evidence Record

> Follows this repository's own evidence-artifact convention
> (`docs/CONDITION_ALGEBRA_CONFORMANCE_EVIDENCE.md`,
> `docs/PROVIDER_SUBSTITUTION_INVARIANCE_EVIDENCE.md`). This is
> evidence, not a marketing document — `OUTPUT != EVIDENCE != PROPERTY
> != CLAIM`.

## 1. Baseline

- **Commit at mission start:** `10e28071776dc511e68cae2102c9863b95e96944`
  (`main`, clean working tree — verified via `git status --short`
  before any file was touched)
- **`@satsails/p2p-trading-sdk` version:** `0.1.3` (unchanged)
- **Protocol fee:** `PROTOCOL_FEE_RATE` default `0` (unchanged)
- **Provider Substitution baseline present:** confirmed — PR #60 content
  (`docs/PROVIDER_SUBSTITUTION_INVARIANCE_EVIDENCE.md`) present on `main`.

## 2. Source Hierarchy

```
NORMATIVE / SEMANTIC AUTHORITY
  docs/PROTOCOL_INVARIANTS.md (INV-05 immutability, INV-OP-11)
  docs/SEMANTIC_KERNEL.md section 14 (Recovery Classification)
  docs/CORE_ARCHITECTURE.md section 40 (Recovery Boundary)

ARCHITECTURAL
  docs/CORE_IMPLEMENTATION_ARCHITECTURE.md section 29 (Migration Sequence, M9 scope)
  docs/DESTINATION_AUTHORITY_ARCHITECTURE.md sections 12, 13, 15

EVIDENTIARY
  commit b0c581d "docs(recovery): freeze Mission 9 recovery baseline"
  commit 38c1c7d "M9-R recovery closure"
  commit ea0f885 "M8-RF — MULTISIG REFUND destination consistency"
  commit c3ac173 "M9-F — release-leg finality & reorg closure (C18)"
  docs/TECHNICAL_DEBT_AUDIT.md items 40-43 (registered residuals)

IMPLEMENTATION
  src/modules/open-settlement/dispute-dispatch-recovery.ts (C4)
  src/modules/open-settlement/escrow-settlement-reconciliation.service.ts (C8, C5/C13-C14)
  src/modules/open-settlement/dispute-pending-reconciliation.ts (stale-pending)
  src/modules/open-settlement/multisig-release-reorg-sweep.ts (C18)
  src/modules/open-settlement/multisig-funding-reorg-sweep.ts / multisig-fee-reorg-sweep.ts

TEST
  tests/escrowSettlementReconciliation.test.ts, disputePendingReconciliation.test.ts,
  multisigReleaseReorgSweep.test.ts, multisigFundingReorgSweep.test.ts,
  multisigFeeReorgSweep.test.ts, expiryRecoveryAuthority.test.ts, reconciliation-poisoning.test.ts
  tests/integration/{m9rClaimRecovery,m9rDispatchRecovery,m9fReleaseReorg,
  disputeOutcomeMultisigLive,expiryRecoveryStateMachine,semanticTransitionRecordAtomicity}.test.ts (real Postgres)
```

**No material conflict found among the normative/architectural sources.**
CORE_ARCHITECTURE.md §40 ("reconstruct execution != reconstruct
authority"), SEMANTIC_KERNEL.md §14 ("Recovery is not Semantic Kernel
identity... concern semantic validity while the system is operating"),
and DESTINATION_AUTHORITY_ARCHITECTURE.md §13's timing table ("During
recovery: Recovery reads the Outcome's own historically-bound
destination — never whatever is currently registered") are mutually
consistent and were read, in that order, **before** any recovery source
file was opened for this mission.

## 3. Sources Inspected

Full list in §2 above, plus: `docs/GITHUB_PROJECT.md` (Mission history
table, Registered Residuals table), `docs/architecture/README.md` and
`docs/architecture/archify/recovery.workflow.json` /
`settlement-destination.architecture.json` (Archify diagram sources —
used as a secondary cross-check only; per that README's own disclaimer,
"where a diagram and a document ever appear to disagree, the document
governs"), `src/modules/open-settlement/dispute-correspondence.ts`,
`dispatch-translation-guard.ts`, `dispute-outcome.ts`, `dispute-dispatch.ts`,
`multisig.provider.ts`, `escrow-repository.ts`.

## 4. Recovery Operation Taxonomy (R1-R8)

| Class | Definition | Supported by repository truth? | Evidence |
|---|---|---|---|
| R1 — Crash reconstruction | Process died after some durable facts existed | **Yes, MULTISIG only** | C4 (`dispute-dispatch-recovery.ts`), C8 (`escrow-settlement-reconciliation.service.ts` PASS 0) |
| R2 — Execution retry | Already-authorized action needs another execution attempt | **Partial** | PASS 1 asks the chain first, never blindly retries the provider; full multi-attempt (T1/T2 coexistence) is NOT representable — TECHNICAL_DEBT_AUDIT.md #40, already-tracked, not pursued here |
| R3 — External settlement reconciliation | External system has facts not yet reflected internally | **Yes, MULTISIG only** | PASS 1's `reconcilePendingSettlement()` |
| R4 — Pending-state reconciliation | Workflow remains pending while external reality evolved | **Yes, MULTISIG only** | `dispute-pending-reconciliation.ts` |
| R5 — Reorg handling | Previously observed chain state becomes non-canonical | **Yes, MULTISIG only** | `multisig-release-reorg-sweep.ts` (World A-E), `multisig-funding-reorg-sweep.ts`, `multisig-fee-reorg-sweep.ts` |
| R6 — Historical verification | Previously completed interaction inspected later | **Partial — durable facts exist, no public read surface** | TECHNICAL_DEBT_AUDIT.md #41 (Settlement Consistency Read Surface, already tracked) |
| R7 — Manual recovery initiation | Human/operator causes recovery to run | **Yes, one scoped case** | `expiryRecoveryAuthority.test.ts` (`initiateExpiryRecovery()`) |
| R8 — Correspondence reconstruction/recording | Recovery may produce/record correspondence facts | **Yes, MULTISIG only** | `recordLiveCorrespondenceIfApplicable()` called from PASS 0/1/2 |

**Central scope finding, verified directly (not assumed):** every one of
R1/R3/R4/R5/R8's real implementations is exclusively MULTISIG-scoped.
`dispute.service.ts`'s `resolveDispute()` only commits a durable,
Core-authoritative Outcome (`applyRulingCoreAuthoritative()`) for
`escrowForBranch.type === 'MULTISIG'`; every other real provider
(LIGHTNING_HODL, WDK_USDT_EVM, SAFE_GUARD_EVM) uses the legacy
`applyRuling()` path, which produces no durable Outcome record for C4
recovery to ever find. `escrow-settlement-reconciliation.service.ts`'s
own header states PASS 1 "asks the chain, for MULTISIG only ... every
every other rail fails closed" verbatim. See §16 BACKLOG DELTA.

**Recovery limits by rail (Corrected/Implemented 2026-11-27).** Summary of what this record and the WDK evidence documents establish; a durable store of events is not a recovery guarantee, and an external result that is unknown stays unknown until a reconciler asks the external system.

| Rail | What recovers after a crash or an unknown external result | Limits |
|---|---|---|
| `MULTISIG` | Crash reconstruction, chain-first reconciliation of pending settlements, pending-state reconciliation, reorg sweeps and correspondence recording (R1, R3, R4, R5, R8 above): the reconciler asks the chain before acting and never blindly retries the provider. | Scoped per sweep confirmation depth, not a universal finality model; a release reorg is flagged for manual review, never rebroadcast automatically; one disclosed micro-value mainnet rehearsal only. |
| `WDK_USDT_EVM` | A provider-local execution-truth layer (`WdkTransferAttempt`, `docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` section 22; `docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md` section 15): unknown submission outcomes block a repeat transfer until reconciled, and a split tracks its two legs as independent attempts so a confirmed leg is never replayed. | Not the chain-first reconciler above, and no automatic resolution of an unknown outcome; residuals are listed in the section 22 text; no live network test; the rail is production-ineligible (RFC-019). |
| `LIGHTNING_HODL` | Uses the legacy ruling path, which produces no durable Outcome record for the recovery above to find, and the settlement reconciler fails closed for it. Existing escrows keep their dispatch, refund and recovery paths after the Day-0 closure. | Testnet only; closed to new admissions; no per-rail recovery evidence is recorded in this document. |
| `SAFE_GUARD_EVM` | Same legacy ruling path and fail-closed reconciler as above. | Never exercised against a live bundler, key service or funded account; no recovery evidence. |
| `MOCK` | No external side effect exists to recover. | Development only; refused in production. |

## 5. Fact Taxonomy

| Category | What it is permitted to prove | Repository evidence |
|---|---|---|
| Authoritative durable fact | The economic meaning that was actually authorized | `SemanticTransitionRecord` / durable `Outcome`/`DestinationBinding`, committed once at ruling time, never re-derived |
| Durable execution fact | What execution has actually been attempted/completed | `EscrowPendingTransaction`, `Escrow.txReleaseId`, hash-chained `EscrowEvent` |
| External observation | A single query result against chain/explorer state | `fetchTransactionExistence`/`fetchTransactionConfirmationStatus`/`fetchOutpointSpendStatus` — never trusted as final on its own |
| Final/sufficient external fact | A confirmation depth judged "buried enough" for a given sweep's own purpose | Scoped per-sweep confirmation-depth threshold — **not a universal finality model**; Sails does not define one, and this mission does not invent one |
| Derived fact | Recomputed from durable + external facts, deterministic | `evaluateFinalizedTransactionCorrespondence()`'s recomputed `CorrespondenceResult`; `deriveDistributableTotal()` |
| Historical fact | Append-only, never mutated once written | `EscrowReleaseEvidence`, `EscrowFundingEvidence`, `CorrespondenceEvaluation` rows — a reorg or a new policy version always produces a NEW row |
| Current fact | May legitimately change without rewriting history | `Escrow.status`, `PayoutAddress` — explicitly **never** consulted for destination during recovery (`resolvePayoutAddress()`'s `if (explicitAddress) return explicitAddress` short-circuit, fed the historical snapshot) |
| Operator input | A human/operator action that triggers a procedure | `initiateExpiryRecovery()` — authorization-gated; per `settlement-destination.architecture.json`'s own design note, "initiating a call is not economic authority" |

`Observation != Finality` and `Historical Completion != Current
Settlement Satisfaction` are both durably preserved at the **fact**
level (append-only evidence tables) but `Historical Completion !=
Current Settlement Satisfaction` is **not** preserved at the **public
read** level — see §11/§13.

## 6. Property Definition

**Candidate property, attacked and retained:** *Recovery may reconstruct
or continue execution from authoritative durable and admissible external
facts, but must not create new economic authority, silently alter an
authorized Outcome/DestinationBinding, or treat a single external
observation as stronger than its own semantics permit.*

Derived from CORE_ARCHITECTURE.md §40 and SEMANTIC_KERNEL.md §14
**before** any recovery source file was read for this mission (§2's
ordering). Not underspecified for the scope this mission actually
found supported (MULTISIG, R1/R3/R4/R5/R7/R8) — proceeding past this
phase.

### MUST REMAIN INVARIANT

- The authoritative discretionary decision itself (never re-verified,
  never re-signed, during recovery).
- The authorized Outcome's content (ruling, allocations, remainder) —
  loaded verbatim from the durable record.
- The authorized DestinationBinding — the historical snapshot, never
  re-resolved from current `PayoutAddress` state.
- A historical fact once durably recorded (`INV-05` — never overwritten;
  a later reorg/policy-change produces a new, additional row).

### MAY LEGITIMATELY CHANGE

- The execution attempt/instance (txid, retry count) — within the one
  scalar `Escrow.txReleaseId`'s own limits (see §9's T1/T2 finding).
- Operational metadata (timestamps, log lines, which specific worker
  claimed a race).
- The *current* correspondence/consistency assessment, as a **new**,
  additively-recorded fact, when admissible external reality changes.

## 7. Authority-Preservation Findings (Phase 6)

`dispute-dispatch-recovery.ts`'s own header (read as **implementation**,
i.e. after the property in §6 was already derived) states three
constraints matching §6's MUST REMAIN INVARIANT exactly: never re-runs
discretionary authority, never reinterprets the ruling, never
re-resolves the destination from current state. Verified structurally
(the function signature has no parameter path for a new signature or a
re-derived destination) and confirmed live: rerunning
`tests/integration/m9rDispatchRecovery.test.ts` against real Postgres
this session produced the log line `"M9-R: resumed authorized dispatch
for a dispute ruling whose original dispatch never persisted (C4
recovery)"` for RELEASE, REFUND, and SPLIT rulings, each completing
using the historical destination/allocation, never a re-derived one.

`expiryRecoveryAuthority.test.ts` (rerun, passing) adversarially
confirms `MANUAL INITIATION != ECONOMIC AUTHORITY`: the buyer cannot
exercise the seller's recovery authority; the system identity cannot;
an arbitrary third party cannot; only the correct, script-committed
actor succeeds, and even then the action never persists key material.

**MR3 (manual initiator substitution) is NOT REPRESENTABLE with the
current model** — there is exactly one legitimate authorized initiator
role (the seller) per escrow, not two interchangeable ones. This is the
same class of finding
`docs/PROVIDER_SUBSTITUTION_INVARIANCE_EVIDENCE.md` §4 made for
provider pairs — not a gap, a fact about what currently exists.

## 8. Crash-Consistency Findings (Phase 7)

| Crash boundary | Durable fact after crash | Safe to retry? | Evidence |
|---|---|---|---|
| C4 — Outcome committed, before PSBT persisted | `SemanticTransitionRecord` | Yes — `RESUME_AUTHORIZED_DISPATCH` | `m9rDispatchRecovery.test.ts` (real Postgres, rerun) |
| C8 — signatures persisted, before transition claimed | `EscrowPendingTransaction` (fully signed) | Yes — PASS 0 asks chain first, then claims | `m9rClaimRecovery.test.ts` (real Postgres, rerun) |
| C13/C14 — completion effects ran, correspondence not recorded | `Escrow.txReleaseId` | Yes — PASS 2 reconstructs from surviving pending row or real tx | `disputeOutcomeMultisigLive.test.ts` (real Postgres, rerun) |
| C18 — release leg reorged after being observed confirmed | `EscrowReleaseEvidence(OBSERVED_CONFIRMED)` | N/A — flagged for manual review, never auto-rebroadcast | `m9fReleaseReorg.test.ts` (real Postgres, rerun) |

Provider txid integrity (R6, M9-R): rerunning the real-Postgres suite
this session produced `"MULTISIG provider: broadcast response txid
disagrees with the locally-derived txid of the exact transaction that
was sent — ignoring the provider-reported value, persisting the
locally-derived one"` — a live, real demonstration (not asserted from a
prior report) that a divergent provider-reported value is rejected in
favor of the self-derived one.

## 9. Retry / Multi-Attempt Findings (Phase 8)

`TECHNICAL_DEBT_AUDIT.md` #40 (already-tracked, explicitly excluded
from this mission's BACKLOG DELTA per its own instruction): a real T2
constructed under the same durable Outcome, with a different mining fee
(hence different txid), mechanically passes the same real guard a live
dispatch uses — T2's *authorization* is already resolved; what is
missing is the schema's capacity to *model* T1 and T2 coexisting.

**This mission did not need to resolve it**, because
`reconcileMissingDispatch()`'s own candidate query structurally excludes
every terminal escrow — no supported recovery path in this repository
ever attempts a second execution attempt against an already-terminal
escrow today. Recovery Conformance for the scenarios this mission
actually claims (§14) does not depend on T1/T2 being solved.

**T1/T2 — NOT REPRESENTABLE.** Not solved, not redesigned, no schema
added, no execution-attempt abstraction introduced, and the mission
property (§6) was not weakened to route around it — it remains exactly
the existing tracked residual it already was.
`BACKLOG DELTA: ZERO` contribution from T1/T2 (already known).

## 10. Observation / Finality Findings (Phase 9)

**Precise scope of this finding, stated explicitly:** re-querying
external reality on every sweep run is not, by itself, evidence of a
universal finality model — it is evidence of a narrower, correctly
scoped property. **Observation/Finality discipline is demonstrated for
the tested MULTISIG reconciliation/reorg behaviors: recovery does not
treat a previously cached observation as permanently authoritative, and
always re-evaluates current external evidence before acting on it. No
universal finality model is defined by this repository, and none is
demonstrated or invented by this mission.**

Each sweep (`multisig-release-reorg-sweep.ts` et al.) defines its own
scoped "buried enough" confirmation-depth threshold for its own purpose
only — this threshold is a local heuristic, not a protocol-wide finality
definition. `OBSERVATION != FINALITY` is preserved by construction:
every sweep run **re-asks the real explorer** rather than trusting a
cached belief (`multisig-release-reorg-sweep.ts`'s own header, "CHAIN
TRUTH DOMINATES... never trusts a cached 'it was CONFIRMED at
recognition time' belief"), and a stale/absent/conflicting observation
is classified into a distinct World (B/C/D/E) rather than silently
promoted to certainty.

## 11. Reorg Findings (Phase 10)

`REORG != DIVERGENCE` preserved by construction: `EscrowReleaseEvidence`
and `CorrespondenceEvaluation` are two structurally separate tables/code
paths. World C (`multisig-release-reorg-sweep.ts`'s own header, quoted
verbatim): *"nothing here ever writes DIVERGENT, reinterprets the
Outcome, or claims the destination/authority became invalid. A reorg
changes the current ledger-inclusion status of an already-authorized,
already-correspondence-evaluated execution — never its economic
meaning."* Verified live this session (`m9fReleaseReorg.test.ts`, real
Postgres, rerun): a simulated World C reorg is recorded as
`REORGED_INVALIDATED` and flagged for manual review, while the original
`OBSERVED_CONFIRMED` fact is left intact, never erased.

## 12. Historical / Current-State Separation Findings (Phase 11)

`Historical Completion != Current Settlement Satisfaction` is preserved
at the **durable-fact level** (append-only `EscrowReleaseEvidence`) but
**not** at the public-read level: `TECHNICAL_DEBT_AUDIT.md` #41
(already-tracked, Project card "Settlement Consistency Read Surface")
states verbatim that `Escrow.status = COMPLETED` with a
`REORGED_INVALIDATED` evidence row already recorded is indistinguishable
to any public reader (`GET /v1/settlement/escrows/:id`) from a healthy
completion. This mission does not decide whether history should be
rewritten, the workflow reopened, or a new current-state fact recorded
— those questions are explicitly out of scope (already-tracked debt,
Product Direction owns the next step per that item's own text).
**Verdict for this property: PARTIAL**, not DEMONSTRATED (see §14).

`Workflow Terminal != Mathematical Irreversibility` holds in the same
sense: a `COMPLETED` escrow is workflow-terminal, but its underlying
Bitcoin transaction remains subject to real chain reality (reorg),
which is exactly what M9-F's sweep exists to detect — the workflow
label alone was never treated as cryptographic finality.

## 13. Correspondence Intersection (Phase 12)

Per Backlog Delta Sync #6's own finding, `recordLiveCorrespondenceIfApplicable`
is called identically from the happy path (`escrow-pending-tx.ts:417`)
and from recovery (`escrow-settlement-reconciliation.service.ts:210,504`).
Verified directly:

- **Reconstructed or copied?** Reconstructed — the recovery call sites
  re-derive `rawTxHex` from a surviving pending row or a real chain
  query, then call the *same deterministic function* used live.
- **Can recovery create a fact ordinary execution would not?** No — the
  function is documented as not needing to know whether it is a
  recovery call ("the same deterministic function, given the same
  historical Outcome and the same real transaction bytes, always
  recomputes the identical result").
- **Can recovery convert provider success into MATCH?** No — the
  function never consumes a provider-success boolean; it only consumes
  reconstructed real transaction bytes.
- **Can recovery record stale correspondence?** No — verified live this
  session: rerunning the real-Postgres suite produced the log line
  `"FAIL CLOSED: recomputed correspondence disagrees with an existing
  record under the IDENTICAL evaluator+policy identity — a semantic
  inconsistency, never silently overwritten or re-emitted."`
- **If external reality changes, can correspondence change without
  rewriting historical authority?** Yes, via a new row under a new
  policy-version identity — additive, never an overwrite.
- **Detection-only or can it alter recovery authority?** Detection-only,
  confirmed — `escrow-settlement-reconciliation.service.ts`'s comment:
  "never allowed to fail the settlement," and the FAIL CLOSED path only
  logs; the escrow's own terminal state is unaffected.

**This mission did not expand Live Correspondence Coverage** — no
provider path gained new correspondence wiring; the intersection was
investigated only as far as Recovery Conformance required.

## 14. Reconciliation Idempotence Findings (Phase 13)

**Semantic idempotence: DEMONSTRATED** for the tested MULTISIG paths.
Repeating C4/C8/C5 reconciliation over unchanged facts creates no new
economic authority and no duplicate economic execution — verified via
real duplicate-worker races (`m9rClaimRecovery.test.ts`,
`m9rDispatchRecovery.test.ts`, both real Postgres, rerun) and
`emitEscrowTransition()`'s own atomic per-`(escrowId, toStatus)`
idempotency (`escrowSettlementReconciliation.test.ts`, rerun: "first call
creates the row + fires event bus; second call ... is a safe no-op").

**Operational side-effect idempotence is explicitly NOT required to
match** — a retry legitimately produces new log lines, a new
`CorrespondenceEvaluation` row under a changed policy identity, or a
different winning worker, none of which is treated as a semantic
violation.

## 15. Metamorphic Relations (Phase 14)

| Relation | Verdict | Evidence |
|---|---|---|
| MR1 — Crash-location invariance | **SUPPORTED** | C4 and C8 are different crash boundaries; both converge to the same authorized meaning (§8) |
| MR2 — Reconciliation repetition | **SUPPORTED** | §14 |
| MR3 — Manual initiator substitution | **NOT REPRESENTABLE** | §7 — only one legitimate initiator role exists per escrow |
| MR4 — Execution-attempt substitution | **SUPPORTED** | R6 provider-txid-integrity, live-demonstrated this session (§8) |
| MR5 — Observation freshness | **SUPPORTED** | RECONFIRMED-after-invalidated append-only pattern (§10) |
| MR6 — Reorg transformation | **SUPPORTED** | World C, live-demonstrated this session (§11) |
| MR7 — Restart invariance | **SUPPORTED** | Subsumed by C4/C8 evidence — every tested crash-restart scenario preserves authorized meaning |

Rejected as a general law: no "nesting"-equivalent relation was
proposed for recovery, and none is needed — the C4/C8/C13-14/C18
boundaries are independently, exhaustively enumerated crash windows,
not a recursive structure.

## 16. Wrong-Recovery / Mutant Evidence (Phase 17)

**No new mutant code was written.** The existing evidence surface
already allowed evaluation without manufacturing anything, per Phase 17's
own gate ("only if the existing evidence surface allows it without
architectural changes"):

| Mutant | Real, already-existing rejection evidence | Class |
|---|---|---|
| W1 — Re-authorize on recovery | Structural — no parameter path exists to supply a new signature; not separately runtime-attacked | Structural only |
| W2 — Destination mutation | `m9rDispatchRecovery.test.ts` + `m9fReleaseReorg.test.ts`'s D1->D2 rotation test | **Adversarially tested, PASS** |
| W3 — Outcome mutation (RELEASE<->REFUND) | Structural — `record.outcome.content` loaded verbatim, no mutation path; not separately runtime-attacked | Structural only |
| W4 — Operator authority injection | `expiryRecoveryAuthority.test.ts` (buyer/system/third-party rejection) | **Adversarially tested, PASS** |
| W5 — Provider-success laundering | Live this session: provider-reported txid disagreement rejected | **Adversarially tested, PASS** |
| W6 — Observation-as-finality | World C/D classification, never promotes a single observation to certainty | **Adversarially tested, PASS** |
| W7 — Terminal-state absolutism | TECHNICAL_DEBT_AUDIT.md #41 — **this one is a real, already-tracked gap**, not a rejected attack | **Gap found (already known)** |
| W8 — Duplicate execution | Real duplicate-worker races, all real-Postgres, rerun | **Adversarially tested, PASS** |
| W9 — History rewrite | World C test — original fact never erased | **Adversarially tested, PASS** |
| W10 — Reorg-as-provider-divergence | Structural — separate tables/functions; not separately runtime-attacked | Structural only |

Consistent with `docs/PROVIDER_SUBSTITUTION_INVARIANCE_EVIDENCE.md`'s
own learned precision discipline: structural absence-of-coupling
evidence (W1, W3, W10) is reported as structural, not conflated with a
live-rejected-attack proof.

## 17. Independent Expectation Generation (Phase 18)

Per §2/§6, the property and its MUST-REMAIN-INVARIANT/MAY-LEGITIMATELY-CHANGE
lists were derived from `CORE_ARCHITECTURE.md` §40,
`SEMANTIC_KERNEL.md` §14, and `DESTINATION_AUTHORITY_ARCHITECTURE.md`
§13 **before** `dispute-dispatch-recovery.ts` or any other recovery
source file was opened. The subsequent match between that
independently-derived expectation and the implementation's own header
comments was then **verified**, not assumed — by rerunning the real
tests fresh in this session (§8/§10/§11/§13/§14) rather than trusting
prior reports or the code's own self-description.

## 18. Conformance Surface Decision (Phase 19)

Recovery/Reconciliation Conformance is **cross-layer integration
evidence**, not a pure evaluator-vector surface — consistent with the
mission's own instruction that "conformance does not imply everything
must fit into a JSON evaluator." No new conformance framework was
created; the existing real-Postgres integration test lane
(`test:integration:postgres`) and the existing mocked unit-test suites
already represent this property adequately for the scope this mission
found supported.

## 19. Testability / Implementation Gate (Phase 20)

All five gate conditions were met without requiring new Core primitives,
recovery semantics, schema redesign, attempt-model redesign,
correspondence redesign, a universal finality model, or a new
settlement provider. Property independently defined (§6); semantic
authority identified (§2); expected results independently derived
before implementation was read (§17); current architecture represents
the supported scenarios (§4); evidence distinguishes correct from
incorrect recovery (§16). **Implementation authorized only for minimal
mission-scoped evidence — this document. No production code was
changed.**

## 20. Real Persistence Evidence (Phase 20/22)

Local Postgres started (`npm run db:local:start`), migrations confirmed
already applied (`npx prisma migrate deploy` — "No pending migrations").
Real-Postgres suites rerun this session:

```
SAILS_INTEGRATION_TEST_DB_CONFIRMED=yes-i-am-sure NODE_ENV=test npx jest --runInBand \
  tests/integration/m9rClaimRecovery.test.ts tests/integration/m9rDispatchRecovery.test.ts \
  tests/integration/m9fReleaseReorg.test.ts tests/integration/disputeOutcomeMultisigLive.test.ts \
  tests/integration/expiryRecoveryStateMachine.test.ts tests/integration/semanticTransitionRecordAtomicity.test.ts

Test Suites: 6 passed, 6 total
Tests:       43 passed, 43 total
```

`Mock persistence evidence != durable recovery evidence` — the crash-
consistency, idempotence, and provider-txid-integrity claims in §8/§9/§14
are grounded in this real-Postgres run, not only in mocked unit tests.

## 21. Reference Implementation Results (Phase 21)

Mocked unit suites also rerun (`tests/escrowSettlementReconciliation.test.ts`,
`disputePendingReconciliation.test.ts`, `multisigReleaseReorgSweep.test.ts`,
`multisigFundingReorgSweep.test.ts`, `multisigFeeReorgSweep.test.ts`,
`expiryRecoveryAuthority.test.ts`, `reconciliation-poisoning.test.ts`):
7/7 suites, 81/81 tests passed. Combined with §20: **13 suites, 124
tests, 0 failures.** All accepted scenarios (§4/§16) passed; zero
mutants survived (of the 7 adversarially-testable ones); zero
implementation defects found. **No expected vector was altered to
obtain a pass.**

## 22. Property-by-Property Verdicts (Phase 25)

| Property | Verdict |
|---|---|
| Authority Preservation | **DEMONSTRATED** (MULTISIG scope) |
| Outcome / Destination Preservation | **DEMONSTRATED** (MULTISIG scope) |
| Observation / Finality Discipline | **DEMONSTRATED for tested MULTISIG behavior** — no universal finality model defined or demonstrated |
| Reconciliation Idempotence | **DEMONSTRATED** (semantic; operational side-effects legitimately vary) |
| Historical / Current-State Separation | **PARTIAL** — durable-fact level yes; public-read level no (TECHNICAL_DEBT_AUDIT.md #41, already tracked) |
| Reorg Discipline | **DEMONSTRATED** (MULTISIG scope) |
| Crash Reconstruction | **DEMONSTRATED** for C4/C8/C13-14/C18; **NOT REPRESENTABLE** for post-terminal World-C auto-convergence (T1/T2, already tracked) |

## 23. Implementation Defects

**Zero.** No defect against the independently-derived property (§6) was
found in any tested scenario.

## 24. Regression Results

- `npm run check:core-boundary` — clean
- `npx tsc --noEmit` — clean
- Real-Postgres recovery suites — 6/6, 43/43 (§20)
- Mocked recovery/reconciliation suites — 7/7, 81/81 (§21)
- No file under `src/` or `packages/` modified — no broader regression
  run required (documentation-only change)

## 25. Smallest Defensible Claim

**Confirmed final claim (CTO-reviewed wording):**

**"Sails demonstrates that its supported MULTISIG recovery/reconciliation
paths reconstruct or continue execution from durable and admissible
external facts without re-authorizing selected economic meaning under
the tested crash, retry, reconciliation and observation scenarios."**

Attacked against the evidence above and confirmed, not narrowed
further — "supported MULTISIG" (§4/§8's exclusive scope finding),
"reconstruct or continue execution" (§7/§8), "without re-authorizing
selected economic meaning" (§7), "tested crash, retry, reconciliation
and observation scenarios" (§8/§9/§10/§14). A broader claim would not
survive; this exact wording is retained as the governing sentence for
this evidence artifact and any future freeze record.

**Supporting elaboration (same claim, with the specific crash windows
named):** Sails demonstrates that its supported recovery/reconciliation
paths — all currently scoped to MULTISIG — reconstruct or continue
execution from durable and admissible external facts without
re-authorizing selected economic meaning, under the tested crash (C4,
C8, C13-14, C18), retry, and observation scenarios.

Deliberately not "universal recovery correctness," "exactly-once
settlement globally," "reorg safety across every rail," "universal
finality," "all-provider recovery," "production-grade recovery," "full
K3 conformance," "full Sails conformance," or "formal verification" —
none of these are supported by the evidence above.

## 26. NOT PROVEN

- Recovery/reconciliation for any rail other than MULTISIG — LIGHTNING_HODL,
  WDK_USDT_EVM, and SAFE_GUARD_EVM have zero automated crash-recovery
  coverage today (§4, §27 BACKLOG DELTA).
- Multi-attempt execution identity (T1/T2) — already-tracked
  (TECHNICAL_DEBT_AUDIT.md #40), not resolved here, not needed for the
  scenarios this mission claims.
- A public read surface distinguishing historical completion from
  current settlement satisfaction — already-tracked (TECHNICAL_DEBT_AUDIT.md #41).
- Volume semantics after settlement invalidation — already-tracked
  (TECHNICAL_DEBT_AUDIT.md #42).
- Independent re-derivation of a historical correspondence MATCH once
  the underlying transaction becomes chain-unavailable — already-tracked
  (TECHNICAL_DEBT_AUDIT.md #43).
- A universal finality model — none exists, none is invented here.
- W1/W3/W10 as *adversarially tested* (only structural evidence exists
  for these three).
- MR3 (manual initiator substitution) — not representable with the
  current single-authorized-initiator model.
- Full K3 conformance, full Sails conformance, formal verification,
  production readiness of any kind.

## 27. COBRA / Goodhart Check

- **Did we derive expected behavior from recovery code itself?** No —
  §2/§6/§17 establish the read order (docs before code) and this was
  followed.
- **Did we turn existing behavior into the definition of conformance?**
  No — the property (§6) was fixed before `dispute-dispatch-recovery.ts`
  was opened; the code was then checked against it, not the reverse.
- **Did we narrow the property after seeing failures?** No — zero
  failures were found; nothing was narrowed to manufacture a pass.
- **Did we confuse workflow recovery with economic recovery?** No — §12
  explicitly keeps `Workflow Terminal != Mathematical Irreversibility`
  distinct, and §14 distinguishes semantic from operational idempotence.
- **Did we treat terminal workflow state as irreversible external
  reality?** No — §12/§14's own finding is precisely that it is NOT
  (M9-F's whole purpose).
- **Did we treat an observation as finality?** No — §10 explicitly
  disclaims a universal finality model.
- **Did we allow the recovery initiator to become authority?** No — §7's
  `MANUAL INITIATION != ECONOMIC AUTHORITY` finding, adversarially
  tested.
- **Did we count retry metadata changes as semantic violations?** No —
  §14 explicitly separates semantic from operational idempotence.
- **Did we demand exact operational equality where only economic
  meaning must remain invariant?** No — same as above.
- **Did we call mocks durable evidence?** No — §20 explicitly ran real
  Postgres for every crash-consistency/idempotence/provider-integrity
  claim; §21's mocked suites are cited only for the properties that do
  not depend on persistence.
- **Did we absorb the known T1/T2 residual merely to obtain PASS?** No —
  §9 explicitly declines to solve it and explains why the claim in §25
  does not need it.
- **Did we expand Live Correspondence Coverage simply because recovery
  touches correspondence?** No — §13 explicitly states no provider
  gained new correspondence wiring.
- **Did we optimize test/vector count rather than the underlying
  recovery property?** No — no new tests were written; 13 suites/124
  tests were reused and rerun, not multiplied.

No STOP triggered by this check.

## 28. Backlog Delta

**One genuinely new, material delta found — see §26/§4.**

**Recovery/Reconciliation Coverage Across Settlement Paths.** All real
M9 recovery/reconciliation machinery (C4, C8, C13-14, C18, and the three
reorg sweeps) is exclusively MULTISIG-scoped, verified directly:
`resolveDispute()` only produces a durable, Core-authoritative Outcome
for `escrowForBranch.type === 'MULTISIG'`, so C4 recovery structurally
never finds a candidate for any other rail; `escrow-settlement-reconciliation.service.ts`'s
own header states PASS 1 fails closed for every non-MULTISIG rail. A
crash during LIGHTNING_HODL, WDK_USDT_EVM, or SAFE_GUARD_EVM execution
has no automated recovery path today. Distinct from — not a duplicate of
— Backlog Delta Sync #6's "Live Correspondence Coverage Across
Settlement Paths" (that delta concerns post-execution *divergence
detection*; this one concerns *crash-recovery automation itself*, a
different mechanism):

```
Correspondence coverage:
Is divergence being detected/recorded?

Recovery coverage:
Can execution/state be reconstructed or reconciled correctly?
```

**The primary backlog question this delta records is not "implement
recovery for every rail."** It is the earlier, unanswered
architectural/product question: which settlement paths are intended to
survive, and what recovery/reconciliation obligations — if any — does
each surviving path require? This mission does not answer that question,
does not implement recovery for any additional rail, and does not
Project-sync this delta (no such authority granted).
