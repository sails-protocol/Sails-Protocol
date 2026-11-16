# ADR-004: CapabilityGrant temporal authority across asynchronous economic execution

- Status: Accepted / Frozen
- Owner: Issue #211
- Date: 2026-09-18
- Scope: CapabilityGrant temporal semantics for asynchronous fund-movement operations

## Context

`CapabilityGrant` is the protocol's policy/eligibility permission: it answers what a Participant or Agent is allowed to invoke. RFC-005 defines the grant shape; RFC-013 makes grants persisted, revocable, scope-bounded, and optionally expiring.

The signature-collection settlement path is asynchronous:

`initiateRelease()/initiateRefund()/initiateSplit()` -> durable `EscrowPendingTransaction` -> one or more submitted signatures -> `submitTransactionSignature()` -> provider finalization / external economic side effect.

Current implementation checks `checkFundMovementCapability()` while creating the pending operation, but does not re-check capability when the last signature makes that operation executable. The pending row persists `triggeredBy`, unsigned payload, required signers, fee facts and operation parameters, but no capability authorization provenance.

That leaves the following semantics undefined rather than intentionally decided:

- grant valid at initiate but revoked before final signature;
- grant expires while signatures are being collected;
- process restart before or after economic execution begins;
- retry after an ambiguous external outcome;
- a later appeal or other economic-authority change while the operation is pending;
- whether the final signer is exercising Capability/Policy Authority or only Execution Authority.

## Decision

These temporal gates apply only when `config.features.enforceCapabilities` is enabled. ADR-004 does not change RFC-014's activation policy: enforcement remains config-gated and disabled by default.

