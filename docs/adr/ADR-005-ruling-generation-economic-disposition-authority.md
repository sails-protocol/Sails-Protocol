# ADR-005 — Ruling-Generation-Bound Economic Disposition Authority

**Status:** Accepted / Frozen  
**Owner:** Issue #218  
**Parent gate:** Issue #165 / docs/BACKLOG.md item 44  
**Baseline:** `main@500d5ee3784f92e961e8046436f1de8206081dd5`

## Implementation note (branch reconciliation)

The Context below describes the historical baseline, not the current
implementation. `economic-disposition-authority.ts` implements
`authorizeDisputedPendingExecution()` with a transaction-scoped lock
shared with appeal and ruling persistence, checks the current resolved
ruling, appeal round, arbiter and authority signature, and persists an
operation-bound authorization digest. An existing authorization is reused
only for the same immutable operation; a subsequent appeal does not
retroactively revoke that committed authorization. Missing ruling
provenance is accepted only when cooperative origin is durably provable.
These are scoped code-level controls, not independent evidence of all
acceptance tests passing, universal provider recovery or production
homologation. The frozen decision below is unchanged.

## Context

Sails already distinguishes several authority layers:

- Identity / Authentication
- Role / current assigned arbiter authority
- Capability / Eligibility authority
- cryptographic Execution Authority
- Economic Disposition Authority

ADR-004 closed the CapabilityGrant initiate→finalize temporal gap. It did **not** solve stale Economic Disposition Authority.

For signature-collection settlement rails, a disputed ruling may create an `EscrowPendingTransaction`. That pending operation can outlive the request that created it and can be finalized later after additional signatures, restart, retry, or an appeal.

Today the pending record durably preserves transaction-construction facts and signer requirements, but it does not preserve a ruling-generation identity. `submitTransactionSignature()` validates real Execution Authority and now validates Capability/Eligibility authority at its execution-commit gate, but it does not prove that the ruling that authorized the economic disposition is still current.

Therefore:

> Valid Execution Authority does not imply current Economic Disposition Authority.

A pending transaction produced by a superseded ruling must never remain executable merely because the signatures are technically valid.

## Decision

### 1. Economic Disposition Authority is operation-bound and generation-bound

Every pending fund-movement operation created from a disputed ruling MUST carry durable authorization provenance identifying the exact ruling generation that authorized it.

The durable identity MUST contain enough immutable facts to prove at least:

- pending operation identity;
- escrow identity;
- dispute identity;
- appeal/ruling generation;
- ruling outcome / disposition;
- authoritative arbiter identity for that generation;
- an immutable digest/fingerprint of the signed authority payload or equivalent canonical ruling facts;
- creation/authorization timestamp.

The implementation MAY store these facts directly on the pending operation or in a separate one-to-one authorization record. The semantic requirement is the same: the evidence survives restart and is not reconstructed from current mutable state.

### 2. Current-generation validation is required at execution commit

Immediately before the first provider side effect, disputed pending execution MUST pass an Economic Disposition Commit Gate.

That gate MUST prove that the pending operation's recorded authorization generation still matches the current authoritative dispute generation.

At minimum it MUST reject when:

- the dispute has advanced to another appeal round;
- the assigned/current ruling authority no longer matches the recorded generation;
- a later ruling superseded the recorded ruling;
- the pending operation's immutable economic facts no longer match its recorded authorization digest;
- the authorization record is explicitly superseded/invalidated.

A stale pending operation is not "failed execution." It is **no longer economically authorized** and must fail closed before provider side effect.

### 3. Appeal and execution commit share one serialization domain

Appeal/reassignment and disputed pending execution commit MUST serialize on the same authority domain.

Canonical lock scope:

`economic-disposition:<disputeId>`

An implementation may use a PostgreSQL advisory transaction lock, row lock / compare-and-swap, or an equivalent database-enforced serialization primitive, but both sides MUST participate in the same ordering relation.

This establishes an unambiguous winner:

- if execution commit serializes first while the ruling generation is still current, it may commit under that generation;
- if appeal/reassignment serializes first, the old generation becomes stale and the pending operation cannot commit afterward.

No read-then-act TOCTOU window is acceptable between current-generation validation and economic execution authorization.

### 4. Durable execution authorization is committed before provider side effect

When the Economic Disposition Commit Gate succeeds, the protocol MUST durably record that the specific pending operation was authorized for execution under that exact ruling generation before the first provider side effect.

This record is distinct from CapabilityGrant execution authorization.

It MUST NOT create new Economic Disposition Authority. It records that already-existing current authority was valid at the execution commit boundary.

After this durable commit:

- retries/recovery may reuse the same committed economic authorization for the same immutable operation;
- retries MUST NOT bind the operation to a later ruling generation;
- mutation of economic facts requires a new operation;
- later appeal/revocation is prospective with respect to an already committed execution attempt, subject to external-outcome reconciliation.

### 5. Appeal supersedes uncommitted prior-generation pending authority

When appeal advances the dispute generation, any prior-generation disputed pending operation that has **not** reached durable Economic Disposition execution commit becomes non-executable.

Implementation SHOULD make this durable and inspectable, for example with a superseded/invalidated marker or equivalent historical record.

Deleting the only evidence of the stale instruction is insufficient if deletion would erase the reason it became non-executable.

