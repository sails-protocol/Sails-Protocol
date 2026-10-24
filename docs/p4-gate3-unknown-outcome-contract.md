# P4 / Gate 3 - UNKNOWN-outcome contract, #436 integration plan, DB backstop proposal

Status: **DESIGN + EVIDENCE. Nothing in this document is implemented in production code.** Gate 3 stays YELLOW, production NO-GO.
Evidence vocabulary: ENGINEERING_GOVERNANCE section 11 (HYPOTHESIS / DESIGNED / IMPLEMENTED / SUPPORTED / DEMONSTRATED / VALIDATED). Scope of every DEMONSTRATED claim below is the **MULTISIG rail, REFUND unless stated**; it is not inherited by any other rail or operation (section 10).

## 1. Typed contract for settlement-attempt outcomes (proposal)

A failed external attempt is exactly one of four classes. The class, not the exception text, decides whether the escrow claim may be rolled back.

| Class | Meaning | Rollback of the claim |
|---|---|---|
| `PRE_EFFECT_FAILURE` | failed before the external system could have been reached (validation, signature check, our own read) | allowed |
| `DEFINITIVE_REJECTION` | the external system positively refused AND evidence shows it does not hold the effect | allowed |
| `UNKNOWN` | the request may have reached the external system (timeout, lost answer, HTTP error, unreadable body) | depends on the rail's recovery (below) |
| `CONFIRMED` | external evidence that the effect exists | never; converge to it |

For `UNKNOWN`, rollback is allowed only when the rail is **recoverable by a deterministic identity**: the round is retained and recovery asks external truth for that identity, so a revert can never produce a second distinct effect. Otherwise the claim is preserved and the attempt stays an inspectable manual-review state.

### Per-rail classification (what the code does today, read from the tree)