> **Amended 2026-09-21 (Issue #303) - production-only invariant.** Enforcement stays config-gated and disabled by default in development, test and reference environments, and everything below about "enforcement disabled" remains true THERE. In a production process (`NODE_ENV=production`) it is no longer optional: the process refuses to boot unless `ENFORCE_CAPABILITIES` is exactly `true` (`src/config/index.ts`; unset, `false`, or any other value is fatal). See "Production eligibility and self-issued semantics" below. Gate A, Gate B, revocation, expiry and recovery semantics are unchanged. When enforcement is disabled, existing unchecked behavior remains unchanged and no capability execution-authorization snapshot is required.

### 1. CapabilityGrant and execution authority remain separate

A CapabilityGrant is Policy/Eligibility Authority. It does not become:

- Economic Disposition Authority;
- Execution Authority;
- Destination Authority;
- a substitute for role/identity checks;
- a substitute for a current ruling or other economic authorization.

Cryptographic signer checks remain mandatory and independent.

### 2. Asynchronous fund movement has two capability gates

#### Gate A — Admission Gate

When capability enforcement is enabled, at `initiateRelease()`, `initiateRefund()`, or `initiateSplit()`, the `triggeredBy` actor must have a currently valid CapabilityGrant covering the exact required scope.

This gate authorizes preparation of the pending operation. It does not permanently authorize later economic execution.

#### Gate B — Execution Commit Gate

When capability enforcement is enabled and sufficient signatures have arrived, the protocol must re-evaluate the CapabilityGrant of the original `pending.triggeredBy` actor against the exact pending operation before the first external economic side effect.

The final signer is not substituted as the capability subject merely because their signature happened to complete the required signer set. They are exercising Execution Authority; the policy actor remains the original `triggeredBy` recorded on the pending operation.

### 3. Execution authorization becomes durable before side effect

If Gate B succeeds, the protocol must durably record an operation-bound capability authorization commitment before calling the side-effecting settlement provider.

That commitment must identify at minimum:

- pending operation / escrow identity;
- exact CapabilityGrant id that authorized execution;
- `grantedTo` / authorized actor;
- capability name;
- required scope;
- authorization timestamp;
- the grant constraints actually recognized/evaluated by the capability policy at authorization time, or a canonical snapshot/digest sufficient to prove what was evaluated;
- the operation identity or immutable pending-transaction facts to which this authorization applies.

The authorization commitment and the transition from merely-pending to execution-committed must be atomic with respect to capability revocation for the selected grant. The implementation must not leave a check-then-commit TOCTOU window where revocation can win between successful validation and durable execution authorization.

### 4. Revocation and expiry semantics

Before Gate B commits:

- grant revocation blocks execution;
- grant expiry blocks execution;
- restart/retry still requires a currently valid grant;
- collecting signatures does not create policy authority by itself.

After Gate B commits:

- later revocation or expiry does not retroactively erase that already-committed execution authorization;
- retries/recovery/reconciliation of that same execution attempt use the durable operation authorization, not a fresh ambient grant;
- a retry does not create new economic authority;
- an ambiguous external outcome must remain ambiguous until reconciled; revocation must never collapse `UNKNOWN` into `FAILED` or create a new capability authorization for a blind resubmission.

This boundary is the first durable execution commitment, not merely creation of `EscrowPendingTransaction`.

### 5. Grant expiry is not implicitly an operation deadline

`constraints.expiresAt` defines how long the CapabilityGrant may authorize a new Admission Gate or Execution Commit Gate.

It does not, by itself, define a lifetime for an execution authorization already durably committed under Gate B.

If a product or future policy requires an operation-level deadline, that must be represented explicitly as an operation constraint/deadline. It must not be inferred silently from grant expiry.

### 6. Re-authorization before Gate B may use a different valid grant

If the original grant is revoked or expires before Gate B, execution may proceed only if the actor currently possesses another CapabilityGrant that independently authorizes the unchanged pending operation under the capability rules that are actually implemented at that time.

The new grant must be evaluated against the existing immutable pending operation. Re-authorization must not mutate economic parameters, destinations, ruling, required signers, or unsigned payload.

If those facts change, that is a new operation and requires a new initiation path.

### 7. Capability authorization never rescues stale Economic Disposition Authority

Gate B must not treat a valid capability as proof that the pending economic instruction is still current.

Appeal/reassignment, superseded ruling, stale pending transaction, or another Economic Disposition Authority change remains a separate freshness/correspondence question. Existing backlog ownership for that problem remains unchanged.

Therefore:

`Capability valid` does not imply `economic instruction current`.

Both properties must hold before an economic side effect is permitted.

### 8. Session validity remains separate

Each authenticated API action continues to require whatever session/identity checks its route already requires.

A valid session does not satisfy a CapabilityGrant check, and a durable execution authorization does not create a new session.

## State semantics

The table below applies with capability enforcement enabled. With enforcement disabled, RFC-014's existing unchecked behavior is preserved.

| Moment | Capability requirement | Result of later revoke/expiry |
| --- | --- | --- |
| Before initiate | live grant required | operation cannot be created |
| Pending, signatures incomplete | prior admission is not enough for execution | revoke/expiry prevents Gate B |
| Last signature received, before execution commitment | live grant required for original `triggeredBy` | revoke/expiry wins if it commits first |
| Execution authorization durably committed, provider not yet called | operation-bound authorization governs | later revoke/expiry is prospective |
| Provider called, outcome known | use committed authorization + execution evidence | no fresh grant required for bookkeeping |
| Provider called, outcome UNKNOWN | reconcile same attempt only | no fresh grant may authorize blind duplicate submission |
| Pending operation abandoned/deleted before Gate B | no surviving execution authorization | any future operation requires a live grant |

## Required implementation properties

Implementation is authorized only if it preserves all of the following:

1. `CapabilityRegistry` must be able to resolve the exact grant that authorized an operation, not only return a boolean.
2. The chosen grant and evaluated scope/constraints must become durably inspectable, including after successful finalization and pending-row cleanup. That evidence must survive successful finalization: today `EscrowPendingTransaction` is deleted after finalize succeeds, so an implementation may not satisfy this requirement by storing the only authorization provenance on a row that is then deleted. Either the pending-operation lifecycle must retain a terminal record, or a tightly scoped related authorization record must outlive pending-row cleanup.
3. Gate B must evaluate the original `pending.triggeredBy`, not whichever signer happens to submit last.
4. Gate B validation and durable execution-authorization commitment must be serialized against revocation of the selected grant.
5. No provider side effect may occur before that durable commitment.
6. Once execution is committed, capability handling during retry/recovery must reuse that operation identity and authorization; it must not manufacture a second capability authorization from a new request. Provider-specific submission identity, reconciliation, and idempotency remain separately owned.
7. Existing cryptographic signer validation and state-transition claims must not be weakened.
8. Economic-authority freshness remains independently required; this ADR does not close the stale-ruling/pending-instruction owner.
9. `ENFORCE_CAPABILITIES=false` must preserve the existing unchecked behavior and must not require capability authorization provenance. *(Amended, Issue #303: this applies to non-production environments only; a production process cannot run with `false`.)*

## Constraint-policy boundary

ADR-004 does not invent semantics for opaque `CapabilityGrant.constraints` keys. The current registry explicitly enforces `expiresAt`; example vocabulary such as `maxValue` does not become enforced merely because this ADR snapshots constraints. Gate A and Gate B must apply every constraint the Capability policy actually recognizes at that time, and the durable authorization must make that evaluation inspectable. New constraint semantics require their own explicit policy/wiring rather than inference here.

## Bounded implementation shape

For the current signature-collection path, the smallest acceptable implementation is an operation-bound authorization snapshot/reference associated with `EscrowPendingTransaction` rather than a new generic authorization framework. Because the current finalize path deletes `EscrowPendingTransaction` after success, the authorization evidence must either move/resolve into a durable terminal record before that deletion or live in a tightly scoped related record that is not cascade-deleted with the pending row. Persisting the only copy on the transient pending row and then deleting it is not compliant.

A separate universal authorization service/table is not required by this ADR.

The implementation may add a targeted CapabilityRegistry resolver such as `resolveGrant(...)` / `authorizeForOperation(...)` so long as the externally visible semantics above are preserved.

## Rejected alternatives

### A. Initiation-only capability

Rejected. A grant revoked before any economic side effect would have no effect on an already-prepared pending operation, making revocation misleading and ineffective during the longest asynchronous window.

### B. Re-check live grant on every retry forever

Rejected. Once an external execution attempt has been durably authorized and may already have produced a side effect, later revocation cannot safely rewrite history. This model risks converting unknown outcomes into apparently unauthorized failures and encouraging a new submission instead of reconciliation.

### C. Treat the final signer as the capability subject

Rejected. Required signers provide Execution Authority. The actor whose policy eligibility caused the economic operation to be prepared is `pending.triggeredBy`; conflating the two recreates `Execution Authority = Policy Authority`, which is false.

### D. Snapshot capability permanently at initiate

Rejected. It gives revocation no power during signature collection even though no economic side effect has yet been committed. Preparation is not execution commitment.

### E. Let implementation behavior define the rule

Rejected. The current absence of a finalize check and absence of persisted capability provenance is precisely the ambiguity this ADR resolves.

## Relationship to other authority work

- #211 owns this CapabilityGrant temporal decision.
- #165 remains the Beta Readiness scenario registry.
- #206 proved `Past Authority != Current Authority` for arbiter reassignment; it does not decide CapabilityGrant lifetime.
- The stale Economic Disposition Authority / pending-instruction problem remains separately owned by its existing Architecture/Temporal-Concurrency backlog owner.
- WDK `SUBMISSION_UNKNOWN` handling and each provider's submission/reconciliation/idempotency guarantees remain governed by their existing execution-truth owners; this ADR reinforces, rather than replaces, `UNKNOWN != FAILED`.

## Validation obligations

At minimum the implementation must prove:

1. with enforcement enabled: valid at initiate, revoked before final signature -> finalize blocked before provider side effect;
2. with enforcement enabled: valid at initiate, expired before final signature -> finalize blocked before provider side effect;
3. a replacement valid grant can authorize the exact unchanged pending operation;
4. execution authorization committed, then grant revoked -> same committed attempt may complete/reconcile;
5. restart before Gate B -> current capability still required;
6. restart after Gate B -> durable authorization is recovered; no new grant required for same attempt;
7. final signer without the original actor's capability cannot become the policy authority merely by submitting the last signature;
8. capability success does not bypass stale Economic Disposition Authority checks once those are implemented;
9. retry after Gate B reuses the same capability execution authorization and does not manufacture a second capability authorization; provider-specific duplicate-submission safety remains a separate validation obligation;
10. with enforcement disabled: initiate/finalize behavior remains unchanged and no CapabilityGrant is required.

## Consequence

The protocol gains an explicit temporal boundary:

`permission to prepare` != `permission to execute` != `permission to retry a new economic action`.

A CapabilityGrant remains revocable until execution authority is durably committed. After that boundary, capability semantics follow the already-authorized operation rather than ambient permission state; this ADR does not claim to solve provider-specific reconciliation or idempotency.

## Production eligibility and self-issued semantics (Issue #303, 2026-09-21)

**Production eligibility.** A production-eligible Sails deployment cannot disable Capability Authority: `NODE_ENV=production` with `ENFORCE_CAPABILITIES` unset, `false`, or any value other than exactly `true` fails at boot. Development, test and reference environments may still run with enforcement disabled.

**Canonical vocabulary.** Only these (capabilityName -> action scopes) pairs may be registered; anything else is rejected at registration (400) instead of being persisted as an arbitrary authority string. They are exactly the scopes an existing gate consumes (`CANONICAL_CAPABILITY_SCOPES`, `src/core/capability-registry.ts`; mirrored by the SDK and kept in lockstep by `tests/capabilityCanonicalOnboarding.test.ts`):

| capabilityName | scopes | consumed by |
| --- | --- | --- |
| `trade-coordination` | `intent.created`, `intent.discovering` | `intent-engine.ts` create(), `intent.routes.ts` propose |
| `settlement` | `settlement.escrow.released`, `settlement.escrow.refunded`, `settlement.escrow.split` | Gate A `checkFundMovementCapability()`, Gate B `authorizePendingExecution()` |

**Self-issued semantics (explicit).** The only public issuance route is self-issued (`issuedBy = grantedTo`). A self-issued CapabilityGrant is the participant's OWN revocable, expiring, auditable consent/delegation, plus the operation-bound Gate B commitment. **Self-issued CapabilityGrant != independent third-party authorization.** It does NOT protect against an already-authorized participant acting maliciously, is not bounded per trade, escrow or amount, and no claim to the contrary is made. Independent / multi-party issuance is a separate architectural evolution (RFC-013 s5 follow-up), deliberately not part of #303; no platform admin or central issuer exists.

**Onboarding (no manual DB intervention).** Every actor that reaches a gate self-issues the canonical grants through `capabilities.ensureCanonicalGrants(participantId)` (SDK), which the reference UI runs on every login: buyers and sellers need both capabilities; an **arbiter** needs the `settlement` grant (an assigned arbiter without one fails closed on release/refund/split); the **seller** needs the `settlement` grant for the sweeper's expiry refund, which runs as the seller (there is no "system" actor and no silent exemption). A missing or expired grant makes the action fail with an explicit error and is recoverable by onboarding; nothing deadlocks.

**Registration is idempotent under concurrency.** `CapabilityGrantRepository.create()` runs in one transaction under the per-(actor, capability) `pg_advisory_xact_lock` that revocation and Gate B already use (a database UNIQUE constraint cannot express "one LIVE grant": liveness depends on `constraints.expiresAt`, and an expired grant is not revoked). An equivalent LIVE grant (same grantedTo/capabilityName/issuedBy, not revoked, not expired, covering every requested scope, identical constraints) is returned instead of inserting a duplicate, so concurrent or repeated onboarding converges to one effective grant per canonical capability. A revoked or expired grant is never equivalent: reissue always works and the historical row is untouched. Distinct grants (different constraints or wider scope) are still created normally. `lockFunds` deliberately has no capability gate (separate semantic decision, out of #303).
