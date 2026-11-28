# WDK Fund-Moving Operations Safety Sweep

**Scope:** `releaseFunds()`, `refundFunds()`, and `splitFunds()` on
`WDK_USDT_EVM` (`wdk-settlement.provider.ts`). Extends the investigation
obligation `docs/TECHNICAL_DEBT_AUDIT.md` #56 / `docs/BACKLOG.md`
registered against `lockFunds()`'s DEMONSTRATED retry-safety gap
(`docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md`) to the three other methods
that self-initiate a real external transfer via
`WalletAccountEvm.transfer()`.

**Type:** Production-safety investigation. **Corrected/Implemented 2026-11-27 (temporal delimitation):** the "not authorized" status below describes the original investigation; a bounded remediation was implemented afterwards (sections 15 and 15.1), and the findings are preserved as the dated record of what was demonstrated before it. **Implementation: NOT
AUTHORIZED** (original status). This document does not claim any of these three methods has
been proven to have a demonstrated defect merely because #56 found one for
`lockFunds()` — each is investigated independently, and verdicts differ by
method where the evidence differs.

**Evidence-status legend (identical to `docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md`,
carried forward for consistency):** DEMONSTRATED (proven by reading the
real, unmodified source and/or by a test exercising the real, unmocked
Sails orchestration) / SIMULATED (a test double stands in for the
external side effect itself — never a real network call) / REPOSITORY
OBSERVED (confirmed directly in this repository's own source) / UPSTREAM
SOURCE OBSERVED (confirmed directly in the installed
`@tetherto/wdk-wallet-evm` package source) / INFERRED (a reasoned
conclusion, not itself directly observed) / NOT LIVE TESTED (no real
network call was made for this claim) / UNKNOWN (not determinable from
available evidence).

**Prohibited claims, never made in this document:** "funds definitely
duplicate," "real double payment," "real partial loss" — none of these
were live-tested. **Permitted claims, made only where directly
demonstrated:** *"Sails orchestration permits a repeated provider
invocation after a simulated post-submission unknown outcome"* and, for
`splitFunds()` specifically, *"Sails orchestration permits partial
simulated multi-leg execution without durable knowledge sufficient to
safely resume."*

---

## 1. Properties Under Investigation

- **Property A — Unknown Outcome / Retry Safety.** A side-effecting
  economic action must not be repeated merely because the previous
  attempt's outcome is unknown. (The same property `#56` investigated for
  `lockFunds()`.)
- **Property B — Multi-Leg Partial Execution** (`splitFunds()`
  specifically). A multi-leg economic action must not become partially
  executed without durable, reconcilable knowledge of which legs
  succeeded, failed, or remain unknown. Absolute atomicity is not assumed
  as the only way to satisfy this — durable per-leg identity plus
  reconciliation plus safe continuation would also satisfy it. Neither
  exists today (§7, §9).
- **Property C — Submission vs. Execution.** Transaction submission
  acknowledgement is not equivalent to confirmed successful economic
  execution. A returned tx hash means RPC-mempool-acceptance
  (`SUBMITTED`/`RPC_ACCEPTED`), not `CONFIRMED`, and never rules out
  `REVERTED`.

---

## 2. Real Call Paths (traced from source)

All three methods share `lockFunds()`'s exact orchestration shape
(`escrow.service.ts`) — DEMONSTRATED by direct reading, `escrow.service.ts`
lines 534-640 (`releaseFunds`), 680-716 (`refundFunds`), 729-777
(`splitFunds`):

```
HTTP route (release/refund only — see §6) / dispute.service.ts's
applyRuling() / settlement-orchestrator.ts's executeSettlement() (release only)
  -> escrowService.{releaseFunds|refundFunds|splitFunds}()
       -> loadEscrowWithAuthorization()        [read: escrow + trade, seller-or-arbiter check]
       -> assertEscrowTransition(status, TARGET)
       -> resolvePayoutAddress() (release/split — explicit address or registered PayoutAddress)
       -> checkFundMovementCapability()         [off by default]
       -> claimEscrowTransition(status, TARGET) -- ATOMIC prisma.escrow.updateMany, BEFORE the provider call
       -- try {
       ->   provider.{releaseFunds|refundFunds|splitFunds}(...)   *** THE EXTERNAL SIDE EFFECT(S) ***
       ->   repo.update{Release|Refund|Split}Result(...)          -- persists txReleaseId ONLY on full success
       ->   feeObligationService.recordObligationForEscrowSettlement()  -- no-op today (no feePolicyVersionId set on any real escrow)
       ->   emitEscrowTransition(...)                              -- settlement.escrow.{released|refunded|split}
       ->   return updated
       -- } catch (err) {
       ->   revertEscrowStatus(escrowId, escrow.status)  -- UNCONDITIONAL, identical to lockFunds()'s catch
       ->   throw err
       -- }
```

