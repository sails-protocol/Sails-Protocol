# ADR-003 — Rail-Scoped Arbitration Policy and Capability

- **Status:** Proposed for CTO Gate
- **Date:** 2026-09-18
- **Owner:** Issue #207
- **Related:** #165, #206, RFC-021, ADR-002
- **Status note (2026-10-26):** the policy is implemented (Issue #214, merged) and exercised by the arbitration-policy tests. The status line above is the historical text of 2026-09-18 and is not edited here; whether the ADR's formal status has moved past Proposed for CTO Gate is for the CTO to confirm. Day 0 uses the trusted-list; market remains production-ineligible and off.

## Context

Sails currently exposes a deployment-wide arbitration mode:

`trusted-list | market`

The current startup guard correctly refuses `market` whenever a script-committed-arbiter settlement implementation is available. Today `MULTISIG` is always available and commits one specific arbiter identity into the settlement script, so a deployment-wide `market` mode cannot truthfully be honored across all settlement implementations.

This is not a defect in the guard. The missing architecture is that arbitration capability and arbitration policy are currently modeled globally while settlement execution constraints are rail/implementation-specific.

A correct model must preserve all of these truths simultaneously:

1. `MULTISIG` must remain fail-closed when dynamic arbiter reassignment cannot be honored by its script.
2. A dynamically reassignable rail may use market arbitration without forcing unrelated fixed-arbiter rails to disappear.
3. A deployment must never advertise market arbitration for a rail that actually resolves under a fixed/script-committed arbiter.
4. Existing rails must not be disabled merely to make an arbitration test boot.
5. Selection must be explicit and inspectable. Silent fallback from market to trusted/fixed arbitration is forbidden.

## Decision

Adopt **rail-scoped arbitration capability + rail-scoped arbitration policy resolution**.

The settlement implementation remains the runtime key for this first implementation because that is the real execution discriminator already used by OpenSettlement. This does **not** elevate `EscrowType` into canonical Provider Identity; ADR-002 remains authoritative on that distinction.

### 1. Arbitration capability is declared per settlement implementation

Introduce an explicit capability vocabulary:

- `FIXED_ARBITER_COMMITMENT`
  - the execution mechanism commits or otherwise binds one arbiter identity such that dynamic reassignment cannot be honored for an already-created escrow;
- `DYNAMIC_REASSIGNABLE`
  - the execution mechanism can honor a newly assigned arbiter without contradicting a previously fixed execution commitment;
- `UNKNOWN`
  - capability has not been proven. Fail closed for market arbitration.

Initial declarations must be evidence-based, never inferred from names.

At minimum:

- `MULTISIG` → `FIXED_ARBITER_COMMITMENT`
- `MOCK` → `DYNAMIC_REASSIGNABLE` for test/reference validation only; this does not make MOCK Product Scope or production-eligible.
- every other implementation remains `UNKNOWN` until direct code/evidence audit proves otherwise.

### 2. Arbitration policy is resolved per settlement implementation

Add a rail/implementation-scoped policy resolver with modes:

- `trusted-list`
- `market`

A deployment-wide value may remain only as a default/fallback for backward compatibility. It is no longer sufficient evidence that every rail uses that mode.

An explicit per-implementation override is authoritative for that implementation.

Example:

```
global default: trusted-list
MOCK: market
MULTISIG: trusted-list
```

This configuration is valid.

This configuration is invalid:

```
MULTISIG: market
```

because `MULTISIG` is `FIXED_ARBITER_COMMITMENT`.

### 3. The compatibility guard is preserved and generalized

`assertArbitrationModeCompatibleWithAvailableRails()` must not be deleted or weakened.

Its responsibility changes from:

> global market mode + any fixed rail => fail

to:

> for every explicit/effective rail policy, verify the selected arbitration mode is compatible with that rail's declared arbitration capability.

Rules:

- `market + DYNAMIC_REASSIGNABLE` → allowed
- `market + FIXED_ARBITER_COMMITMENT` → fatal startup/configuration error
- `market + UNKNOWN` → fatal startup/configuration error
- `trusted-list` → allowed unless a future rail declares a stricter incompatible property

Unknown remains fail-closed.

### 4. Dispute arbitration provider selection becomes escrow-aware

The arbitration provider used to assign a dispute must be selected from the escrow's settlement implementation, not from one process-wide singleton chosen before the dispute's execution context is known.

Required flow:

`trade → escrow → settlement implementation → effective arbitration policy → ArbitrationProvider`

This is the semantic point where rail-specific execution constraints and arbitration policy meet.

The selection must be deterministic and inspectable.

### 5. Appeal uses the same effective arbitration policy

Appeal/reassignment must resolve through the same rail-scoped policy as the dispute it belongs to.

A rail using `trusted-list` cannot silently begin using market arbitration at appeal time.

A rail using `market` may use `assignAppealPanel()` only if its declared capability is `DYNAMIC_REASSIGNABLE`.

### 6. Public truth must be inspectable

The effective arbitration mode for an escrow/dispute must be derivable from durable configuration + settlement implementation. Product/UI code must not need private server knowledge or guess from a global flag.

A later API exposure may be added if needed, but the implementation must first make the resolution deterministic and testable in Core/Runtime.

## Rejected alternatives

### Disable MULTISIG whenever market arbitration is desired

Rejected.

That changes settlement availability to solve an arbitration-modeling problem, introduces deployment-state/recovery complications for existing escrows, and would tempt tests to manufacture reachability rather than model the real coexistence of rails.

### Weaken the startup guard for MOCK/test

Rejected.

A test-only bypass would make #206 pass without proving the production architecture.

### Let market mode silently fall back to the script-committed arbiter

Rejected.

That is the exact semantic mismatch the current guard correctly prevents.

### Treat `ARBITRATION_MODE=market` as "market where possible"

Rejected unless expressed through explicit rail-scoped policy.

"Where possible" is not inspectable enough for economic authority. A rail's effective policy must be explicit.

## Consequences

### Positive

- market arbitration can coexist with fixed-arbiter rails honestly;
- MULTISIG remains fail-closed;
- #206 can be re-run using explicit `MOCK → market` without disabling MULTISIG;
- future rails can declare their own arbitration capability without inventing another global flag;
- authority semantics become aligned with settlement execution reality.

### Costs

- `DisputeService` provider selection must become escrow-aware rather than singleton-global;
- configuration parsing gains a per-implementation arbitration policy surface;
- tests must cover compatibility matrix and provider selection;
- existing comments/docs that imply one arbitration provider per process need reconciliation.

## Implementation gate

After this ADR is accepted:

1. add arbitration capability declarations;
2. add per-implementation policy configuration/resolver;
3. generalize the startup compatibility guard;
4. make dispute + appeal provider selection escrow-aware;
5. add regression tests for:
   - `MULTISIG → market` rejected;
   - `UNKNOWN → market` rejected;
   - `MOCK → market` accepted;
   - mixed deployment: `MOCK → market`, `MULTISIG → trusted-list` accepted;
   - dispute on MOCK uses MarketArbitrationProvider;
   - dispute on MULTISIG uses TrustedArbitratorProvider/fixed-compatible policy;
   - appeal preserves the same rail-scoped policy;
6. re-run #206 through the published SDK against merged main.

## Non-goals

This ADR does not:

- redesign MULTISIG's script;
- make MULTISIG dynamically reassignable;
- solve the in-flight old-arbiter-vs-appeal race;
- solve stale pending-transaction authority after appeal;
- decide CapabilityGrant lifetime (#211);
- declare any UNKNOWN rail dynamically reassignable without evidence.
