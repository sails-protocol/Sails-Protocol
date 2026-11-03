# ADR-003 — Rail-Scoped Arbitration Policy and Capability

- **Status:** Proposed for CTO Gate
- **Date:** 2026-09-18
- **Owner:** Issue #207
- **Related:** #165, #206, RFC-021, ADR-002

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

---

## CTO addendum proposal — 2026-11-03: independent pre-funding arbiter authority and cross-node commitment

> **Review status: DRAFT / NOT ACCEPTED.** CTO approves the **architectural direction** of independent arbiter keys and bilateral pre-funding consent, but this text is a review proposal only. No code, runtime, schema, SDK, deployment, migration or Day-0 criterion is authorized by this section until a separate CTO implementation gate following independent Gatekeeper review. The existing ADR-003 rail-scoped decision remains in force.

### Canonical ownership and relationship

This is a refinement of the existing Day-0 Multi-Operator obligation in `docs/BACKLOG.md` item 18 and Issue #105, under ADR-001. It does **not** reopen the completed Issue #207 or the rail-scoped implementation from PRs #213/#214. The arbitration capability vocabulary stays unchanged: `MULTISIG = FIXED_ARBITER_COMMITMENT`; `UNKNOWN` remains fail-closed; a script-fixed rail cannot be advertised as dynamically reassignable.

The issue is distinct from per-rail policy: **which independent signing authority was knowingly accepted by both trade parties before they irreversibly funded an escrow?** The node that hosts a dispute is not thereby entitled to select the arbiter, and the operator's KMS custody is not independent arbiter control.

### Direction approved by CTO, design details subject to independent review

1. **Bilateral pre-funding acceptance.** Both participants must independently verify and explicitly accept the same arbiter identity and public key, selected settlement implementation/rail, arbitration policy/version, permitted outcome semantics and resulting escrow script/address. No implicit `trustedArbitrators[0]` selection may be presented as mutual consent.
2. **Independent signing control.** A third-party arbiter must control its own private signing material and authorize its own signatures, outside the dispute-hosting node and commercial reference implementation. A hosted KMS key controlled by the operator is not evidence of independence.
3. **Immutable commitment.** The accepted arbiter public key, trade and participant identities, effective rail/policy and settlement script/address must be bound in a durable, independently verifiable commitment before funding. Canonical encoding, signature domain separation, freshness and replay prevention are required design questions, not assumptions.
4. **No post-funding silent substitution.** Current P2WSH 2-of-3 MULTISIG cannot change its third public key by assigning a different arbiter. Arbiter rotation, appeal, node failure and key loss cannot silently change the funded script. Legacy escrows must preserve the originally committed signing authority; migration, if ever required, needs a separately consented and independently audited transaction path.
5. **Ruling is not spend authority.** Verify allowed destination, amount, fees and signing intent independently. QVAC/automated advice, evidence hosting and reputation decisions do not create a new fund-moving signer.
6. **Cross-node independence.** A node receiving `raiseDispute()` must not be able to overwrite the accepted arbitration authority. Evidence, dispute status and ruling provenance must remain authentic and recoverable if a hosting node disappears; specify the limits of offline arbitration honestly.
7. **Rail-specific claims.** SAFE_GUARD_EVM's `SailsSignerService`/AWS KMS third signer requires its own security and independent-operator design. No security equivalence with MULTISIG is inferred. Market arbitration remains production-ineligible until separately evidenced, including externally backed collateral and #255 idempotency.
8. **Fail closed.** Conflicting participant views, unavailable arbiter proof, missing signed consent or inconsistent commitments must refuse funding/authorization. Any timeout/refund escape hatch must be proven under the actual script or contract, not promised as a recovery mechanism.

### Alternatives evaluated

- **A: keep operator-derived `MULTISIG_SEED` key:** compatible with the present bootstrap, but does not satisfy the independent third-party objective. May remain a separately and truthfully disclosed legacy/bootstrap mode.
- **B: independently controlled arbiter public key, accepted by both parties before funding:** **CTO-preferred design direction**; implementation and exact consent protocol still pending.
- **C: dynamic post-funding arbiter replacement under the existing P2WSH script:** rejected as incompatible without an entirely different, independently audited settlement mechanism.

### Required design/evidence before implementation authorization

- Inspect `getDepositAddress`, `submitParticipantKey`, `deriveArbiterKey`, `assertArbiterMatchesScript`, dispute assignment, signature collection, SDK verify-before-sign and existing funded-escrow recovery.
- Define the exact signed consent object, authoritative durable owner, client-side verification, external arbiter key-possession proof, failure behavior and historical compatibility.
- Adversarial tests: different nodes propose different arbiters; mismatched policy/script; forged or replayed consent; unauthorized destination/amount; arbiter key rotation/loss; operator compromise; cross-node dispute failover; stale appeals; external signer unavailability; real persistence/restart/concurrency as relevant.
- Document what an appeal can and cannot do when an arbiter is script-fixed. Cross-reference ADR-001, ADR-005, RFC-020, Issue #105, #220, #255 and future-only #438.
- Gatekeeper reviews the complete proposal and evidence independently. CTO issues a separate implementation authorization only after the Project #3 card/owner and Master Backlog sequencing are verified.

### Tracking caveat

The Project #3 exact card and field mapping were **not verified** by the GitHub connector during this review. No new backlog card is created and no Project status is claimed. The canonical existing obligation is `docs/BACKLOG.md` multioperator item 18 / Issue #105.
