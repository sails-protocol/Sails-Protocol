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