### 6. UNKNOWN remains UNKNOWN

If an external provider side effect may already have happened but local persistence is uncertain, later appeal or retry MUST NOT reinterpret that attempt as definitely failed or blindly execute a replacement.

The existing invariant remains:

> UNKNOWN ≠ FAILED.

This ADR does not redefine provider-outcome reconciliation. It requires that authority provenance survive well enough for reconciliation to know **which ruling generation** authorized the uncertain attempt.

### 7. Capability and Economic Disposition gates remain orthogonal

A valid CapabilityGrant cannot rescue stale Economic Disposition Authority.

A current Economic Disposition ruling cannot bypass Capability/Eligibility rules when those rules are enabled.

Both must be valid where required.

### 8. Execution Authority remains necessary but insufficient

Signer membership, valid signatures, PSBT correctness, provider validation, and other Execution Authority checks remain mandatory.

They do not substitute for the current-generation Economic Disposition Commit Gate.

### 9. Cooperative non-disputed settlement is not redefined

This ADR's generation-bound ruling requirement applies to economic operations originating from a disputed ruling.

Ordinary cooperative seller-authorized operations keep their existing authority semantics unless a later mission identifies a separate temporal-authority defect.

### 10. The in-flight old-arbiter resolve-vs-appeal race must use the same generation discipline

The non-MULTISIG race identified by Authority Model Discovery is part of the same causal family: an authority that was current earlier in a call must not commit after a newer appeal generation has won.

Implementation of disputed ruling persistence MUST therefore use the same current-generation / serialization discipline rather than leaving `applyRuling()` as an unconditional stale write.

The exact code path may differ by rail, but the invariant is shared:

> Past ruling authority cannot commit into a newer dispute generation.

### 11. Crash-window atomicity remains separately scoped

The broader crash window between durable Dispute resolution persistence and corresponding Escrow economic effect remains a Temporal/Concurrency obligation.

This ADR supplies the ruling-generation identity required to reason about that recovery, but does not by itself claim full cross-object crash atomicity.

## Required implementation invariants

An implementation conforming to this ADR MUST prove:

1. A pending disputed operation has immutable ruling-generation provenance.
2. Appeal and execution commit serialize on the same dispute authority domain.
3. A prior-generation pending operation cannot newly commit after appeal wins.
4. A current-generation operation can commit without weakening signer/provider checks.
5. Durable economic execution authorization is written before provider side effect.
6. Retry reuses committed authority for the same immutable operation rather than minting authority.
7. Operation mutation invalidates reuse.
8. A valid CapabilityGrant does not rescue stale ruling authority.
9. UNKNOWN external outcome is never converted to FAILED merely because authority later changed.
10. The old-arbiter in-flight race cannot overwrite a newer generation after reassignment.

## Rejected alternatives

### A. Re-check only `Dispute.status`

Rejected. Status alone does not identify which ruling generation authorized the pending economic operation.

### B. Trust `triggeredBy` / current arbiter identity

Rejected. Identity is not a durable ruling-generation binding, and Past Authority ≠ Current Authority.

### C. Treat valid transaction signatures as sufficient

Rejected. Execution Authority ≠ Economic Disposition Authority.

### D. Delete pending transaction on appeal and rely on absence

Rejected as the sole mechanism. Deletion can prevent execution but destroys provenance and is insufficient for uncertain external outcomes, recovery, and auditability.

### E. Let retry rebind the same pending transaction to the new ruling

Rejected. Retry permission ≠ new economic authority. A materially new ruling requires a new economically authorized operation.

## Consequences

Positive:

- stale rulings cannot remain executable merely because signatures are valid;
- appeal vs finalize obtains deterministic ordering;
- restart/retry can reason from durable authority evidence;
- the model composes with ADR-004 rather than conflating capability with economic authority;
- the same generation discipline closes the already-known old-arbiter stale-commit family.

Costs:

- new durable authority provenance is required;
- appeal and finalize gain a shared serialization boundary;
- ruling/pending/recovery tests become generation-aware;
- providers with uncertain outcomes need to retain generation provenance through reconciliation.

## Validation obligations

Before implementation can be frozen, tests must cover at least:

- appeal before final signature → old pending finalize rejected;
- fully signed but not yet committed pending op + appeal → deterministic single winner;
- execution commit before appeal → retry reuses same committed generation;
- later ruling does not revive/rebind prior pending op;
- stale old-arbiter in-flight resolve cannot overwrite newer appeal generation;
- valid CapabilityGrant + stale disposition generation → rejected;
- current disposition generation + revoked/expired CapabilityGrant before ADR-004 Gate B → rejected;
- restart preserves authority provenance;
- UNKNOWN provider outcome retains original generation identity and is not blindly retried.

External Beta evidence remains separately required under #165.

## Relationship to existing decisions

- ADR-003 — rail-scoped arbitration policy: determines which arbitration model/provider governs a rail.
- ADR-004 — CapabilityGrant temporal authority: governs Policy/Eligibility authority across initiate→finalize.
- ADR-005 — governs whether a pending disputed economic action still derives from the current Economic Disposition Authority.

These decisions are complementary, not substitutes.

## Status transition

`Proposed → CTO Gate → Accepted / Frozen → implementation authorization`