**`WdkSettlementProvider`'s own methods** (`wdk-settlement.provider.ts`):

- `releaseFunds()` (lines 154-165): one `escrowAcct.transfer()` call, hash
  returned directly. Identical shape to `lockFunds()`'s single-call
  pattern.
- `refundFunds()` (lines 167-180): one `escrowAcct.transfer()` call to the
  treasury address. Identical shape.
- `splitFunds()` (lines 189-199): **TWO SEQUENTIAL, independent**
  `escrowAcct.transfer()` calls — `buyerResult` then `sellerResult` — no
  shared-recipient/multicall primitive on this provider's `transfer()`
  API (the file's own comment already discloses this, RFC-021 D9). If the
  second call throws, the function itself throws — `buyerResult` (a
  genuine, already-attempted transfer if this ran for real) is **never
  returned to the caller in any form.**

---

## 3. External Side-Effect Boundaries

Identical to `lockFunds()`'s (`docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md`
§3) for each individual `transfer()` call: `provider.send('eth_sendRawTransaction',
[signed])` inside `WalletAccountEvm.sendTransaction()`. For `splitFunds()`,
there are **two independent boundaries**, one per leg — leg 1's boundary
crossing and leg 2's boundary crossing are two separate, non-atomic
events, confirmed REPOSITORY OBSERVED (no wrapping transaction, no shared
nonce reservation, no multicall).

---

## 4. Per-Method State Behavior

DEMONSTRATED by direct reading of `escrow.service.ts` and
`escrow-repository.ts`:

| Method | DB write on full success | DB write on any failure | Persists partial leg identity? |
|---|---|---|---|
| `releaseFunds()` | `txReleaseId`, `releasedAt`, `feeCharged: null` | Unconditional revert to pre-claim status; `txReleaseId` never written | N/A — single leg |
| `refundFunds()` | `txReleaseId` only (`updateRefundResult`) | Same unconditional revert | N/A — single leg |
| `splitFunds()` | `txReleaseId` = **joined** `"hash1,hash2"` string (`updateSplitResult`), `releasedAt` | Same unconditional revert | **No — not even on success.** `Escrow.txReleaseId` is a single, plain, non-unique `String?` column (`prisma/schema.prisma`, REPOSITORY OBSERVED) — there is no per-leg row, table, or field anywhere. `updateSplitResult()` is called exactly once, only after `provider.splitFunds()`'s promise fully resolves with both hashes; a partial failure never reaches it at all |

**Crash windows** (mirroring `#56`'s §4/§7 Windows I/E, REPOSITORY
OBSERVED, not reproduced via an actual process kill):
- A crash between `claimEscrowTransition` committing and the provider call
  beginning leaves the escrow durably at the target status
  (`COMPLETED`/`REFUNDED`/`SPLIT`) with **no** `txReleaseId` — identical
  mechanism to `#56`'s Window I, and (like that window) this state is
  **not retryable via the normal route** (`assertEscrowTransition` blocks
  a repeat call once status has already advanced — DEMONSTRATED, §8
  Tests).
- For `splitFunds()` specifically: a crash **between leg 1 and leg 2**
  (inside `WdkSettlementProvider.splitFunds()`'s own function body, between
  its two sequential `await`s) leaves the exact same stuck,
  non-retryable-via-normal-route state — with the added fact that leg 1's
  side effect, if this ran for real, would have already occurred with
  zero record of it anywhere in Sails.

---

## 5. Split Multi-Leg Analysis (Property B)

Answering the mission's explicit questions:

1. **Can Sails know which leg occurred?** No — DEMONSTRATED (§8 adversarial
   tests). `WdkSettlementProvider.splitFunds()` returns a single
   `{ txIds: string[] }` only on full success; there is no partial-result
   channel, no callback, no intermediate persistence between leg 1 and
   leg 2.
2. **Are the legs' txIds persisted individually?** No — REPOSITORY
   OBSERVED (§4). Only the joined final string, and only after both legs
   succeed.
