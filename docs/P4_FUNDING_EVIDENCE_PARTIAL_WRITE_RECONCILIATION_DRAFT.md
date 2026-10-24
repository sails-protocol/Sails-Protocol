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
