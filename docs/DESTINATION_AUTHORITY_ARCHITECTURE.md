# DESTINATION_AUTHORITY_ARCHITECTURE.md
### Sails Protocol — Engineering Handoff · Destination Authority & Provenance

> Read `SEMANTIC_KERNEL.md`, `CORE_ARCHITECTURE.md`, and
> `CORE_IMPLEMENTATION_ARCHITECTURE.md` first. This document assumes
> K1/K2/K3, the frozen macro architecture, and §15/§16 of the
> Implementation Architecture ("Destination Binding"/"Destination
> Rotation") as fixed input. It answers the question those sections left
> open: *destination binding is fixed at authorization time — fixed by
> whom, and on whose say-so?* Where anything here appears to conflict
> with any of the three documents above, they govern and this document
> is wrong.

---

## 1. Status

**Companion architecture note, Sails Core Implementation Program Mission
M8.5.** Additive to `CORE_IMPLEMENTATION_ARCHITECTURE.md` §15/§16 —
neither section's text changes; this document only answers a question
they left open. Not a Kernel revision (§9 below explains why none is
needed). Produced through a closed adversarial process against six
candidate models (§4-5) and sixty-five self-attack questions (kept in
`git log` for this commit, not reproduced here per this repository's own
publication discipline, `GOVERNANCE.md` §6C).

## 2. Why This Document Exists

Mission M8 (Provider Dispatch Gate) found a concrete, live vulnerability
while checking whether a dispatch-eligibility primitive could safely be
wired into Mission13's real MULTISIG dispute-settlement path
(`docs/M8_DISPATCH_GATE_FINDINGS.md`): `dispute.service.ts`'s
`resolveDispute()` accepts `releaseToAddress`/`refundToAddress` as plain
HTTP parameters supplied by the **arbiter's own request** — not the
beneficiary — and `escrow-lifecycle.ts`'s `resolvePayoutAddress()`
resolves them with "an explicit address always wins," unconditionally
overriding the beneficiary's own registered `PayoutAddress` with zero
cryptographic or durable provenance check.

This is not a validation bug. It is a missing architectural distinction:
the protocol has a clear model for **who decided how much** (Mission13's
signed `AuthorityDecisionPayload`, K2/`INV-12`) but no model at all for
**who decided where**. This document supplies that model.

## 3. The Distinction

> **Economic Disposition Authority** — the authority to decide *who is
> entitled and how much* (an arbiter's ruling, a deterministic ruleset
> outcome). Governed by K1/K2 exactly as already frozen.
>
> **Destination Authority** — the authority to decide *where a specific
> beneficiary's own entitlement is delivered*. This is the beneficiary's
> own authority over their own economic state — the same authority
> `INV-01` (Participant-Bound Authority) already protects for every
> other participant-scoped mutation — never inferred from whoever
> executes the transition, whoever holds the settlement key, or whoever
> happened to decide the disposition.
>
> **Execution Authority / Settlement Key** — the capability to
> mechanically construct, sign, and broadcast a transaction. Already
> distinguished from both of the above by Mission13 — `arbitration-authority.ts`'s
> own header states its security target as Target 1 (Verifiable
> Attribution), never Target 2 (cryptographic prevention of
> divergence), which is exactly this same distinction: decision
> authority ≠ execution authority ≠ settlement key.

These are three independent axes. A conformant system may satisfy all
three with the same identity in a degenerate case (e.g. a single-party
deterministic release to a party's own well-known address) — independence
means they are **never required to coincide**, not that they must always
differ.

**Attack result (mission §37): this distinction survives.** No
counterexample found in which Economic Disposition Authority correctly
implies Destination Authority — see §12 (malicious-arbiter attack) for
the decisive case: an arbiter who is fully entitled to rule "buyer
receives 70%" has never been shown any authority over *where* the buyer
receives it, and every model that grants it that authority anyway (Model
C, §5) reintroduces a single point of compromise that the disposition
decision alone does not carry.

## 4. Central Hypothesis and Its Fate

The CTO's initial hypothesis (Model F: interaction-bound destination by
default, with explicit participant-authorized rotation under policy)
**survives**, refined into what this document calls **F′** (§6): the
"interaction-bound" half is best realized, for the concrete case that
motivated this mission, as *the beneficiary's own standing registered
destination, snapshotted once at Outcome-authorization time* — not a
new, separate interaction-scoped object for the common case — with the
"explicit rotation" half available, not required, as a documented
extension reusing the M5 Attribution primitive verbatim.

## 5. Models Compared

| Model | Description | Verdict |
|---|---|---|
| **A** | Destination frozen at interaction *creation*, never changes | Survives as a *degenerate instance* of F′, not a distinct model — see §6 |
| **B** | Participant-authorized, interaction-bound rotation only (no default binding) | Presupposes a baseline binding to rotate *from* — folded into F′, not independent |
| **C** | Arbiter's own signed decision also binds destination | **REJECTED** — collapses Disposition and Destination Authority into one actor; makes a compromised/malicious arbiter's redirect *cryptographically legitimate* rather than absent a check at all (§12) |
| **D** | Current mutable participant/profile destination, read live at execution time | **REJECTED as stated** (no snapshot — fails §9's "mutable profile must not rewrite historical meaning" and the race test, §17); **survives once snapshotted at authorization time** — this is F′'s own default path (§6) |
| **E** | Caller-supplied execution-time destination | **REJECTED** — this is the status quo vulnerability itself |
| **F** | A + optional B | Survives, refined to F′ |

### Comparison matrix

| Dimension | A (bare) | C | D (bare) | E (status quo) | F′ (survivor) |
|---|---|---|---|---|---|
| Participant sovereignty | Partial (no correction) | None (arbiter overrides) | None (no snapshot) | None | Full |
| Arbiter power | N/A | Overexpanded | N/A | Overexpanded (de facto) | Correctly scoped |
| Runtime power | None | None | Implicit (picks "current") | Total | None |
| Wallet migration | Unsupported | N/A | Trivial but unsafe | N/A | Supported via identity-key re-auth |
| Replay resistance | N/A | Weak (destination rides ruling replay surface) | N/A | None | Strong (reuses M5) |
| Historical integrity | Full (too rigid) | Full | **None** | None | Full |
| Dispute-timing safety | Untested | Fails malicious-arbiter test | Fails race test | Fails everything | Passes §12-§17 |
| Rail neutrality | Yes | Yes | Yes | Yes | Yes |
| Ephemeral rails (Lightning) | Breaks | Breaks | Breaks | N/A | Handled via reference/artifact split (§8) |
| Bitcoin privacy | Forces reuse | N/A | Neutral | N/A | Neutral (wallet's own choice) |
| Implementation complexity | Low | Medium (signing-scheme change) | Very low | (already built) | Low for the default path; medium for the optional override |
| Legacy migration | N/A | Needs re-signing | Needs snapshot discipline | N/A | Fail-closed, no fabrication (§14) |
| Core impact | None | None | None | None | **None** (§10) |

## 6. Selected Model — F′

**Default path (sufficient to close M8's concrete finding):** the
beneficiary's own destination for a payable Outcome is resolved from
their existing, self-registered `PayoutAddress` (already an ordinary
authenticated, participant-attributable write — `INV-OP-6`) and
**snapshotted exactly once**, atomically with the Outcome's own
authorization commit. It is never re-read afterward. This is Model D,
corrected to actually satisfy §15/§16's "fixed at authorization time"
requirement — the missing ingredient in today's code is not a new
primitive, it is simply *doing the snapshot instead of accepting a
caller-supplied override*.

**Optional extension (validated, not required for the first live
slice):** a beneficiary may submit an explicit, interaction-scoped
**Destination Authorization Claim** — structurally identical to M5's
`AttributionClaim` (§7) — to override their standing default for one
specific interaction (privacy, a high-risk counterparty, a rail needing
a fresh reference). Reuses the already-built, already-conformance-tested
M5 Attribution evaluator unchanged; needs no new Core primitive, no new
cryptographic scheme.

Both paths converge on the same rule: **whatever destination reference
is durably bound at the moment the Outcome becomes authoritative is the
only one that may ever execute** — Runtime, Provider, arbiter, and
settlement-key holder are all equally without power to substitute a
different one afterward (§30 rule 4, restated for destination the same
way it already applies to Outcome meaning generally).

## 7. Destination Authorization Semantic Object

**No new Core type.** M5's `AttributionClaim` (`packages/sails-core/src/attribution.ts`,
frozen) is reused verbatim for the optional-override path:

```
actor:                    ActorId               // the BENEFICIARY, never the arbiter/executor
claimedInteraction:        InteractionId         // the interaction this authorization is scoped to
claimedTransitionType:     TransitionTypeId      // a NEW domain transition type (e.g. 'escrow.destination.authorize'),
                                                   //   distinct from ESCROW_DISPUTE_RULING_TRANSITION_TYPE
claimedContentCommitment:  SemanticCommitment    // hash over (beneficiary, asset, destination reference)
proofVerified:             boolean               // computed by Runtime from a real Ed25519 signature, never supplied directly
```

The default path needs no such object at all — the existing,
already-authenticated `PayoutAddress` write already carries all the
attribution this path requires; Runtime only needs to snapshot its
value, not verify a fresh claim.

**Why reuse, not a parallel mechanism (§13's own instruction to attack
the analogy before adopting it):** the check "is this claim
(actor asserts fact, bound to interaction + content) verifiably
attributable to that exact actor, never inferred from whoever executes
it" is the *general* shape K2's own text already states — M5's evaluator
does not actually depend on the claim being about *discretionary
judgment* specifically; it depends only on the claim being an
attributable, scoped, cryptographically-checkable assertion. A
participant's own destination declaration is such an assertion (K1's own
enumerated "consent" mechanism, §11), not K2 discretion — but the
*verification primitive* is identical either way, so reusing it is
correct reuse, not a category error. See §11 for why this does **not**
mean K2 "applies" to destination authorization.

## 8. Ephemeral Destinations (Lightning) — Reference vs. Execution Artifact

A literal Lightning invoice expires; "frozen at authorization time"
cannot mean "use this exact, possibly-now-expired bolt11 string,"
especially across a dispute that may take days or weeks to resolve.

**Resolution:** what is bound at authorization time is a **stable
destination reference** (the beneficiary's own registered
Lightning-capable `PayoutAddress` entry — a node identity, not a single
invoice). The literal, rail-specific **execution artifact** (a fresh
invoice) is generated by the Provider or the beneficiary's own wallet
just before dispatch and is checked for **correspondence** (M6,
unchanged) against the stable reference — exactly the same
"execution-validity is a narrow, targeted re-check, never a full
re-authorization" pattern `CORE_IMPLEMENTATION_ARCHITECTURE.md` §11
already establishes generically. This is the same resolution shape for
every rail with a similarly ephemeral artifact, not a Lightning-specific
patch, and it does not reopen Runtime discretion over *whose* reference
is used (§45) — only over generating a fresh artifact *for* an
already-fixed reference.

## 9. Kernel Impact — None

Attacked directly (§38): does destination authorization need a fourth
Kernel property? **No.** K1 already states, without enumerating
mechanisms, that "consent... [is a] valid way to satisfy" a transition's
condition (`SEMANTIC_KERNEL.md` §5). A beneficiary's own destination
authorization is exactly this — the beneficiary's consent to where their
already-decided entitlement is delivered — not third-party discretionary
*judgment* over someone else's outcome (which is what K2 actually
means). K3 already requires that an authorized Outcome's meaning
(destination included, `CORE_IMPLEMENTATION_ARCHITECTURE.md` §15) never
be altered by whatever executes it — it does not, and was never required
to, say *who authors* that meaning in the first place. K1 (consent) +
K3 (meaning survives execution unaltered) are jointly sufficient. No
Kernel Revision is proposed.

## 10. Core Impact — None

`Outcome`/`DestinationBinding` (M1) and `AttributionClaim`/
`referenceAttributionEvaluator` (M5) are unchanged and unmodified by this
document — both are reused exactly as already built and
conformance-tested. Zero new files under `packages/sails-core/src`.
This satisfies `CORE_ARCHITECTURE.md` §39's own preference: "domain/
runtime semantic object → existing Core type, over expanding Pure Core
unnecessarily."

## 11. Classification — Where This Belongs

**Economic Disposition Authority ≠ Destination Authority survives
adversarial attack** (§3), but is **not** promoted to a new Kernel
property or a new `PROTOCOL_INVARIANTS.md` Level-1 invariant — doing so
without proof of generality is exactly what the mission's own §37
forbids, and none is needed: this is the correct, previously-unapplied
reading of the **already-frozen `INV-01`** ("every action that mutates
protocol state on a participant's behalf must trace to that specific
participant's own verified authorization — never... a coordinator's own
assumption"). A discretionary authority (the arbiter) unconditionally
picking the destination for the *beneficiary's* own entitlement, with no
trace to the beneficiary's own verified authorization, is a coordinator
substituting its own assumption for a participant's — precisely what
`INV-01` already names. This document does not alter `INV-01`'s text; it
records a newly-recognized non-conformant instance (mirroring `INV-12`'s
own "Corrigido/Implementado" annotation convention) — see the annotation
added to `PROTOCOL_INVARIANTS.md` alongside this commit.

Concretely: this document is a **Core Implementation Architecture-level
companion** (peer to §15/§16, not a Kernel or Core Architecture change),
plus a **disclosed conformance-gap annotation** on `INV-01`.

## 12. Adversarial Results (selected, decisive cases)

**Malicious arbiter (§24).** Under F′, an arbiter's ruling never carries
any destination authority at all — `AuthorityDecisionPayload` is
unchanged, still covers only `ruling`/`buyerBps`. An arbiter attempting
to redirect the buyer's payout has no channel to do so: `resolveDispute()`
under the remediated design no longer accepts a destination parameter
from the arbiter's own request at all. **Passes.** (Model C, by contrast,
fails this exact test — see §5.)

**Malicious Runtime (§22).** Runtime cannot substitute a destination
after the Outcome-authorization commit — the binding is durably fixed at
that moment (§6), and any later Runtime-supplied value is compared, not
trusted, exactly as M6's correspondence evaluator already treats every
execution report as an Assertion, never truth. **Passes at the
detection level** — same Level A/Level B classification
`CORE_ARCHITECTURE.md` §35 already gives every other Runtime-trust
question; no stronger claim is made here than there.

**Malicious Provider (§23).** Unaffected by this document — M6's
existing correspondence mechanism is the sole defense, unchanged.
Destination Authority answers *what was authorized*; it was never meant
to answer *did execution comply* (M6/M8's own job).

**Settlement-key holder (§8).** Possessing the capability to
mechanically sign/broadcast a transaction never confers destination
authority under F′ — the two are structurally independent inputs to
dispatch, matching Mission13's own pre-existing "decision authority ≠
execution authority ≠ settlement key" framing, now extended with
destination as a fourth, independent axis. **Passes.**

**Race (§26).** The destination binding commits atomically with the
Outcome's own authorization — ordinary transactional serialization
(`CORE_ARCHITECTURE.md` §26, "coarse serialization... fully sufficient")
settles which of two concurrent rotations is visible at commit time; a
rotation not yet durably committed when the Outcome commits simply did
not happen in time for this Outcome, and affects only a future,
not-yet-authorized one. **Deterministic, not "whichever read wins."**

**Wallet migration (§19).** Destination Authority is bound to the
beneficiary's stable identity key (`User.publicKey`, the same key
already used for session authentication and, in the optional-override
path, for M5's own signature verification) — never to "whichever wallet
happens to be open." A participant moving from Wallet A to Wallet B
re-authenticates with the same identity and re-registers or rotates
normally. **Supported.**

**Compromised wallet / compromised identity key (§20-21).** Honestly
disclosed, not solved: if the compromised surface includes the identity
key itself, this document provides no protection beyond what every other
identity-authenticated action in this system already assumes
(`INV-OP-6`). Key rotation, revocation, and recovery for a compromised
identity key are OpenIdentity territory, not addressed here (§15 below).

## 13. Timing / State Policy

| Phase | Rotation effect |
|---|---|
| Before dispute | Ordinary — affects the next snapshot only |
| During dispute, before arbiter decision | Harmless — Outcome not yet authorized |
| After signed arbiter decision, before Outcome commit | Harmless — `AuthorityDecisionPayload` never carried destination, so the arbiter's signature is entirely unaffected either way |
| After Outcome commit, before dispatch | Requires an explicit, new, properly-authorized correction Transition (`CORE_IMPLEMENTATION_ARCHITECTURE.md` §16, already frozen) producing a NEW committed record — never a mutation of the old one |
| After dispatch begins | Rejected — M8's own `alreadyDispatched` gate; any correction request is deferred to recovery (M9, out of scope) |
| During recovery | Recovery reads the Outcome's own historically-bound destination — never "whatever is currently registered" (`CORE_ARCHITECTURE.md` §40, "reconstruct execution ≠ reconstruct authority") |

## 14. Legacy Migration — No Fabricated Provenance

Every Mission13 dispute resolved before a live M8-R cutover has zero
destination-authorization history — `resolveDispute()` never checked
one. Per this repository's own established convention
(`LEGACY_UNVERIFIED`, already used by every prior migration slice, M3
through M8) and the mission's own explicit "no fabricated legacy
provenance" instruction (§41): such history is never synthesized.
**Recommended default (disclosed, not decided unilaterally — see §16):**
fail closed until the beneficiary registers a real `PayoutAddress` — the
exact error path `resolvePayoutAddress()` already produces today when no
address is supplied and none is registered, so removing the
caller-supplied override actually makes an *already-existing* error path
the *only* path, with no new error handling required. A dual-track
alternative (only newly-opened disputes go through the Core-authoritative
destination check; disputes already mid-flight at cutover keep today's
behavior until they resolve) remains available as a CTO/product choice.

## 15. Explicit Dependencies and Non-Goals

- **Does not require OpenIdentity work first.** The mechanism reuses the
  identity key every participant already has; identity-key rotation/
  revocation/recovery remains a real, disclosed limitation shared with
  every other identity-authenticated action in this system, not a new
  one this document introduces or one that blocks adopting it.
- **Does not require M9 (Recovery) first.** Durable persistence of the
  snapshot uses the same M3.5/M3.5-V machinery already used for M4's
  live migration. Crash-window reconciliation of a mid-dispatch Outcome
  remains the same already-disclosed Recovery Boundary every prior
  migration slice (M4-M8) already carries — not a new dependency.
- **Does not solve compromised wallets or compromised identity keys.**
- **Does not decide third-party-destination policy** — structurally
  permitted (a beneficiary may name any reference; authorization ≠ proof
  of control, §14 of the mission text), left to ruleset/deployment
  policy, matching this project's existing "no compliance logic in
  Core" posture.
- **Does not mandate multiple simultaneous destinations per
  beneficiary** — the first live slice needs exactly one effective
  destination per beneficiary, matching M7's own per-beneficiary-leg
  design; multi-destination payout is out of scope.
- **Does not solve Bitcoin address-reuse privacy** — nothing in this
  model forces reuse; fresh-per-interaction registration remains fully
  available as a wallet-side choice, unconstrained by this architecture.

## 16. What M8-R Still Needs Before Retrying (not built by this document)

This is an architecture note, not an implementation. Concretely
remaining, and requiring a CTO/product decision on the legacy-migration
question (§14) before being built:

1. `resolveDispute()`/`applyRuling()` stop accepting
   `releaseToAddress`/`refundToAddress` as caller-suppliable trust
   inputs for the Core-authoritative path; Runtime resolves and snapshots
   each beneficiary's destination from `payoutAddressService` at
   Outcome-commit time.
2. A clear decision on legacy in-flight disputes (§14).
3. The optional explicit-override path (§7) remains available future
   work, not required to close the concrete M8 finding.

> **Corrected/Implemented 2026-11-27 (temporal reconciliation):** the list above is the remaining work as recorded when this note was written (2026-08-30). Since then the cooperative release path (`/release` and `/initiate-release`) resolves the beneficiary's registered payout address and ignores a caller-supplied destination, as noted in `docs/M8_DISPATCH_GATE_FINDINGS.md` (note after section 6). The legacy dispute ruling path for the non-MULTISIG rails still passes the arbiter's destination, a disclosed residual. This note does not declare any engineering obligation closed.

## 17. Explicit Non-Goals of This Document

Does not claim: that any code has been changed by this document (none
has); that M8-R is now authorized (it is not — `CORE_IMPLEMENTATION_ARCHITECTURE.md`
§29's own migration sequence and this mission's own verdict menu both
require explicit CTO review first); that this closes Technical Debt item
36 (K2 adversarial coverage beyond MULTISIG — unrelated); that identity
compromise, wallet compromise, or crash recovery are solved; formal
verification; or production readiness.