3. **Can a leg be repeated?** Yes — DEMONSTRATED (§8, both split tests): a
   retry of the whole `splitFunds()` call re-executes leg 1 (and,
   depending on where the prior attempt failed, potentially leg 2 as
   well) with no awareness that leg 1 may have already happened.
4. **Does retry repeat the whole operation or just the missing leg?**
   **The whole operation, always** — DEMONSTRATED. There is no
   "resume from leg 2" code path anywhere in this orchestration; the only
   operation Sails can request is the full `splitFunds()` call again.
5. **Is there a durable intermediate state?** No — REPOSITORY OBSERVED.
   Between leg 1 and leg 2, and between the provider call returning and
   `updateSplitResult()` running, there is no persisted marker of any
   kind.
6. **Is there a recovery path?** No dedicated one — same correlation-hint-only
   reconciliation `#56` already established (§7 below): the escrow's
   deterministic address is re-derivable, but nothing narrows which of
   two possible transfers (buyer-leg, seller-leg) a given on-chain
   transaction corresponds to without external correlation by amount and
   recipient.
7. **Is there real atomicity?** **No — not claimed as atomic anywhere in
   this document.** The two legs are two independent, non-atomic
   transactions. This document does not propose absolute atomicity as the
   only fix — durable per-leg identity plus reconciliation plus safe
   continuation would also satisfy Property B, and no mechanism of any
   kind is chosen or authorized here (§13).

**Dispositive adversarial evidence** (§8): a test modeling "leg 1 succeeds,
leg 2 throws before its own side effect" and a second test modeling "leg 1
succeeds, leg 2 ALSO has its own (simulated) side effect before throwing"
produce **the identical observable outcome** from `escrow.service.ts`'s
point of view — one rejected promise, one revert, zero persistence. This
is itself part of the finding: **Sails cannot distinguish "leg 2 never
attempted" from "leg 2 attempted and its result was lost"** — both look
exactly the same to the orchestration layer.

---

## 6. Retry Surfaces

REPOSITORY OBSERVED, repository-wide search plus direct reading:

| Surface | Applies to |
|---|---|
| `POST /v1/settlement/escrow/:id/release` (HTTP, no idempotency-key mechanism — identical gap to `#56`'s `/lock` route) | `releaseFunds()` |
| `POST /v1/settlement/escrow/:id/refund` (HTTP, same) | `refundFunds()` |
| No direct HTTP route exists for `splitFunds()` | `splitFunds()` reachable only via dispute resolution (below) |
| `dispute.service.ts`'s `applyRuling()` — **an explicit, documented retry surface**: on ANY failure of the underlying `releaseFunds()`/`refundFunds()`/`splitFunds()` call, the dispute's own `ruling`/`resolvedAt` are reset to `null` and the code's own comment states *"the arbiter must re-submit"* (`dispute.service.ts:364-373`) | All three — this is "dispute resolution replay," named explicitly in the mission brief, and it is REPOSITORY OBSERVED as a real, intended, documented code path, not a hypothetical |
| `settlement-orchestrator.ts`'s `executeSettlement()` auto-settle path | `releaseFunds()` only |
| Operator/API replay (a human resubmitting after an observed failure) | All three, via their respective entrypoints above |

**No automatic retry library, queue, or job-redelivery mechanism is wired
to any of the three methods.** Event-delivery semantics for
`settlement.escrow.{released,refunded,split}` are identical to `#56`'s own
finding for `settlement.escrow.locked` (`docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md`
§9): AT-MOST-ONCE/BEST-EFFORT under the confirmed active store
(`PostgresEventStore`), not re-derived here since the mechanism is
identical and provider-agnostic.

---

## 7. Operation Identity (per method/leg)

Answered separately, as required:

| | Durable operation identity before the side effect? |
|---|---|
| `release` | **ABSENT / NOT DEMONSTRATED** — identical to `#56`'s finding for `lockFunds()`. Correlation material only: re-derivable escrow address, chain id, sender, amount, time window — a search aid, not a deterministic identity. |
| `refund` | **ABSENT / NOT DEMONSTRATED** — same as above, recipient is the treasury address instead. |
| `split leg 1` (buyer) | **ABSENT / NOT DEMONSTRATED** — same correlation material, plus the buyer's resolved payout address. |
| `split leg 2` (seller) | **ABSENT / NOT DEMONSTRATED** — same, plus the seller's resolved payout address. Additionally, leg 1 and leg 2 share the SAME sender (`escrowAcct`) and the same escrow — external correlation between the two legs (which hash is which leg) depends entirely on matching amount/recipient after the fact, since Sails records neither leg's identity independently. |

No candidate mechanism is chosen here — see §13.

---

## 8. Adversarial Evidence (Real Orchestration, Simulated Side Effects)

New file: `tests/wdkFundMovingOperationsSafety.test.ts` — 7 tests, same
"mock the boundary, test what's actually new" convention as
`tests/wdkLockFundsRetrySafety.test.ts`. `escrow.service.ts`/
`escrow-lifecycle.ts` run for real, unmocked; only `wdkSettlementProvider`
and the database are mocked.

**`releaseFunds()`** (2 tests): the true submit-then-throw scenario
(provider records a simulated side effect, then throws, never returning a
txId) — DEMONSTRATED: the provider is invoked a second time on retry, with
zero persisted record of the first attempt. Contrast: once `COMPLETED` is
durably persisted, a further call is correctly rejected (already-protected
boundary, DEMONSTRATED).

**`refundFunds()`** (2 tests): identical property, identical mechanism,
identical result — DEMONSTRATED.

**`splitFunds()`** (3 tests):
1. Leg 1 succeeds (simulated), leg 2 throws before its own side effect —
   DEMONSTRATED: zero persistence, and a retry re-triggers leg 1's side
   effect a second time (`legEffects` array shows `leg1` recorded twice).
2. Leg 1 succeeds, leg 2 ALSO has its own simulated side effect before
   throwing — DEMONSTRATED: byte-for-byte identical observable outcome to
   scenario 1 from `escrow.service.ts`'s perspective (one rejected
   promise, one revert) — proving Sails cannot distinguish the two cases.