| Rail | Production-eligible? | PRE_EFFECT | DEFINITIVE_REJECTION | UNKNOWN | CONFIRMED | Rollback today | Verdict |
|---|---|---|---|---|---|---|---|
| MULTISIG (Bitcoin explorer broadcast) | **yes (only one)** | errors before `POST /tx` (round/signature validation, existence and outpoint reads) | **not provable from HTTP status alone** (a gateway 502/503 can follow an accepted tx; `txn-already-in-mempool` means accepted; `bad-txns-inputs-missingorspent` is ambiguous with our own confirmed tx) | any error raised by `broadcast()` (marked `broadcastAttempted` by #520) | `GET /tx/{txid}/status` 200 (`ALREADY_BROADCAST`) | reverted for every class; safe because the txid is deterministic and PASS 0 / PASS 1 decide from chain truth (DEMONSTRATED for REFUND; RELEASE restart DEMONSTRATED by P6-2; SPLIT only via dispute rulings, covered by `aud1xR2DispatchAuthority` AR-01/AR-03) | rollback is justified; a typed `DEFINITIVE_REJECTION` would add availability only |
| LIGHTNING_HODL (Ark submit + finalize) | no (testnet) | none distinguishable: the attempt row is written `SUBMISSION_UNKNOWN` before the call and stays so even for a local parse failure | none | everything | `finalizeTx` returned (`CONFIRMED`) | **reverted by the shared catch in `submitTransactionSignature`**, but the attempt row blocks every retry (`ensureFinalizationAttempt`) and no external query exists | NOT justified: claim should be preserved; a local pre-submit failure should be provably clearable (like WDK `FAILED_BEFORE_SUBMISSION`) |
| SAFE_GUARD_EVM (ERC-4337 bundler) | no (testnet) | same as above | none | everything; `SUBMITTED` = bundler accepted, not final | none implemented | same as above | same as above |
| WDK_USDT_EVM (server-custodial) | no (frozen CTO decision) | `FAILED_BEFORE_SUBMISSION` (nothing signed) | `REVERTED` from an on-chain receipt `0x0` with a block number | `SUBMISSION_UNKNOWN`, `SUBMITTED`; RPC error is UNRESOLVED, never "none" | receipt `0x1` | revert only through `abandonUnsignedWdkOutbound` (no leg signed) | already the target model; keep it |
| MOCK | no | n/a | n/a | n/a | n/a | n/a | n/a |

Findings that follow:
1. **The MULTISIG rollback must not be generalized.** `submitTransactionSignature`'s catch is rail-agnostic, so today it also reverts LIGHTNING_HODL and SAFE_GUARD_EVM after an UNKNOWN. Both rails are production-ineligible (`PRODUCTION_INELIGIBLE_TYPES`), which is the only reason this is latent. Design: the catch asks the provider for the attempt class and reverts only for `PRE_EFFECT_FAILURE`, `DEFINITIVE_REJECTION`, or `UNKNOWN` on a rail declaring `recoverableByIdentity`.
2. WDK already implements the four classes (attempt statuses + `classifyReceipt`); the contract should reuse those names rather than add new ones.
3. For LIGHTNING_HODL / SAFE_GUARD_EVM, a local parse/combine failure before `submitTx` leaves `SUBMISSION_UNKNOWN` forever (`signatureCollectionRestartConvergence` pins this as "harmless"); that is safe but is an availability debt.

Proposed shape (not implemented): `class SettlementAttemptError extends EscrowError { outcome: 'PRE_EFFECT_FAILURE' | 'DEFINITIVE_REJECTION' | 'UNKNOWN'; proof?: RejectionProof }` plus `SettlementProvider.rollbackPolicy: 'RECOVERABLE_BY_IDENTITY' | 'PRESERVE_ON_UNKNOWN'`; `revertEscrowStatus` consults it; unknown/unmarked errors default to UNKNOWN (fail closed). MULTISIG keeps `broadcastAttempted` as its UNKNOWN marker (already in #520).
Expected RED tests before any change: (a) LIGHTNING_HODL / SAFE_GUARD_EVM finalize UNKNOWN through `submitTransactionSignature` leaves the escrow claimed (today it reverts); (b) a provably pre-effect Lightning failure clears the attempt and allows a retry; (c) MULTISIG behavior unchanged (P4-*, P5-*, P6-*, `signatureAuthorityConvergence`, `aud1xR2DispatchAuthority` stay green); (d) mutants: default-to-PRE_EFFECT must turn (a) RED.

## 2. Integration with PR #436 (proposal, no merge executed)

Chain: `#496 (451a44c6) -> #520 (2ffd2847) -> #523`. #436 head `744c87b9`; merge-base with the chain `1ab60a89`; 11 commits only on #436:

| Commits | Content | Status on the chain |
|---|---|---|
| `f156c1a5` | production: refuse a new disputed pending operation while a committed Economic Disposition Authorization exists for the escrow (`escrow-pending-tx.ts`) | **semantically different from the chain** (see STOP below) |
| `381858d4` | production: `withEscrowFundingLock(escrowId, fn, disputeId)` takes D before E (`escrow-lifecycle.ts`) | equivalent mechanism exists on the chain as `opts?: { disputeLockId }` with `economicDispositionLockKey` (same key string `economic-disposition:<id>`); only the API shape differs |
| `b84a6741`, `d5befb4b`, `a3edd775`, `77e91d2c`, `4ec60be4`, `744c87b9`, `9143bbcc` | tests (unit fixtures, `st1TemporalCleanupAuthority`, `paymentAccountBindingAuthority`) | cherry-pick **cleanly** onto the chain + P4 (throwaway local dry run, never pushed) |
| `e9191ab9`, `dfd6190a` | docs | doc conflicts only |

Real conflicts (`git merge-tree`, chain vs #436, with and without P4 - identical): `escrow-lifecycle.ts` (the D-lock signature) and `escrow-pending-tx.ts` (the call site). P4 adds **no** code conflict (its hunks are the finalize catch, `revertEscrowStatus`, `revertStatus`, PASS 1); it conflicts only in this document.

Dry run of the #436 tests on the chain + P4 (local, fresh disposable PostgreSQL): `paymentAccountBindingAuthority` 26/26; unit suites `escrowProviderWiring` + `escrowPendingReleaseDestinationBinding` 130/130; `st1TemporalCleanupAuthority` 61/63. The two failures are **V3-E3b** ("an EDA-committed missing pending cannot be recreated by direct disputed dispatch") and **V3-E3c** ("C4 preflight loses the race to committed EDA and cannot recreate pending"). The same two fail on the #496 head **without** P4 (attribution run): they are not caused by P4.

**STOP (governance section 6, CLAUDE.md rule 5): real architectural inconsistency between the two lines.**
- #436 / ST1-R2 invariant: *a committed EDA means execution authority exists; if its pending operation is lost, a new disputed pending must not be created* (conservative: the lost round may have been executed).
- Chain / AUD1X-R2 invariant: *a committed authorization is reused, never duplicated; replay after a partial failure and a restart yields one authorization and one broadcast* (`aud1xR2DispatchAuthority` AR-01/AR-03, green).
- Neither side is shown wrong; they answer "pending lost after an EDA" differently, and the chain permits re-creation (V3-E3b resolves instead of rejecting). Whether re-creation can ever yield a second **distinct** transaction for the funding outpoint was not established. This is a decision for the CTO; it is **not** resolved here and no code was changed.
Options: (i) adopt #436's guard on the chain and adapt AR-01/AR-03 where they rely on re-creation; (ii) keep the chain and rewrite V3-E3b/E3c to the AUD1X invariant, after proving re-creation cannot produce a second distinct round; (iii) a narrower guard (refuse only when the lost pending's authorization digest cannot be reproduced).

Safe integration order (when authorized): 1. #520 then #523 on the #496 chain (done; draft). 2. Cherry-pick **only** #436's seven test commits; keep the chain's `opts?: { disputeLockId }` API; do not carry `381858d4`/`f156c1a5`. 3. Resolve the STOP above; only then decide on `f156c1a5`. 4. Mandatory after resolution, on one SHA, fresh disposable PostgreSQL: `st1TemporalCleanupAuthority`, `aud1xR2DispatchAuthority`, `aud1xBearerCapability`, `disputedOutcomeBinding`, `signingRoundStateCompatibility` (incl. P4/P5/P6), `signatureAuthorityConvergence`, `pendingRoundSupersession`, `paymentAccountBindingAuthority`, unit lane, `tsc`, CI on the exact SHA, plus removal-mutants for the D -> E ordering.

## 3. DB backstop proposal (NOT created, NOT applied - needs specific CTO approval)

**Exact invariant.** A settlement result may only be recorded on an escrow whose status is `COMPLETED`, `REFUNDED` or `SPLIT`: for an UPDATE with `OLD."txReleaseId" IS NULL AND NEW."txReleaseId" IS NOT NULL`, require `NEW.status IN ('COMPLETED','REFUNDED','SPLIT')`; the same check for an INSERT carrying a `txReleaseId`.
Allowed: result and terminal status in the same statement; result on an already-terminal row. Forbidden: any first write of `txReleaseId` on `CREATED`, `FUNDS_LOCKED`, `PAYMENT_PENDING`, `DISPUTED`, `EXPIRED`.
Today's guarantee is one-directional: the status-frozen trigger refuses a status change **after** a result exists; nothing refuses a result written **onto** a non-terminal row (the P4-A defect). P4 closes the application race; the trigger would make it impossible by construction, for every writer (including raw SQL and the WDK PASS 1 branches, which do not re-read status).

**Placement.** Replace the body of `escrows_enforce_settlement_result_write_once()` (as migration `20260921122000` did), adding one condition - no new trigger, no ordering interaction with `escrows_multisig_state_requires_funding`, `escrows_signature_collection_no_direct_disposition_guard`, `escrows_execution_intent_immutable`, `escrows_trade_economic_binding_guard`.

**Impact on legitimate flows.** Every production writer goes through `persistSettlementResult` after the terminal claim (live finalize, PASS 0, PASS 1, WDK direct, `splitFunds`); a lost race now raises `integrity_constraint_violation` and the reconciler reports `failed` and retries, instead of recording a contradiction. Fixtures to review before applying: `feeCollectionRecognitionIntegration` (sets `txReleaseId` with no status), `escrowExecutionIntent` (`updateSplitResult`), any raw-SQL fixture. Pre-flight data check (read-only, abort-on-hit, no auto-fix): `SELECT id, status FROM escrows WHERE "txReleaseId" IS NOT NULL AND status NOT IN ('COMPLETED','REFUNDED','SPLIT')`.

**Migration and rollback.** Forward: function replacement only (no table rewrite, no data change). Rollback: re-apply the previous function body from `20260921122000` (also data-free). Staging order: run the pre-flight inventory on a copy; apply; run the suites below.

**Tests required.** Mutation: delete the new condition -> a raw `UPDATE ... SET "txReleaseId"` on a `FUNDS_LOCKED` row must go RED. Concurrency (two real backends, no application lock): revert versus result write, exactly one wins and the row is never `non-terminal + result`; re-run the P4-A/P4-B mutants M1 and M2 and expect an exception instead of a contradictory row. Regression: `settlementResultIntegrity`, `signingRoundStateCompatibility`, WDK PASS 1 suites.

## 4. Sacrifice check (governance section 12) for policy A

1. **Gained:** no result beside a non-terminal escrow (lock + re-read); one distinct transaction per round under loss, outage, restart, four workers, live retry; dispute eligibility after a definite refusal.
2. **Possibly sacrificed:** a transient non-terminal state while a public transaction exists (expiry can reach `EXPIRED`, then converges to `REFUNDED`; payment can be marked and is surfaced as manual review until a dispute); a revert on rails whose recovery is not by deterministic identity (latent: production-ineligible).
3. **Complexity added:** a lock in the revert, one re-read in PASS 1, a leaf classification module, log lines.
4. **Earned:** yes for the first three; the classification is observability only until the typed contract exists.
5. **Not demonstrated:** non-MULTISIG rails; SPLIT after a real process restart (covered only at dispatch level); deadlock stress; funding-UNKNOWN recovery outside MULTISIG; the #436 STOP above; production behavior of any explorer.

## 5. Option (iii) for the #436 STOP - narrow guard on re-creating a disputed pending after a committed EDA (DESIGN + RED tests; NOT implemented)

Decision requested by the CTO: refuse re-creation *only when the authorization's digest cannot be reproduced*. This section tests that wording against the code first, then designs what can actually be narrow.

### 5.1 The digest cannot be the discriminator
`economicDispositionOperationDigest()` hashes `pendingOperationId`, `unsignedPsbtBase64`, fees, signers and the ruling generation. A re-created round always has a new `pendingOperationId` and a freshly built PSBT, so its digest can **never** equal the committed one. "Refuse when the digest cannot be reproduced" therefore refuses in 100% of re-creations: it is option (i) (the #436 blanket guard) under another name. Narrowing needs a different discriminator.

### 5.2 What actually bounds the risk (read from the tree; SUPPORTED, not yet DEMONSTRATED)
- A MULTISIG round spends exactly one input, the canonical funding outpoint (`buildUnsignedSpend`: `txLockId:txLockVout`); two rounds for one escrow therefore conflict at consensus - at most one can confirm. There is no double payout; the bound is the chain, not Sails.
- Recipients and amounts of a disputed round are bound to the ruling's durable Outcome (`assertRoundBoundToDisputeAuthority`); two rounds can differ only in miner fee / signers' copies.
- The platform arbiter signature is added in memory at execution only (AUD1X R30), so after the pending row is lost nobody else can complete a disputed round.
- Consequence: the residue of a re-creation is **bookkeeping and operator load**, not funds: a second transmission attempt that the network refuses, or a settlement by the old transaction whose txid Sails no longer knows (reported as `ANOMALY`, manual review). This is an assumption to be pinned by a test, listed below.

### 5.3 Proposed narrow guard (iii-a) - needs a schema addition, hence specific CTO approval
Durable facts added to `EconomicDispositionAuthorization` at commit time (all nullable, additive): `unsignedTxid` (deterministic from the round, `inspectRound`; a segwit txid does not commit to witnesses), `intentDigest` (hash of escrowId, disputeId, appealRound, arbiterId, ruling, authority signature, kind, destinations, buyerBps - **without** `pendingOperationId`/PSBT/fees), `supersededAt`, `supersededByPendingOperationId`; plus a partial unique index: at most one non-superseded row per (`escrowId`, `disputeId`, `appealRound`).
Re-creation of a disputed pending, inside the D -> E transaction, is allowed only if **all** hold; otherwise it is refused with the committed EDA untouched:
1. G1 intent: the new round's `intentDigest` equals the committed EDA's (same generation, same disposition).
2. G2 age: `now - authorizedAt >= settleWindow` (configurable, longer than the broadcast timeout plus an explorer propagation margin; fail closed if unset).
3. G3 identity: the EDA carries `unsignedTxid` (legacy rows with null are refused - cannot be proven).
4. G4 external truth, definitive reads only: `GET /tx/{unsignedTxid}/status` is a 404 **and** the canonical outpoint is reported unspent; any transport error, 5xx or unreadable body refuses (fail closed, retried later).
5. G5 supersession: the old EDA is marked superseded in the same transaction, keeping `unsignedTxid` so that recovery still recognizes the old transaction if it appears later (a superseded txid found on-chain converges the escrow to it instead of raising `ANOMALY`).
If the old txid **is** public (G4 false): never re-create; converge to that txid through the existing PASS 0/PASS 1 identity path (needs the txid from the EDA - the one new recovery path).

| Situation | Decision |
|---|---|
| EDA just committed, pending lost (V3-E3b, V3-E3c) | refuse (G2) |
| window elapsed, txid unknown on chain, outpoint unspent, same intent | allow, supersede old EDA |
| old txid public | refuse; converge to it |
| outpoint spent by another transaction | refuse; manual review |
| explorer unreadable / ambiguous | refuse (fail closed) |
| legacy EDA without `unsignedTxid` | refuse |
| different intent / generation | refuse (already refused by AUD-1 binding) |
| two re-creations race | one wins under D -> E; the second sees the superseding row and the unique index |

Effect on existing contracts: V3-E3b/E3c stay as written (refusal inside the window, so #436's invariant holds for the case it tests); `aud1xR2DispatchAuthority` AR-01/AR-03 (same pending, reuse by `pendingOperationId`) are untouched; liveness returns after the window instead of requiring manual repair.

### 5.4 Smaller variant (iii-b), no migration
Refuse re-creation only when the canonical outpoint is no longer unspent or cannot be read; allow otherwise. It needs no new column but does **not** keep V3-E3b/E3c (funding is unspent there, so re-creation is allowed): it is option (ii) hardened, and #436's two tests would have to be rewritten to the AUD1X invariant. Not recommended if #436's invariant is to be preserved.

### 5.5 RED tests first (expected result today = chain + P4 `9928321b`)
| Id | Setup (real PostgreSQL, real PSBTs) | Assertion | Today |
|---|---|---|---|
| R1 = V3-E3b | EDA committed, pending deleted, direct `initiateRelease` | rejected, EDA/Outcome unchanged | **RED (executed: fails on the chain with and without P4)** |
| R2 = V3-E3c | C4 paused after preflight, competing EDA commit, pending lost | C4 does not resume/recreate | **RED (executed, same)** |
| R3 | EDA committed, the old round's transaction already public, pending lost | no second distinct txid is transmitted; escrow converges to the public txid | RED (spec; needs the disputed-round helpers of `aud1xR2DispatchAuthority`) |
| R4 | `unsignedTxid` recorded; window elapsed; txid 404; outpoint unspent; same intent | exactly one new round; old EDA superseded; one live EDA | RED (needs the new columns/index) |
| R5 | as R4 but explorer read fails (throw / 503 / unreadable) | refused; EDA unchanged; retried later | RED (needs the guard) |
| R6 | as R4 but outpoint spent by another tx | refused; manual review; nothing transmitted | RED |
| R7 | legacy EDA (`unsignedTxid` null), window elapsed | refused | RED |
| R8 | different ruling generation / destination / buyerBps | refused | expected control through the AUD-1 binding (`assertRoundBoundToDisputeAuthority`); not re-run for this design |
| R9 | two concurrent re-creations (two backends) after the window | exactly one pending/EDA; the other refused; no deadlock | RED |
| R10 | assumption pin: two rounds for one disputed escrow both spend only the canonical outpoint and pay the Outcome's destinations | holds | to be written; failing it invalidates 5.2 |
**Executed result (R0, R3a-R10 written as `tests/integration/p4DisputedRecreationGuard.test.ts` on branch `p4/gate3-iii-a-red-spec`, pushed without a PR so CI stays green; fresh disposable PostgreSQL, two identical runs, chain `9928321b` + this document): 8 RED, 2 passing, as predicted.**
- RED: R0 (SCHEMA: all four columns and the index absent), R4 (SCHEMA: `schema: missing`; re-creation itself is allowed and creates one round), R9 (SCHEMA: `schema: missing`; one winner, one pending), R3b (RECOVERY: escrow stays `DISPUTED` with no `txReleaseId` beside a public settlement), R7 (BEHAVIOR: a legacy authorization does not stop the re-creation), and three BEHAVIOR cause-token failures R3a, R5, R6.
- Passing: R8 (control: a REFUND round under a RELEASE ruling is refused) and **R10 (assumption pin: both rounds spend only the canonical outpoint and pay only the Outcome's destination and the fee address - section 5.2 is now DEMONSTRATED for the two-round case)**.
- **Finding that narrows the guard's value:** R3a, R5 and R6 are refused today, with nothing transmitted beyond the first transaction, because the round builder itself reads the explorer and fails when the canonical outpoint is spent or the explorer is down. They are RED only because the refusal carries no `DISPUTED_RECREATION_REFUSED[...]` cause. With a *consistent* explorer, no second distinct transmission occurs today. The unprotected cases are: the window right after an EDA commit (R1/R2, existing), a stale explorer view (the guard reads the same explorer and would not see through it either; the consensus exclusion of section 5.2 is the bound), the missing supersession bookkeeping (R4/R9) and the missing convergence to a public transaction after the pending is lost (R3b - a real gap today).
- Consequence for the decision: the executable value of (iii-a) is mostly R3b (recovery), R4/R9 (supersession and one live authorization) and R7 (legacy refusal); the cause tokens are auditability.

Mutants (each must turn a named test RED): drop G2 (R1/R2), drop G3 (R7), drop G4 outpoint (R6), drop G4 txid (R3/R4), treat a read error as "unknown txid" (R5), drop the unique index (R9), skip supersession (R4).

### 5.6 Risks of (iii-a)
Additive migration on a financial table (rollback: drop the columns and the index; data-free); the `settleWindow` is a policy number, not a proof - an evicted transaction can be re-broadcast by anyone who holds the raw bytes, which is why G5 keeps the old txid for later recognition rather than relying on G4 alone; one more external read on the C4 and direct-dispatch paths; D -> E order must be preserved (the guard runs inside the existing `withEscrowFundingLock(..., { disputeLockId })` transaction, adding no lock).

### 5.7 Decision requested
(i) adopt #436's blanket guard (simplest; no automatic recovery after pending loss), (ii)/(iii-b) keep the chain and rewrite V3-E3b/E3c, or **(iii-a)** as designed above (recommended if both #436's invariant and recovery liveness are wanted). No code, test or migration for (iii-a) exists yet.
## 6. (iii-a) as implemented (branch `p4/gate3-iii-a-guard`, draft PR stacked on #523) - NOT applied to any shared or production database

Where: migration `20261024120000_eda_recreation_guard_evidence` (four nullable columns + `economic_disposition_one_live_per_generation`, with an abort-on-hit pre-flight and a data-free rollback written in the file); `economic-disposition-authority.ts` records `unsignedTxid` (MULTISIG only, via `psbt-identity.ts`) and `intentDigest` at commit; `disputed-recreation-guard.ts` (phase 1 before the build and outside every lock; phase 2 inside the D -> E transaction, then supersession in the same transaction); `MultisigProvider.canonicalOutpointState()`; `config.trade.disputedRecreationSettleWindowMs`; PASS 0b `reconcileLostPendingPublicTransactions()` in the settlement reconciler.

Decisions and deviations from section 5, stated plainly:
- **Unset window = fail closed.** `DISPUTED_RECREATION_SETTLE_WINDOW_MS` has no default. Until it is configured, a disputed round whose pending was lost is NOT re-created automatically (cause `WINDOW`). Before this change such a re-creation was possible; the behavior change is deliberate and must be configured for liveness. Pick a value above the broadcast timeout (`MULTISIG_EXPLORER_TIMEOUT_MS`, default 8 s) plus an explorer propagation margin.
- `intentDigest` covers the signed generation, the kind and `buyerBps` - **not destinations**: destinations and amounts stay judged by the AUD-1 binding at commit and at construction.
- The check order is legacy -> intent -> public txid -> window -> outpoint, so a public transaction is reported as `TXID_PUBLIC` at any age.
- Chain reads are never made inside a locked transaction. Between the read and the write a transaction can still appear; the bound is consensus (one canonical input), and a superseded authorization keeps its `unsignedTxid` for recognition.
- Legacy authorizations (no `unsignedTxid`) are refused forever; they are not back-filled. The `one_live_per_generation` index aborts the migration if a generation already has two rows.
- PASS 0b converges a DISPUTED MULTISIG escrow to the public transaction of its lost round with no fee-output evidence and no raw transaction (recorded as absent); a SPLIT without a recorded `buyerBps` skips its fee obligation and is flagged. Bounded to 20 candidates per run, oldest first.

Evidence (local, fresh disposable PostgreSQL per run, real PSBTs): the specification `tests/integration/p4DisputedRecreationGuard.test.ts` is **12/12** (R0, R3a, R3b, R4-R12; no assert changed after being written RED: 8 RED / 2 passing before the implementation). Mutants, each killed by the named test: M1 no window -> R11; M2 no legacy refusal -> R7; M3 no public-txid refusal -> R3a; M4 no spent-outpoint refusal -> R6; M5 unreadable network treated as unknown -> R5; M6 no supersession -> R4 and R9; the index is pinned by R12. Regression: 30 of 31 PostgreSQL suites green on the first sweep; `disputeAutoResolutionRace` failed once with a 5 s interactive-transaction timeout under load in code this change does not touch and passed 11/11 on two reruns. Unit: the seven suites around the touched modules pass (275); the mock of `escrowPendingReleaseDestinationBinding` gained `economicDispositionAuthorization.findMany`. The #436 tests V3-E3b / V3-E3c are not in this branch; their refusal case is covered here by R11 (inside the window) and the other causes by R3a-R7. Still to be done on the exact head: CI, and the #436 test commits on top.

Not demonstrated / open: a stale explorer view defeats G4 exactly as it defeats the builder; the settle window is a policy number, not a proof; SPLIT through PASS 0b has no test; the guard is MULTISIG-only; no deadlock stress test.