# P4 funding-evidence partial persistence — reconciliation design (draft)

**Status:** Investigation / proposed guard; NOT ACCEPTED or deployed.
**Base:** `cto/p4-funding-revert-guard-20261023` (PR #524).
**Date:** 2026-10-24.

## Verified failure window

`escrow.service.ts::lockFunds()` persists `Escrow.txLockId` through `repo.updateLockResult()`, then independently appends `OBSERVED_CONFIRMED` via `escrowFundingEvidenceRepository.record()` when `result.vout !== undefined`, then emits `settlement.escrow.locked`. The operations do not share a transaction/outbox. If the evidence append fails, the escrow can retain `status=FUNDS_LOCKED` and `txLockId` with no evidence row and no transition event.

PR #524 correctly refuses to roll `FUNDS_LOCKED` back to `CREATED` once `txLockId` is durable. That guard prevents erasing externally relevant state, but does not repair evidence or event emission.

`escrow-funding-evidence.service.ts::isFundingUncertain()` currently returns `false` when the evidence log is empty, intentionally preserving historical/legacy behavior. Treating all empty logs as safe for *new* funding would silently bypass this partial-write failure.

## Required safety invariants

1. Never retry provider `lockFunds()` or re-broadcast to repair missing evidence.
2. Never synthesize `OBSERVED_CONFIRMED` from a database `txLockId` alone; verify chain/outpoint/amount/confirmation policy with the authoritative provider or independent chain source.
3. Preserve append-only funding history and any reorg observations. Do not append stale `OBSERVED_CONFIRMED` over a newer `REORGED_INVALIDATED`, `AMBIGUOUS` or `REPLACEMENT_OBSERVED`.
4. Distinguish legacy rows lacking evidence by design from modern partial writes using an explicit, versioned marker or provably equivalent persisted provenance. Do not retroactively classify all legacy escrows as uncertain.
5. Lock per escrow and re-check persisted status, outpoint, evidence tail, and funding provenance in the same transaction before append; serialize against reorg sweep and lifecycle transitions.
6. If verification cannot prove the outpoint, fail closed for release/payment-sensitive transitions, while keeping dispute/refund/recovery pathways available.
7. Event delivery must be idempotent and durable, preferably transactional outbox with stable event key; event failure must not re-execute provider side effects.
8. Do not make Paykit/Pubky or external identity discovery part of this recovery path.

## Proposed implementation sequence (not yet executed)

- **Phase A: characterization tests.** PostgreSQL integration test injects failure immediately after `updateLockResult`, checks durable lock data, absent evidence, absent event, and existing #524 guard. Separate test for legitimate legacy no-evidence row.
- **Phase B: provenance.** Decide a minimal additive, versioned marker that is committed at the correct stage and can discriminate incomplete new funding from old escrows. Backward compatibility and migration behavior require independent review.
- **Phase C: safe repair.** Read-only external verification outside lock, then per-escrow transactional recheck; idempotent append only if evidence remains missing and proof still valid. Concurrent reorg invalidation must win over stale repair.
- **Phase D: event outbox.** Transactional, idempotent transition delivery, with restart and duplicate-worker tests.
- **Phase E: independent gate.** Real isolated PostgreSQL, injected failures, restart, races, and no duplicate provider effects; CI on exact SHA.

## Explicit blockers / non-goals

- No accepted provenance schema or confirmed external verification interface has been selected yet.
- The existing empty-evidence compatibility rule is a known security boundary, not a fix.
- No automatic backfill, production DB migration, deployment, merge or provider invocation is authorized.
- Do not change the concurrently active PR #525 branch.

## Decision

**YELLOW** for a safe design and test plan; **RED** for automatic repair or production until the above invariants are proved. PR #524 CI green covers rollback guard only, not full reconciliation.

## Schema and write-order decision record — 2026-10-24

**Observed in source:** `Escrow.txLockId` and `txLockVout` already exist; `EscrowFundingEvidence` has a separate append-only table and `recordedAt`. `lockFunds()` first calls `updateLockResult()`, then `record()`, then `emitEscrowTransition()`. No transaction joins these three writes. `isFundingUncertain()` returns false on an empty evidence log for compatibility.

**Candidate A — versioned obligation marker:** an additive nullable marker (for example `fundingEvidenceRequiredVersion`) on Escrow, written *before* invoking the provider for MULTISIG only. NULL means legacy/unclassified, not proof of safety; version 1 means this escrow must have durable funding evidence before sensitive transitions. Marker must be immutable once set, protected by DB constraints or trigger. This is a proposal, not a migration approval.

**Critical sequencing:** If the marker is written after `updateLockResult()`, a crash between the writes reproduces the undetectable hole. The marker must therefore be durable before provider side effects. A marker alone is insufficient for `FUNDS_LOCKED` claims that never reached external confirmation: verification must distinguish `PENDING_EXTERNAL`, `CONFIRMED`, and `UNKNOWN` using independently observed chain truth.

**Candidate B — atomic evidence/result commit:** where the provider already returned independently verifiable funding proof, move the Escrow result update and append-only evidence insert into one per-escrow database transaction. This eliminates the current gap between these two writes for new calls, but does not repair previously interrupted escrows, prevent a crash after the provider side effect but before either write, or guarantee event delivery. It therefore complements, rather than replaces, durable provenance and a recovery worker.

**Event delivery:** record a stable event key in a transactional outbox in the same transaction as the accepted state; consumers must deduplicate. Publishing directly after commit without a durable outbox leaves a second crash window. Do not re-emit legacy events speculatively.

**Rollout gates:** first prove baseline failure in isolated PG; then approve additive schema + migration and rollback compatibility; next add negative tests for unknown outpoint, stale chain observation, concurrent reorg, duplicate recovery worker, process restart, and event replay. No release gate until those tests pass on an exact SHA.

**Known nuance:** A pre-provider marker with `status=FUNDS_LOCKED` but no `txLockId` can be a claimed in-flight operation, not confirmed funding. Never infer a settled lock from status or marker alone.

## Additional code-audit finding — sweep cannot self-heal missing baseline

`multisig-funding-reorg-sweep.ts` already uses `withEscrowFundingLock()` to serialize its evidence read/write against lifecycle transitions. **However, when `listForEscrow()` returns no rows, the sweep explicitly pushes the escrow into `skippedNoBaseline` and returns without appending anything.** This behavior correctly avoids fabricating history for legacy escrows, but also means a modern partial-write escrow with `txLockId` and no evidence cannot be recovered by simply waiting for the existing sweep.

**Implementation implication:** introduce an explicit modern funding-obligation/provenance discriminator before changing the sweep; the new repair path must not reinterpret `skippedNoBaseline` globally. Preserve the current legacy skip and add an independently verified, lock-serialized recovery for positively marked modern escrows only.

**New negative acceptance case:** inject evidence append failure after durable `txLockId`; run existing sweep and assert it reports `skippedNoBaseline` (baseline behavior); run proposed recovery without valid chain proof and assert no synthetic `OBSERVED_CONFIRMED`; only after independently valid confirmation and locked tail recheck may the new recovery append a row. A concurrent reorg invalidation must not be superseded by stale recovery proof.

## Rollout gates and recovery decision matrix (CTO review)

This section is a proposed contract, not shipped functionality.

| Persisted provenance | Escrow state | Evidence tail | Chain scan | Allowed outcome |
| --- | --- | --- | --- | --- |
| NULL (legacy) | FUNDS_LOCKED | Empty | Any | Keep legacy compatibility; report `skippedNoBaseline`; **never backfill** |
| Modern marker present | FUNDS_LOCKED with txLockId/vout | Empty | Unknown / unreachable | **UNCERTAIN**; block payment/release/split, retain refund/dispute/recovery |
| Modern marker present | FUNDS_LOCKED with txLockId/vout | Empty | Outpoint missing or wrong script/value | **UNCERTAIN**; no fabricated confirmation or provider retry |
| Modern marker present | FUNDS_LOCKED with txLockId/vout | Empty | Independently matched and sufficiently confirmed | Append one baseline only after locked tail re-read and exact outpoint revalidation |
| Modern marker present | FUNDS_LOCKED | REORGED_INVALIDATED or AMBIGUOUS | Old/stale confirmation | Keep **UNCERTAIN**; never overwrite a later invalidation with stale scan |
| Modern marker present | FUNDS_LOCKED | OBSERVED_CONFIRMED | Same independently confirmed outpoint | Idempotent no-op; no duplicate baseline |
| Modern marker present | CREATED, txLockId NULL | Empty | Unknown external provider result | **UNCERTAIN** pending explicit reconciliation; never blindly re-invoke provider |
| Any | Any | Any | Provider/chain timeout | Fail closed for economic progression, preserve evidence history and recovery paths |

**Concurrency linearization point:** a per-escrow PostgreSQL advisory-locked transaction must re-read the escrow marker, persisted outpoint and latest evidence *after* the external chain scan, compare the scan to the current authoritative outpoint and chain tip/depth, then append at most one observation. If the scan can become stale before the transaction commits, conservatively record AMBIGUOUS or defer; never promote an invalidated escrow based on a pre-lock snapshot. The existing sweep's `withEscrowFundingLock()` is reusable but its unlocked `peek.length === 0` shortcut cannot be used to authorize modern repair.

**Event boundary:** evidence reconciliation and the durable event-outbox write must commit together, or event delivery must remain explicitly pending and retryable with an idempotency key. Never emit a success event merely because a previous `FUNDS_LOCKED` status exists.

**Required test gates before code is enabled:** (1) real PG post-`updateLockResult` append failure; (2) process death before/after marker and provider invocation; (3) provider outcome unknown; (4) chain offline; (5) outpoint mismatch; (6) shallow confirmations; (7) reorg during recovery; (8) concurrent sweeps/recovery; (9) legacy empty log untouched; (10) no duplicate provider call, baseline row or event. Each gate must run against the exact commit SHA and a database with the migration actually applied. No CI skip counts as proof.

**Release order:** isolated schema migration review → pre-provider marker write → conservative uncertain classifier → manual/read-only reconciliation visibility → independently verified repair behind disabled-by-default feature gate → real PG race tests → explicit authorization for any production enablement. A schema migration is **not** authorized by this design document.

## Schema inspection: nullable marker and legacy compatibility

Inspection of `prisma/schema.prisma` confirms that `Escrow.txLockId` and `Escrow.txLockVout` are nullable, and that `EscrowFundingEvidence` currently has no provenance discriminator. A missing evidence row is therefore **not** enough to distinguish a historical pre-evidence escrow from a modern interrupted append. Neither the existing composite outpoint uniqueness nor `recordedAt` solves this classification problem.

Proposed minimal additive column (name illustrative, subject to migration review): `Escrow.fundingEvidenceRequiredVersion Int?` with **no default and NULL for all preexisting rows**. A modern MULTISIG lock must durably set version 1 **before** any provider side effect, in an idempotent transaction. The classifier must treat version >= 1 with an empty evidence log as uncertain, while NULL retains legacy semantics. Merely adding the nullable column without changing pre-provider write order is insufficient.

**Important unresolved edge:** if the marker commits but the provider call fails before any outpoint is persisted, a subsequent retry cannot assume the provider did nothing. The marker must therefore be paired with a separate, durable attempt/outcome protocol or explicit manual reconciliation of unknown provider outcomes. Do not simply reject all retries forever or automatically re-call `lockFunds`. This is a stop condition for enabling the marker in production, not a reason to erase it.

**Migration review checklist:** exact Prisma field and SQL column casing; null-preserving additive migration; no implicit default or mass backfill; transactional rollback; historical rows queryable; no status rewrite; no synthetic evidence; PG tests with old and new rows side by side; rollback policy that preserves already-written marker values.

## Additional audit finding — trade lock and funding claim transaction boundary

In `EscrowService.lockFunds()`, the code opens `prisma.$transaction(async (tx) => { await lockTradeLifecycle(tx, tradeId); ...; await claimEscrowTransition(escrowId, escrow.status, 'FUNDS_LOCKED') })`. However, `claimEscrowTransition()` in `escrow-lifecycle.ts` has no `tx` argument and calls `escrowRepository.claimTransition()` on its own connection. Thus the trade lifecycle lock and funding status claim **are not demonstrably one transaction**, contrary to the local code comment. This is a separate correctness risk from missing funding evidence.

Do not silently patch this in the evidence-recovery change: first reproduce cancellation-vs-lock interleavings on real PostgreSQL with deterministic barriers and lock timeout bounds; then review a transaction-aware claim API or an equivalent single-transaction CAS design. Verify the actual repository implementation and all callers before changing its signature. An unreviewed switch to a nested transaction could deadlock. This issue is a **gate for enabling modern funding provenance**, not proof that an exploit has occurred.

## Transaction fix implemented — acceptance still pending

The branch now passes the existing interactive `Prisma.TransactionClient` from `EscrowService.lockFunds()` into `claimEscrowTransition(..., undefined, tx)`, and from there to `escrowRepository.claimTransition(..., tx)`. The repository already supported the optional transaction; direct economic-disposition claims still use their existing independent path. This closes the identified connection split for the funding claim, **subject to CI and deterministic race proof**.

`trade-lifecycle-lock.ts` defines a namespaced `trade-lifecycle:${tradeId}` PostgreSQL advisory transaction lock and documents the global lock order trade-lifecycle → escrow → trade row. The funding claim now occurs on the same transaction connection after the trade lifecycle lock, consistent with that order. Verify cancellation's actual locking implementation in a dedicated race test; a sequential CANCELLED test is not sufficient evidence of a concurrency guarantee.

**CI diagnostics as of 2026-10-24:** workflow runs 40088913535 and 40089874363 remained in the PostgreSQL diagnostic step, and 40090222746 and 40090419694 remained in the unit diagnostic step when queried. No successful or failed terminal conclusion was reported for the exact branch head. A direct job-log request returned 404 BlobNotFound while running. Do not interpret the absence of downloadable logs as green, or treat the `bounded diagnostic` label as proof that its time bound has fired.