3. Contrast: once `SPLIT` is durably persisted, a further call is
   correctly rejected (already-protected boundary, DEMONSTRATED).

All 7 tests pass against the real, unmodified orchestration code on this
branch (see §14 for the exact validation run). **Simulated vs. live,
stated plainly:** every external side effect in every test above is an
in-memory array push inside a mocked function — no network call, no
testnet transaction, was made anywhere in this file.

---

## 9. Receipt / Confirmation Semantics (Property C)

Identical finding to `#56`'s for `lockFunds()`
(`docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` §7 window G), confirmed
DEMONSTRATED by source reading for all three methods:

| | Waits for receipt? | Checks receipt status? | Waits for confirmations? | Persists only hash? | Can record economic success before knowing the on-chain outcome? |
|---|---|---|---|---|---|
| `releaseFunds()` | No | No | No | Yes (`txReleaseId`) | **Yes** |
| `refundFunds()` | No | No | No | Yes (`txReleaseId`) | **Yes** |
| `splitFunds()` (each leg) | No | No | No | Yes (joined `txReleaseId`) | **Yes** — and additionally, `Escrow.status` is set to the terminal `SPLIT` state (`VALID_TRANSITIONS`'s own terminal set — `SPLIT: []`, no further transition possible) the instant BOTH legs return a hash, with no confirmation wait for either |

None of these methods calls `provider.waitForTransaction()` or queries a
receipt anywhere in the call chain — REPOSITORY+UPSTREAM SOURCE OBSERVED,
same evidence basis as `#56`'s own finding.

**A status marked `SPLIT`/`COMPLETED`/`REFUNDED` is not proof that the
underlying transfer(s) actually succeeded on-chain** — it is proof only
that the RPC node accepted the broadcast. This document does not
interpret a terminal Sails status as "economic operation fully
confirmed," and does not interpret two returned tx hashes as "two
successful token transfers" (Cobra Check).

---

## 10. Comparison to Other Providers (scoped narrowly, per mission instruction)

Cited only to establish architectural contrast, not as a cross-rail audit:
`MULTISIG`/`LIGHTNING_HODL`/`SAFE_GUARD_EVM`'s `releaseFunds()`/
`refundFunds()`/`splitFunds()` equivalents go through the client-signature-collection
flow (`initiateRelease`/`initiateRefund`/`initiateSplit` +
`submitTransactionSignature`, `escrow-pending-tx.ts`) for real fund
movement, or (for `SAFE_GUARD_EVM`) have their own provider-specific
constraints disclosed in that provider's own `buildUnsignedSplit()`
override. None of these three real alternative providers self-initiates a
custodial multi-call transfer sequence the way `WDK_USDT_EVM`'s
`splitFunds()` does — this is not re-investigated here, only noted as the
reason this sweep is scoped to `WDK_USDT_EVM` alone.

---

## 11. Production Implications

`WDK_USDT_EVM` remains `PRODUCTION-INELIGIBLE`, unchanged by this
document — the same fail-closed boot guard `#56` already established
(`src/config/index.ts:777-784`) covers all four fund-moving methods
equally, since it gates the entire provider, not `lockFunds()` alone.
Containment is **operationally real** (cannot run in production today)
but **not architectural** (the property gaps remain unresolved for any
future eligibility decision) — identical framing to `#56`.

---

## 12. Findings and Per-Method Verdicts

Not forced to a uniform result — each method's verdict reflects its own
evidence:

| Method | Verdict | Reasoning |
|---|---|---|
| `releaseFunds()` | **C — Structural gap demonstrated** | Identical mechanism to `lockFunds()`'s own demonstrated gap (§8) — the design persists nothing about the external call until full success and reverts unconditionally on any failure in between. |
| `refundFunds()` | **C — Structural gap demonstrated** | Same mechanism, same reasoning, same evidence class. |
| `splitFunds()` | **C — Structural gap demonstrated** | Shares `releaseFunds()`/`refundFunds()`'s Property A gap AND carries an additional, independent Property B gap (multi-leg partial execution with zero per-leg persistence, even on full success) — a strictly larger exposure than the single-leg methods. |
| Receipt/confirmation (Property C, cross-cutting) | **C — Structural gap demonstrated** | All four fund-moving methods (including `lockFunds()`, already registered by `#56`) share the identical absence of any receipt/confirmation check. |

None of these verdicts claims a proven live exploit, a confirmed duplicate
transfer, or a confirmed fund loss — each is bounded to what §8's real
tests against the real orchestration code, plus direct source reading,
actually demonstrate.

---

## 13. Recommendation — No Mechanism Chosen or Authorized

**Claude recommendation: C — STRUCTURAL GAP across all three methods**,
with `splitFunds()` carrying the additional Property B exposure. **CTO
decides final disposition.**

No implementation is authorized by this document. The following are
explicitly **not** created, chosen, or implied as a preferred solution:
an `UNKNOWN` status, an operation journal, an idempotency key, nonce
reservation, receipt polling, a confirmation worker, a reconciliation
engine, a per-leg state machine, a compensation transaction, a transaction
bundler, a multicall, a smart-contract atomic split, retry middleware, a
generic `EconomicOperation` interface, or a cross-rail framework. Property
first, mechanism later — exactly as `#56` was itself resolved: evidence
now, a separately authorized mission if and when the CTO decides to close
any of these gaps.

## 14. Validation

- `git diff --check`: clean.
- No production source file changed. Only additions: this document, one
  new test file (`tests/wdkFundMovingOperationsSafety.test.ts`), and the
  `docs/BACKLOG.md`/`docs/TECHNICAL_DEBT_AUDIT.md` sync this mission's own
  return describes.
- Isolated run (`--runInBand`) of the new test file alone: **7/7 passed.**
- Targeted run (`--runInBand`, 8 suites): `tests/wdkFundMovingOperationsSafety.test.ts`,
  `tests/wdkLockFundsRetrySafety.test.ts`, `tests/wdkSettlementProvider.test.ts`,
  `tests/escrowProviderWiring.test.ts`, `tests/escrowReleaseControls.test.ts`,
  `tests/escrowCircuitBreaker.test.ts`, `tests/escrowEventHashChain.test.ts`,
  `tests/disputeFlow.test.ts` — **186 tests, 0 failures.**
- `npx tsc --noEmit` (root): clean.
- `npm test` (plain, no workaround) run once per the mission's own
  instruction: ran to completion, `442 failed, 299 passed, 741 total`
  suites — every failure carrying the identical, already-disclosed
  `.claude/worktrees/` Haste module-map collision from unrelated parallel
  sessions on this machine (one more failing suite than `#56`'s own
  full-suite run, exactly accounting for this pass's one new test file
  hitting the same collision). Registered exactly as observed — `jest.config.js`
  not modified, no timeout raised, no worker count reduced.

---

## 15. Remediation (Bounded Remediation, WDK Fund-Moving Safety, 2026-09-08)

**Finding demonstrated → remediation implemented → evidence → residual.**
Every finding above (§12's per-method verdicts, all `C — structural gap
demonstrated`) is preserved verbatim, unmodified — this section records
what was subsequently built against them, not a rewrite of the findings.

**Remediation implemented:** the same provider-local execution-truth
layer described in `docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` §22
(`wdk-execution-truth.ts` + `wdk-transfer-attempt-repository.ts` + the
new `WdkTransferAttempt` Prisma model) now wraps `releaseFunds()` and
`refundFunds()` identically to `lockFunds()`, and `splitFunds()`
specifically was redesigned around it for Property B (Multi-Leg Partial
Execution): the buyer and seller legs are now tracked as two entirely
independent logical operations (`SPLIT_BUYER`/`SPLIT_SELLER`, separate
`WdkTransferAttempt` rows), each going through the identical
attempt-then-transfer-then-confirm sequence. The seller leg is never
attempted until the buyer leg has a real, receipt-confirmed `txHash` —
resuming (skipping the `transfer()` call entirely) whenever a prior
attempt already reached `CONFIRMED`.

**§5's four named scenarios, now resolved by design (not merely
documented):**
1. Buyer `CONFIRMED` + seller not started → resumes at seller only
   (buyer leg's `ensureAttempt()` call returns `RESUME_CONFIRMED`
   without ever calling `transfer()` again).
2. Buyer `CONFIRMED` + seller `SUBMISSION_UNKNOWN` → the seller leg's own
   `ensureAttempt()` call blocks until reconciled; the buyer leg is
   untouched.
3. Buyer `SUBMISSION_UNKNOWN` → blocked before the seller leg is ever
   reached at all (the buyer leg's own `ensureAttempt()` call throws
   first).
4. Buyer `CONFIRMED` + a prior seller leg `REVERTED` → the seller leg's
   `ensureAttempt()` call safely starts a fresh seller attempt (a
   definitively reverted transfer proves no funds moved); the buyer leg
   is never touched again.

**Evidence:** `tests/wdkExecutionTruth.test.ts` (new, 11 tests, shared
with the `#56` remediation) includes three `splitFunds()`-specific
adversarial tests demonstrating scenarios 1-2 combined (leg 1 confirmed +
leg 2 failure → leg 1 never replayed on retry, and a further retry
replays neither leg) and scenario 4 (buyer confirmed + prior seller
`REVERTED` → seller retries safely, buyer untouched) directly against the
real, unmocked `WdkSettlementProvider.splitFunds()` — no live network
call anywhere. Full regression: `#58`'s own pre-existing test file
(`tests/wdkFundMovingOperationsSafety.test.ts`, which mocks
`wdkSettlementProvider` entirely to test `escrow.service.ts`'s
orchestration layer) still passes unchanged — see
`docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` §22 for why that remains true
and correct.

**Residuals:** identical to `docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md`
§22's own residuals list — not repeated verbatim here to avoid drift
between two copies; that section (and its own §22.1 correction, below)
is the canonical statement of every residual, since the mechanism is
identical code shared by all four methods.

**Production eligibility: unchanged.** `WDK_USDT_EVM` remains
`PRODUCTION-INELIGIBLE` (RFC-019) — this remediation closes the
retry-safety, receipt-verification, and multi-leg partial-execution
blockers this document demonstrated; it does not by itself constitute a
production-eligibility review, and no such review is claimed or
authorized by this section.

### 15.1 CTO Gate Correction (2026-09-08)

A real gap in §15's remediation — the `PREPARED → transfer() →
SUBMITTED` crash window — was found and closed. Full account:
`docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` §22.1 (canonical; the fix is
one shared mechanism, `executeTransfer()`, used identically by
`lockFunds()` and all three fund-moving methods this document covers).
Summary: a durable pre-submission commit (`markSubmissionAttempted()`,
reusing the existing `SUBMISSION_UNKNOWN` status — no new status value)
is now written immediately before every `transfer()` call, closing the
window down to the single synchronous write between `ensureAttempt()`
returning and that commit. `splitFunds()`'s per-leg protection inherits
this automatically via the shared helper. The floating-point amount
comparison (`Number(a) !== Number(b)`) in the reused-attempt integrity
guard was also replaced with an exact decimal-string comparison. Two new
adversarial tests plus an extension to the existing `REVERTED` test in
`tests/wdkExecutionTruth.test.ts` (13 tests total). No new `BACKLOG
DELTA` — a correction to an already-registered remediation, not a new
finding.
