# PROTOCOL_INVARIANTS.md
### Sails Protocol — Engineering Handoff · Document 19 of 20

> Requested explicitly by the CTO after reviewing RFC-001 through RFC-005:
> "a technical constitution — rules that can never be broken." This is
> distinct from `PRINCIPLES.md` (9 principles that *guide* architectural
> decisions) and `PHILOSOPHY.md` (the reasoning *why* those principles
> exist). Invariants are stricter than either: they are not guidance to be
> weighed against other considerations — they are conditions that, if
> violated, mean the resulting system is no longer the Sails Protocol,
> regardless of what it's called.

---

## How an Invariant Differs From a Principle

A Principle can be honored imperfectly and still leave a recognizably
sound protocol — e.g., "Interface Agnostic" (Principle 9) was violated
once, informally, in an early `Negotiation` draft, and fixing it (RFC-004)
was a correction, not a rebuild. An Invariant cannot be violated even
once without the system ceasing to be Sails Protocol. There is no
"mostly non-custodial" the way there can be a "mostly interface-agnostic
Negotiation before RFC-004 fixed it."

---

## Canonical Hierarchy (Reconciled — Missão 11 Fase 9.3.3, 2026-08-25)

> **Why this section exists.** Since at least an earlier architecture
> review ("Fase 9.0"), the CTO's own working process has referenced an
> eleven-item invariant framework ("INV-01" through "INV-11") plus
> derived properties ("DP-01" through "DP-09") when evaluating this
> protocol — but that framework was never itself committed to this
> document. Its only trace in the repository was fragmentary: a few
> code comments citing "INV-07F," "DP-03," "DP-05," "DP-07" for one
> specific finding (`escrow-lifecycle.ts`, `multisig-funding-reorg-
> sweep.ts`), and one RFC citing "INV-01" by number with no definition
> alongside it (`RFC-019`). Reconciled here into ONE canonical
> hierarchy — this document remains the single constitution; there is
> no separate "CTO constitution" a reader has to choose between.

This document's invariants now form three explicit levels:

- **Level 1 — Core Protocol Invariants.** Small, semantic,
  technology-independent laws. A Core Invariant is stated once, does
  not reference specific code, and cannot be satisfied "80%." Two
  families exist side by side, both genuinely Level 1, kept in
  separate subsections purely for readability: the original six
  **Structural** invariants (protocol *shape* — custody, fiat,
  module boundaries, infrastructure neutrality; unchanged below,
  just explicitly re-anchored into this hierarchy) and twelve
  **Behavioral** invariants (participant authority, verification
  discipline, economic exactness, recoverability, verifiability,
  attributed authority integrity — the original eleven from the
  framework referenced above, formally defined for the first time in
  §"Level 1 — Behavioral Core Invariants" below, plus `INV-12`, added
  Missão 12, 2026-08-29).
- **Level 2 — Derived Properties.** Concrete consequences a Core
  Invariant *requires*, one level more specific than the Core law
  itself but still technology-general (not yet "here is the exact
  function that checks this"). See §"Level 2 — Derived Properties."
  **The historical "DP-01" through "DP-09" numbering could not be
  reconstructed** — no commit, doc, or RFC anywhere in this repository
  defines what DP-01, DP-02, DP-04, DP-06, DP-08, or DP-09 actually
  *say*, and even DP-03/DP-05/DP-07 (the only three ever cited) were
  cited together, undifferentiated, for a single finding — not as
  three individually distinct definitions. Rather than invent
  plausible-sounding text to fill nine numbers that were never
  actually written down, this document defines a **fresh, honest**
  Derived Property catalog from currently-proven architecture. Every
  prior "DP-*" citation anywhere in this codebase is non-canonical
  going forward; see the per-item notes in §"Level 2" for where each
  old citation's underlying *substance* now lives.
- **Level 3 — Operational Invariants.** Code-traceable implementation
  obligations — the existing "Operational Invariants" section below,
  unchanged in content, now with an explicit **Derives from** line on
  each item pointing at the Level 1 law(s) and Level 2 propert(y/ies)
  it exists to satisfy.

**Governance rule this hierarchy exists to enable** (see also
§"Conformance Is Not "Tests Pass"" near the end of this document): a
citation to any invariant — `INV-01` through `INV-12`, any
`INV-OP-*`, any `DP-*` — must resolve to a real, findable definition
in this document. A citation that doesn't is a documentation bug, to
be fixed the same way a broken code reference would be — not left as
an unresolvable pointer into a review process's private notes.

---

## Level 1 — Structural Core Invariants

> Retitled from "The Invariants" *(2026-07-19, same consolidation pass
> that added the "Operational Invariants" section below)* — not a
> content change, just a label distinguishing these six protocol-shape
> rules from the code-traceable ones added below. Both are equally
> "never broken"; they differ in what they're rules *about*. Re-
> anchored as "Level 1" *(2026-08-25, Missão 11 Fase 9.3.3)* — same
> non-change: these six were already Core-Invariant-shaped (small,
> semantic, technology-independent), just not yet using that label.

### 1. The Core Never Knows Concrete Implementations

The Intent Engine, Coordination Engine, Event Bus, State Machine,
Capability Registry, and Policy/Rules Engine (`ARCHITECTURE.md` §1B) never
reference a specific chain, a specific transport, a specific identity
scheme, or a specific module's internal logic. Every place a concrete
choice is needed, an interface exists instead — `SettlementProvider`
(§1.5), `TransportProvider` (RFC-002), `Participant` (RFC-001),
`Capability` (RFC-005). If any future code adds a direct dependency from
Core onto a concrete implementation, that code is wrong, not the
invariant.

### 2. The Protocol Never Custodies Assets

No Sails Protocol component — Core, module, or Reference Implementation
acting as the protocol itself — ever holds a private key or controls an
asset on a user's behalf. `SettlementProvider` implementations lock value
in escrow (multisig, HTLC, covenant) that no single party unilaterally
controls; they never transfer custody to a Sails-operated account. This is
`PRINCIPLES.md` Principle 3 ("Self Custody Always") elevated from
guidance to invariant because it is the protocol's entire reason for
existing over a custodial alternative — see `PHILOSOPHY.md`, "Why
Coordination, Not Custody."

> **⚠ Known violation, real code, 2026-07-19.** Per this document's own
> §"How Invariants Are Enforced" below, a violation is not something to
> quietly caveat — it means the violating system is not Sails Protocol.
> Stating that plainly: the one real, tested `SettlementProvider`
> (`WdkSettlementProvider`, `wdk-settlement.provider.ts`) violates this
> invariant. It signs every escrow release from a single server-held
> seed phrase, not from any user's own key — full detail in
> `CRYPTOGRAPHIC_MODEL.md` §5, `SECURITY_MODEL.md` §2 Principle 2. This
> is flagged here loudly, not smoothed over, precisely because the
> correct response per this document's own rule is "remove the
> violation" — **RFC-019** (`rfcs/RFC-019-settlement-custody-reference-vs-normative.md`)
> is the accepted, registered plan for doing exactly that: reclassifying
> the current implementation as a reference-only implementation and
> specifying the real non-custodial target architecture, without
> committing to a build date. Also tracked in `TODO.md`. **RFC-020**
> (`rfcs/RFC-020-non-custodial-evm-settlement.md`, RFC-019's own Phase 2)
> registers real engineering progress toward closing this gap — a Safe
> Transaction Guard contract that compiles clean against real audited
> dependencies and tested `@satsails/p2p-trading-sdk` custody interfaces (ERC-4337
> UserOperation hashing, KMS co-signing) — but nothing in it is deployed
> or wired into `WdkSettlementProvider`'s actual release path yet, so the
> violation stated above remains live.

### 3. Fiat Always Settles Outside the Protocol

The protocol never receives, holds, processes, or executes a fiat
payment — PIX, ACH, SEPA, Wire, UPI, or any other rail. Fiat settles
directly between participants; the protocol only coordinates negotiation
and digital-asset settlement. Canonical statement (`MASTER_COORDINATION.md`
v8.0): *"Fiat is always settled directly between participants. The
protocol never intermediates fiat."*

### 4. Every Module Is Optional

No application is required to implement more than the modules its use
case needs. A Reference Implementation offering only `OpenP2P` is as
valid an implementation of Sails Protocol as one offering all seven
current modules. This is what makes `Capability` (RFC-005) a meaningful
abstraction rather than a fixed bundle — an application declares which
Capabilities it implements or consumes; the protocol never assumes all of
them are present.

### 5. Every Implementation Respects the Protocol Principles

`PRINCIPLES.md`'s 9 principles are not a checklist a Reference
Implementation can partially satisfy and still claim to implement Sails
Protocol. An implementation that touches fiat, or that lets an Agent act
without a delegating Participant's authority, is not a partial
implementation of Sails Protocol — it is not an implementation of Sails
Protocol.

> **Extended — Missão 12, 2026-08-29 (Constitutional Closure).** The
> paragraph above states WHAT counts as a conformant implementation. It
> says nothing about HOW that fact is determined — an independent
> reviewer testing a candidate implementation against a private
> conformance oracle would satisfy the paragraph above literally while
> still depending entirely on someone's undisclosed say-so. Closing
> that gap: for a **released version** of the protocol, whether a
> given implementation meets this bar must be determinable from the
> normative basis that version itself identifies — which may include,
> by explicit incorporation, public external normative material
> (consensus rules, cryptographic standards, accepted RFCs, schemas, or
> other publicly identifiable references) — without resting on
> interpretation available only to whoever authored it. A version's own
> text may not make private, non-public judgment the ultimate
> determinant of its own meaning, and no party — including whoever
> authored a released version — may treat a later private assertion
> about what it meant as retroactively binding on that same version.
> This does not restrict who may author future versions, does not
> require a released version's text to be unambiguous, and does not
> require reproducing an external standard inside Sails' own artifacts
> — only that a version's meaning, once released, not be silently
> rewritten by anyone's after-the-fact say-so. This repository does not
> yet have a formal released-version artifact-identity mechanism —
> disclosed as a tracked gap, not hidden, the same discipline Structural
> Invariant 2 already applies to the WDK custody violation above.

> **Related, narrower gap (2026-08-29):** `docs/SEMANTIC_KERNEL.md` §19
> identifies the same kind of missing mechanism one level down — not
> "which artifact set constitutes a released Sails version" (this
> paragraph's concern) but "which ruleset a single Interaction is bound
> to, and how a migration away from it is distinguished from silent
> reinterpretation." Tracked separately as Technical Debt items 34
> (this one) and 35.

### 6. The Protocol Remains Infrastructure-Neutral

No single blockchain, no single P2P transport, no single identity or
custody scheme, no single AI framework is privileged by the Core.
Bitcoin, Liquid, Lightning, EVM chains, Solana, and TON are equally valid
`SettlementProvider` implementations (§4B). Pears and any future P2P
transport are equally valid `TransportProvider` implementations (RFC-002).
Ed25519 keypairs and any future `Participant` implementation — a
multi-signature corporate account, a post-quantum scheme — are equally
valid (RFC-001). This invariant is what makes the other five durable for
the ten-year horizon `LONG_TERM_VISION.md` argues for: an invariant that
secretly privileged one chain, one transport, or one identity scheme would
not survive contact with year eight the way TCP/IP or Bitcoin's base
layer have.

---

## Level 1 — Behavioral Core Invariants

> Formally defined *(2026-08-25, Missão 11 Fase 9.3.3)*. These eleven
> laws were the CTO's own working framework across several
> architecture-review sessions ("Fase 9.0" onward), used in practice
> before ever being written down here in full. Each entry below states
> the rule, why it exists, which other invariant(s) it derives from or
> gets derived by, and — where one exists — the code/test evidence that
> it's real today, not aspirational. None of the eleven were found to
> be redundant with each other or with the six Structural invariants
> above: several have obvious overlap with an existing Operational
> Invariant (that overlap is the hierarchy working as intended — a
> Behavioral law with a real, already-shipped Operational child — not
> duplication), but no two of these eleven say the same thing about the
> same axis. Where enforcement is conditional on a feature flag, that
> is stated plainly, matching this document's own established
> convention (see the Operational Invariants section's own note on
> this).

### INV-01. Participant-Bound Authority

**RULE.** Every action that mutates protocol state on a participant's
behalf must trace to that specific participant's own verified
authorization — never to a bare claimed id, a coordinator's own
assumption, or a different participant's credential.

**WHY.** Without this, "non-custodial" is cosmetic: a coordinator that
can move state on a participant's behalf without their verified say-so
has effectively appointed itself a privileged party, the exact
custodial failure mode Structural Invariant 2 exists to rule out one
layer up (asset custody) — INV-01 is the same discipline applied to
*state*, not just assets.

**DERIVES / DERIVED BY.** Sibling of Structural Invariant 2 (assets)
and Structural Invariant 5 (an implementation that lets an Agent act
without a delegating Participant's authority is not a partial
implementation of Sails Protocol). Derived Operational Invariants:
`INV-OP-1` (no escrow mutation without a verified party), `INV-OP-6`
(every authenticated write requires a verified signature).

**EVIDENCE.** `common/middleware/auth.ts`'s `requireAuth()`;
`tests/escrowReleaseControls.test.ts`'s ownership/IDOR block (11 tests).

> **Newly-recognized non-conformant instance — Mission M8.5, 2026-08-30.**
> `dispute.service.ts`'s `resolveDispute()` accepts `releaseToAddress`/
> `refundToAddress` from the **arbiter's own** request and, via
> `escrow-lifecycle.ts`'s `resolvePayoutAddress()` ("an explicit address
> always wins"), lets that value unconditionally override the
> beneficiary's own registered `PayoutAddress` with no trace to the
> beneficiary's own verified authorization — a coordinator/discretionary-
> authority substituting its own assumption for a participant's, exactly
> what this invariant's own rule text already forbids. This is not a new
> rule; it is this already-frozen rule, correctly applied to a case not
> previously checked against it. `docs/DESTINATION_AUTHORITY_ARCHITECTURE.md`
> records the closing architecture (Economic Disposition Authority ≠
> Destination Authority); remediation is not yet implemented — see that
> document's own §16 for what remains before Mission M8-R.

### INV-02. Propose, Don't Impersonate

**RULE.** A coordinator, agent, or automated process may *propose* an
action for a participant to authorize — it may never itself produce a
signed/authorized action *as* that participant, nor fabricate the
appearance that a participant authorized something they did not.

**WHY.** This is the boundary between coordination (what Sails Protocol
is) and custody-by-another-name (what it explicitly refuses to be,
Structural Invariant 2/`PHILOSOPHY.md`'s "Why Coordination, Not
Custody"): a system that can *act as if* a participant approved
something, even for their own convenience, has reintroduced the exact
trust assumption non-custodial design exists to remove.

**DERIVES / DERIVED BY.** Distinct from INV-01: INV-01 asks "is the
actor who they claim to be," INV-02 asks "did the coordinator only ever
propose to them, never act as them" — a system can satisfy one and
violate the other (e.g., a correctly-identified coordinator that still
signs on a participant's behalf violates INV-02 while never touching
INV-01 at all). No Operational Invariant currently names this
explicitly, though `INV-OP-4` (fraud/risk detection never acts
unilaterally) is a specific instance of the same discipline applied to
automated risk signals specifically.

**EVIDENCE.** `escrow-lifecycle.ts`'s `isPartyOrAgent()` — the
`agent:{label}:{participantId}` shape is documented as originating only
from trusted internal callers proposing *for* a participant, never from
an HTTP body; `WalletAgent` (the one class that constructs such
strings) is not instantiated anywhere in `src/` today (independently
confirmed during the Kimi K3 R1 AUTH-01/CAP-02 reproduction).

### INV-03. No Privileged Wallet

**RULE.** No client implementation — including any Sails-authored
reference wallet, `sails-ui`, or the SDK's own examples — may receive
protocol data, a capability, or a construction shortcut that an
independently-written, conformant external wallet could not also
obtain through the same public interfaces.

**WHY.** A protocol whose own reference client has a private door is a
protocol that has quietly privileged one implementation, precisely what
Structural Invariant 6 (infrastructure-neutral) forbids — one level
more concrete: Structural Invariant 6 is about the Core never
privileging a *technology* (chain, transport, identity scheme); INV-03
is about the *server/API surface* never privileging a *client*.

**DERIVES / DERIVED BY.** Sibling of Structural Invariant 6, distinct
axis (technology-neutrality vs. client-neutrality). Feeds directly into
`INV-10` (verifiability is a product property is meaningless if only
one client can actually verify).

**EVIDENCE.** Missão 11 Fase 9.1.1: `sails-ui` uses
`verifyAndSignEscrowPsbt()` exactly as an external wallet would —
constructing its own expected-intent from public SDK/protocol data
only, never importing server internals; the same phase's own explicit
instruction to STOP rather than reach into server internals if the
public API doesn't expose enough (which is what led to the additive
`fundedAmount`/`txLockVout`/`minerFeeSats` SDK exposures, not a
back-door). Missão 11 Fase 9.3.1 independently re-confirmed zero
Satsails-only shortcut on the payment-account verification surface.

### INV-04. Verify Before State Transition

**RULE.** A state transition whose correctness depends on an external,
independently-observable fact (a UTXO's confirmation depth, a signed
attestation, a capability grant) must re-verify that fact — atomically,
against its own latest state, not a value read earlier in the same
request — immediately before committing the transition, not merely
before starting to process the request.

**WHY.** A check performed early and a mutation committed later are two
different points in time; anything can change state in between under
real concurrency. "We checked" is not the same claim as "we checked
atomically with the write" — the entire Missão 11 Fase 9.3 remediation
exists because this distinction was real, not academic (an escrow
transition could previously observe funding as trustworthy and commit
after a concurrent reorg-sweep had already invalidated it).

**DERIVES / DERIVED BY.** Closely related to `INV-05` (a transition
verified against stale historical meaning is really a violation of
both at once) and `INV-07` (the verification failing must lead to an
explicit, recoverable state, never a silent wrong answer). No
Operational Invariant names this directly yet — `INV-OP-1`/`INV-OP-2`
verify *who*; this is the sibling rule for verifying *what*.

**EVIDENCE.** `withEscrowFundingLock()` (`escrow-lifecycle.ts`,
Missão 11 Fase 9.3) — `pg_advisory_xact_lock`-serialized re-check
immediately before `markPaymentSent()`/`initiateRelease()`/
`initiateSplit()`'s actual write; `tests/integration/
escrowFundingConcurrency.test.ts` (9 adversarial tests, real Postgres).

### INV-05. Historical Meaning Is Immutable

**RULE.** A fact this protocol has recorded as having happened at a
given time — an event, an evidence observation, a ledger entry — is
never edited or deleted to reflect a later understanding. A change in
understanding is recorded as a *new* entry referencing the old one;
the old entry stands, permanently, as what was believed true at that
time.

**WHY.** Dispute resolution, audit, and independent verification all
depend on being able to reconstruct "what did the system know, and
when" — a system that can quietly rewrite its own past cannot be
trusted to arbitrate a disagreement about that past, which is most of
what a dispute *is*.

**DERIVES / DERIVED BY.** Foundational to `INV-07` (recovery from a
bad state requires a truthful record of how it got bad) and `INV-11`
(a reproducible decision requires a stable historical input to
reproduce it from). `INV-OP-8` (every durable event carries a
correlationId) is a precondition for this — an event with no
correlationId is not meaningfully part of any traceable history at
all.

**EVIDENCE.** `EscrowFundingEvidence`/`EscrowEvent`/`DurableEventRecord`
— all insert-only, no `update()`/`delete()` anywhere in their
repositories; `PostgresEventStore.publish()`'s hash-chained
`prevHash`/`entryHash`; `Timeline.verifyChain()`'s tamper-detection
tests (`tests/postgresEventStore.test.ts`,
`tests/escrowEventHashChain.test.ts`).

### INV-06. Exact Economic Conservation

**RULE.** For any settlement transaction, `sum(outputs) + fee ===
input`, exactly — no rounding tolerance, no floating-point
approximation, no unaccounted sat/wei. Every party's contractual
entitlement (buyer's share, seller's share, the protocol's fee) must
independently reconcile to its own precisely-computed value, never a
residual "whatever's left after the others."

**WHY.** "Approximately correct" is not a real property for money —
either the arithmetic is provably exact for every input, including
adversarially-chosen boundary values, or a real accounting bug is
merely unobserved yet, not absent.

**DERIVES / DERIVED BY.** `INV-OP-7` (Decimal, never Float) is
necessary but not sufficient for this — eliminating floating-point
drift removes one failure mode, it doesn't by itself prove the
allocation formula sums correctly at every boundary.

**EVIDENCE.** `tests/multisigFeeConservation.test.ts` (23 tests, a
"MANDATORY satoshi-conservation gate" per its own header) — proves the
identity holds exactly across a deliberately adversarial
precision/rounding/dust boundary matrix, for release, refund, and
split alike.

### INV-07. Explicit Failure & Recovery

**RULE.** When a protocol process cannot proceed with certainty, it
must fail into a named, well-defined state with an available recovery
path — never silently proceed on an assumption, and never leave a
party with no path forward at all. A recovery path may not itself be
blocked by the very uncertainty it exists to resolve.

**WHY.** The alternative to "explicit failure" is not "no failure," it
is "silent failure discovered later, usually by the party it harmed" —
and a recovery path that's gated on the same condition it's meant to
recover from is not a recovery path, it's a permanent-denial bug
wearing a recovery path's name.

**DERIVES / DERIVED BY.** The load-bearing precondition of `INV-04`:
a system that verifies before transitioning but has no honest failure
state for "verification failed" has only relocated the silent-failure
problem, not removed it. `INV-OP-1`/`INV-OP-2` (ownership/dual-approval
gates) and the reorg-sweep's own `REORGED_INVALIDATED`/`RECONFIRMED`
state machine are concrete instances.

**EVIDENCE.** `assertFundingNotUncertain()`'s own explicit exemption
list (refund, dispute-raising, `EXPIRED`, expiry-recovery are
deliberately NEVER gated by funding uncertainty — "blocking a
legitimate recovery path is exactly the permanent fund denial this
phase was explicitly told not to create"); independently reproduced
during Kimi K3 R1 (REORG-01/MULTI-03: the claimed "permanent fund
denial" did not survive reproduction precisely because this invariant
already held).

### INV-08. Capability-Bound Settlement

**RULE.** A fund-movement action (release, refund, split) requires the
triggering actor to hold an active `CapabilityGrant` covering that
exact action's scope. In a **production** process this is unconditional:
`NODE_ENV=production` refuses to boot unless `ENFORCE_CAPABILITIES` is
exactly `true` (Issue #303). Development, test and reference
environments may run with enforcement disabled, and there the invariant
is conditional, stated and not hidden.

**WHY.** *Amended 2026-09-21 (Issue #303).* The earlier text made
enforcement conditional even in production ("an explicit choice, true or
false") because capability onboarding was not ready. It is now: the SDK's
`capabilities.ensureCanonicalGrants()` (run by the reference UI on every
login) issues the canonical grants the gates consume, and only canonical
(capabilityName, scope) pairs can be registered. What the invariant
guarantees is that Capability Authority cannot be disabled in a
production-eligible deployment. What it does NOT claim: grants are
self-issued (`issuedBy = grantedTo`), so a CapabilityGrant is the
participant's own revocable, expiring, auditable consent - **not
independent third-party authorization**, and not a defense against an
already-authorized participant acting maliciously. Independent issuance is
a separate architectural evolution.

**EVIDENCE.** `checkFundMovementCapability()` (`escrow-lifecycle.ts`);
`config/index.ts`'s production boot guard (`FATAL: NODE_ENV=production
requires ENFORCE_CAPABILITIES=true`); `tests/configProductionGates.test.ts`;
`tests/fundMovementCapabilityCoverage.test.ts`;
`tests/capabilityCanonicalOnboarding.test.ts`;
`tests/integration/capabilityAuthorityEnforced.test.ts` (real Postgres +
Redis, enforcement on).

**DERIVES / DERIVED BY.** Sibling of `INV-01` (both gate *who* may
move funds) at a different granularity — INV-01 asks "are you a real,
verified party to this trade," INV-08 asks "does your role additionally
carry an explicit capability grant for this specific action."

**EVIDENCE.** `checkFundMovementCapability()` (`escrow-lifecycle.ts`);
`config/index.ts`'s production boot guard (`FATAL: NODE_ENV=production
but ENFORCE_CAPABILITIES is not set`); `tests/
fundMovementCapabilityCoverage.test.ts` (10 scenarios, both the
enforced and explicitly-unenforced paths).

### INV-09. Native Rail Semantics Must Be Preserved

**RULE.** A settlement rail's own cryptographic/economic meaning — what
a Bitcoin SIGHASH type actually commits to, what a Safe Transaction
Guard actually authorizes — must never be flattened into a
rail-agnostic abstraction that loses that meaning. Two independently
constructed representations of "the same" rail-native transaction must
be provably identical in every commitment-relevant respect, or the
abstraction has already silently lied about at least one of them.

**WHY.** A generic "signature" or "transaction" concept that hides
which sighash type was used, or whether a threshold check is real or
simulated, is exactly the kind of abstraction that looks correct in
every test until the one adversarial case the abstraction quietly
couldn't represent.

**DERIVES / DERIVED BY.** Distinct from `INV-11` (determinism):
a system can be perfectly deterministic while still flattening native
semantics (the same wrong abstraction, applied consistently, is still
wrong), and could in principle preserve native semantics without being
byte-reproducible. Both are required together; neither implies the
other.

**EVIDENCE.** Kimi K3 R1 MULTI-05 reproduction: `bitcoinjs-lib`'s own
`checkSighashTypeAllowed()` enforces the `[SIGHASH_ALL]` allowlist this
codebase's every `signInput()` call relies on (no call site passes an
override); asserted directly in `tests/multisigProvider.test.ts`
(the arbiter pre-signature's DER-encoded sighash byte, Missão 11 Fase
9.3 §7).

### INV-10. Verifiability Is a Product Property

**RULE.** Every normative fact this protocol asks a participant or
counterparty to rely on must be independently verifiable by them —
through public data, a published algorithm, and (for settlement-
critical facts) cryptographic evidence — never "true because the
coordinator's API said so."

**WHY.** A coordination protocol that cannot be independently verified
is a trust-the-operator protocol with extra steps; verifiability is
what makes "coordination, not custody" a real architectural property
instead of a marketing description of the same custodial trust model.

**DERIVES / DERIVED BY.** Requires `INV-03` (a verification path only
one privileged client can exercise is not a real verification path)
and `INV-09` (verifying a flattened, meaning-losing abstraction proves
nothing about the real rail-native transaction). Derived Operational
Invariant: `INV-OP-10`.

**EVIDENCE.** `multisigSigningIntent.ts`'s independent PSBT-intent
reconstruction (`sails-ui`); `Timeline.verifyChain()`; Missão 11 Fase
9.3.1's `PublicPaymentAccountView` (verify a trust property without
needing to trust an unverifiable claim about who attested it).

### INV-11. Deterministic Conformance

**RULE.** For a given, fully-specified input, a normative computation
(fee allocation, PSBT construction, capability evaluation) must always
produce the same output, from any conformant implementation — never a
result that depends on which server happened to run it, in what order,
or on non-normative incidental state.

**WHY.** Independent verification (`INV-10`) is only meaningful if the
thing being verified is actually reproducible — a "verify" step that
can legitimately disagree with the original computation for
non-adversarial reasons (implementation-specific rounding, hidden
mutable state) cannot distinguish a real discrepancy from noise.

**DERIVES / DERIVED BY.** Enables `INV-10` (verifiability presupposes
reproducibility) and, jointly with `INV-09`, motivates `INV-OP-9`
(exactly one normative construction algorithm per rail) — a second,
independently-written construction algorithm is the concrete failure
mode this invariant exists to prevent.

**EVIDENCE.** `INV-OP-9`'s own status section (below) documents exactly
how far this is currently real for MULTISIG (construction: single
implementation, no drift risk yet; verification: independent, proven);
`tests/multisigFeeConservation.test.ts`'s exact-conservation proof is
itself a determinism proof (the same formula, run against the same
input, always reconciles).

### INV-12. Attributed Authority Integrity

**RULE.** When the protocol attributes an economically consequential
disposition of value to the decision or authorization of a
discretionary authority, the resulting execution must correspond to an
authorization currently valid for it, and that correspondence must be
independently verifiable — never resting solely on the executor's own
unilateral assertion, nor on a check the executor alone controls. This
applies whether or not the authority is a Participant, whether or not
it is publicly named, and whether the value is already settled or
still locked/disputed pending that decision.

**WHY.** `INV-01` and `INV-02` protect a Participant's own authority
over their own state and assets. Neither reaches a distinct failure: a
coordinator that never impersonates anyone and never touches a
Participant's own funds can still be the sole judge of whether it
faithfully carried out a decision it attributes to someone else — an
arbiter, a delegated committee, an automated policy — with nothing
outside itself able to check. That gap is real regardless of whether
the decision-maker is given a public name, and regardless of whether
the value in question has already reached a final state or is still
locked pending exactly that decision — excluding the locked/disputed
case would exclude the paradigm case this invariant exists for.

**DERIVES / DERIVED BY.** Sibling of `INV-01` (Participant-Bound
Authority) and `INV-02` (Propose, Don't Impersonate) — not an extension
of either, since both are scoped to a Participant's own authority, and
the authority this invariant protects need not be a Participant at
all. Distinct from Structural Invariant 2: that invariant governs who
holds custody of an asset; this one governs whether an executed
disposition matches what was actually decided, independent of who
holds the key. A coordinator can satisfy Structural Invariant 2,
`INV-01`, and `INV-02` in full and still violate this invariant — the
decisive counter-model examined during Missão 12: a discretionary
authority's decision executed by a coordinator that alone controls
every record of what that decision actually was.

**NON-REQUIREMENTS.** Does not require the discretionary authority to
itself execute the disposition, to hold any rail-specific settlement
key, to be human, to be a single entity rather than a threshold or
joint authority, or to disclose its identity publicly. Does not
require any specific verification mechanism, cryptographic scheme, or
a mandatory second human, server, or public verifier — only that the
correspondence not rest on the executor's own say-so or on a check it
alone controls. Does not extend to mechanical execution choices (which
UTXO, which route, which fee, timing within an already-authorized
window) that leave the authorized disposition unchanged, and does not
attempt to solve compromised credentials, coerced authorities, or
forged signatures — those are failures of the authority or security
model a given rail relies on, not of this invariant, which assumes
that mechanism's own validity rules and asks only whether the
resulting execution can be tied to the authority the protocol
recognizes without trusting the executor's assertion alone.

**EXAMPLE PASS.** An arbiter rules on a disputed, still-locked escrow;
a distinct executor carries out the ruling using its own execution
capability; a party other than the executor can confirm, from evidence
the executor does not unilaterally control, that the execution matches
what the arbiter actually decided.

**EXAMPLE FAIL.** An executor derives and exercises, on its own, the
cryptographic capability attributed to an authority — named or not —
with no record of that authority's actual decision existing, or
checkable, outside the executor's own control.

**STATUS.** New as of this constitutional delta (Missão 12,
2026-08-29). No `EVIDENCE` section is claimed — unlike every invariant
above, no current reference-implementation code satisfies this rule
yet, and this document's own discipline (§"How Invariants Are
Enforced" below) is to never claim evidence that isn't real. Missão
12's conformance-impact findings identify exactly which current
behaviors this invariant newly classifies as non-conformant.

> **Corrigido/Implementado 2026-08-29 (Missão 13 Fase 2), MULTISIG
> scope only.** The paragraph above is now partially stale: real
> `EVIDENCE` exists for the MULTISIG rail's disputed-settlement path —
> `src/modules/open-settlement/arbitration-authority.ts` and
> `dispute.service.ts`'s `resolveDispute()` gate require and
> independently verify a signed authority decision before any
> settlement action, tested in `tests/arbitrationAuthority.test.ts`.
> LIGHTNING_HODL/SAFE_GUARD_EVM and QVAC-originated execution were
> explicitly out of scope for that pass (QVAC's own disputed-settlement
> path was correspondingly downgraded to advisory-only, since it has no
> verifiable authority to offer) and remain governed by this paragraph
> as originally written. `docs/SEMANTIC_KERNEL.md` §6 (K2, "Attributed
> Discretion") is this invariant's rail-independent, Kernel-level
> generalization — read that document for the identity-level statement
> this invariant expresses at current-protocol-version granularity.

---

## Level 2 — Derived Properties

> **Fresh catalog, 2026-08-25 (Missão 11 Fase 9.3.3) — not a
> reconstruction of "DP-01" through "DP-09."** As explained in
> "Canonical Hierarchy" above, those nine labels were cited in exactly
> three places in this codebase, three of them (DP-03/05/07) together,
> undifferentiated, for a single finding — never as nine individually
> defined properties. Rather than guess at definitions that were never
> written down, every property below is new, numbered fresh (`DP-1`
> onward, deliberately not continuing the old, unrecoverable sequence),
> and traceable to a real Core Invariant plus real shipped evidence. Not
> claimed to be exhaustive — new properties get the next free number,
> they don't get squeezed into a gap left by a number nobody can define.

**DP-1 — Escrow Funding Certainty Gates Value-Crediting Transitions
Only.** *(Derives from INV-04, INV-07.)* A transition that credits
value to a party (`markPaymentSent`, `initiateRelease`,
`initiateSplit`) must not commit while the escrow's funding evidence is
uncertain; a transition that merely *returns* value to whoever already
funded it (refund) or *investigates* a problem (dispute-raising) is
never gated by that same uncertainty. This is the specific property
that closes the substance previously cited, undifferentiated, as
"INV-07F, DP-03, DP-05, DP-07" — see `escrow-lifecycle.ts`'s
`assertFundingNotUncertain()` and Missão 11 Fase 9.3's
`withEscrowFundingLock()`.

**DP-2 — Evidence Is Append-Only.** *(Derives from INV-05.)* No
repository backing a historical fact (`EscrowFundingEvidence`,
`EscrowEvent`, `DurableEventRecord`) exposes an `update()` or
`delete()` method for an existing row. A later observation is always a
new row.

**DP-3 — Recovery Paths Are Never Gated By The Failure They Recover
From.** *(Derives from INV-07.)* Refund and dispute-raising remain
reachable regardless of any other subsystem's uncertainty or open
circuit-breaker state for that escrow (`escrow-circuit-breaker.ts`
scopes per-escrowId and auto-heals; funding uncertainty explicitly
exempts these two paths).

**DP-4 — Fund Movement Checks Capability Before Provider Invocation.**
*(Derives from INV-08.)* `checkFundMovementCapability()` runs before
any `SettlementProvider` call for release/refund/split, when
enforcement is active — never as an afterthought once funds have
already moved.

**DP-5 — One Server-Side Construction Path Per Settlement Rail.**
*(Derives from INV-09, INV-11.)* Formalized directly as `INV-OP-9`
below — included here as the Level-2 bridge between "native semantics
must survive" / "computation must be reproducible" (Level 1) and "here
is the one function that must be the only one" (Level 3).

**DP-6 — Minimum Necessary Disclosure On Public Verification
Surfaces.** *(Derives from INV-10, INV-01.)* A public read that exists
to verify a *property* discloses only what's needed to verify that
property — never participant identity, internal relational
identifiers, or unrelated historical metadata merely because they were
already in hand. Formalized directly as `INV-OP-10` below. This is the
property the Missão 11 Fase 9.3.1/9.3.2 payment-account privacy
finding closed.

**DP-7 — Coordinators Never Fabricate A Signed Action.** *(Derives
from INV-02.)* No code path constructs an `agent:`-shaped identity (or
equivalent) from client-supplied HTTP input; every such string
originates only from a trusted, internal, already-authorized caller
acting *for* a participant it has independently verified is delegating
to it.

**DP-8 — Every Conformant Client Reaches The Same Public Surface.**
*(Derives from INV-03, INV-10.)* No route, SDK method, or data field
exists that only a Sails-authored client can reach or interpret — the
same public interface (`docs/API_STABLE.md`) is what both `sails-ui`
and an independent third-party wallet integration call.

---

## Level 3 — Operational Invariants

> Added *(2026-07-19)*, relaying a CTO-role architectural review
> requesting invariants concrete enough for tests to check directly —
> "`INV-001: Funds MUST NEVER move before Settlement Locked`"-style
> rules. The six Constitutional Invariants above are about the
> protocol's *shape* (no custody, no fiat, infrastructure-neutral); these
> are about specific runtime behavior, each traceable to the RFC that
> decided it and the code that enforces it today. Where enforcement is
> conditional (a feature flag, off by default per this project's
> established precedent — `TODO.md`), that's stated, not hidden: an
> invariant that's real only when a flag is on is still worth stating
> precisely, but claiming it's unconditional when it isn't would be
> exactly the kind of gap this document exists to prevent.

### INV-OP-1. No Escrow Mutation Without a Verified Party

`lockFunds`/`markPaymentSent`/`releaseFunds`/`refundFunds`/
`openDispute` may only be triggered by the trade's actual buyer or
seller, or — for release/refund specifically — the dispute's assigned
arbiter. Unconditional, not feature-flagged: found missing and fixed in
a general gap audit (`TODO.md` §14), verified in
`tests/escrowReleaseControls.test.ts`'s ownership/IDOR block (11 tests).
Enforced in `open-settlement/escrow.service.ts`.

**Derives from:** `INV-01` (Participant-Bound Authority).

### INV-OP-2. Escrow Release Requires Two Independent Approvals, When Enabled

When `REQUIRE_DUAL_APPROVAL_RELEASE=true` (off by default —
`config.features.requireDualApprovalForRelease`), `releaseFunds()` on a
`PAYMENT_PENDING` escrow blocks unless `hasDualApproval()` counts two
*distinct* approvers. A `DISPUTED` escrow bypasses this — an arbiter's
ruling is itself the second, independent authorization. RFC-015.
Enforced in `open-settlement/escrow.service.ts`; see
`tests/escrowReleaseControls.test.ts`.

**Derives from:** `INV-01` (Participant-Bound Authority), `INV-08`
(Capability-Bound Settlement — a second independent approval is itself
an authorization gate on the fund-movement action).

### INV-OP-3. A Crypto-Native Agent Never Touches Fiat Rails

No QVAC Agent code path (`BuyerAgent`, `SellerAgent`,
`qvac-agent.provider.ts`) ever calls a banking API, processes PIX/ACH/
SEPA/Wire/UPI, or holds fiat balance state. This is structural, not
feature-flagged — no fiat integration exists anywhere in the Agent's
reachable code, by construction. Fiat settles directly between
participants, outside the protocol entirely (Constitutional Invariant
3). RFC-016.

**Derives from:** Level 1 — Structural Invariant 3 (Fiat Always
Settles Outside the Protocol).

### INV-OP-4. Fraud/Risk Detection Never Acts Unilaterally

`SocialEngineeringAgent.evaluate()` (when
`SOCIAL_ENGINEERING_DETECTION=true`, off by default) may only ever
produce a `RiskSignal` that results in a human-facing `RISK_WARNING`
broadcast. It never blocks, delays, cancels, or alters a trade, chat
message, or escrow state — detection and enforcement are strictly
separate code paths, with no call from the former into the latter. RFC-
017 D7. Enforced by `open-agents/social-engineering-agent.ts`'s own
return type (`RiskSignal | null`, never a mutation) and
`chat.routes.ts`'s handler, which only ever calls
`broadcastToTrade(..., { type: 'RISK_WARNING', ... })`.

**Derives from:** `INV-02` (Propose, Don't Impersonate — detection
proposing a signal to a human is fine, detection unilaterally acting is
the same overreach INV-02 forbids in a coordinator generally).

### INV-OP-5. Reputation Score Changes Through Exactly One Entrypoint

`User.reputationScore` is mutated only by `recordOutcome()` /
`recordOutcomeOnce()` (`open-reputation/reputation.service.ts`; the latter is
the event-driven form, applied at most once per durable event and
participant — INV-OP-12), itself triggered only by
`settlement.escrow.released`/`refunded` events. A chat message, an
Agent action, a QVAC risk signal, or `rate()` (informational only, by
its own header comment) can never move the score. RFC-007 D8.

**Derives from:** `INV-04` (Verify Before State Transition — a single,
event-gated entrypoint is what makes the mutation itself checkable
against exactly one precondition, rather than N independently-trusted
call sites).

### INV-OP-6. Every Authenticated Write Requires a Verified Signature

No route derives `participantId` from a client-supplied body field.
Every write-side route requires `requireAuth()`, which only ever sets
`req.participantId` from a session token issued after a real Ed25519
challenge-response verification (`CRYPTOGRAPHIC_MODEL.md` §2) — never
from a bare claimed id. Originally the RT-002 fix for one route family;
generalized and re-verified across the codebase in the same gap audit
as INV-OP-1 (`TODO.md` §14). Enforced by `common/middleware/auth.ts`.

**Derives from:** `INV-01` (Participant-Bound Authority).

### INV-OP-7. Financial Amounts Are Always `Decimal`, Never `Float`

Every schema field representing money or on-chain value
(`Offer.priceUsd`, `Escrow.lockedAmount`, `User.totalVolumeBtc`, etc.)
is a Prisma `Decimal`, end to end — no `Float`/`Number` financial field
exists anywhere in `prisma/schema.prisma`, and no computation path
converts a `Decimal` to a JS `number` before a value comparison or
persistence write. RFC-009 (floating-point rounding is a real-money
correctness bug class, not a style preference).

**Derives from:** `INV-06` (Exact Economic Conservation — necessary,
not sufficient, precondition).

### INV-OP-8. Every Durable Event Carries a `correlationId`

`EventStore.publish()` (RFC-010) refuses an event with no
`correlationId` — there is no code path that persists a durable event
untraceable back to the Intent, Trade, or userId it belongs to. This is
what makes `Timeline`/`getEvents(correlationId)`
(`CRYPTOGRAPHIC_MODEL.md` §4.2) and `SocialEngineeringAgent`'s
conversational context possible at all — an event with no correlation
id would be structurally invisible to both.

**Derives from:** `INV-05` (Historical Meaning Is Immutable — an event
untraceable to what it belongs to is not meaningfully part of any
verifiable history at all).

### INV-OP-9. Settlement-Transaction Construction Has Exactly One Normative Algorithm Per Rail

**Recorded as an architectural requirement — Missão 11, Fase 9.1 §8 /
Fase 9.1.1 §5, 2026-08-24. Decision record, not yet fully implemented —
see status below.** For any rail where both the server and an external
participant (an SDK-based wallet, or this repo's own `sails-ui`
reference client) might independently construct or verify a
settlement-critical transaction, there must be exactly one normative,
deterministic construction algorithm — never two independently-written
implementations that happen to agree today and could silently drift
tomorrow. Verification is exempt from this rule (independent, adversarial
re-derivation is the whole point of `verifySigningIntent()`/
`verifyAndSignEscrowPsbt()`); *construction* of the actual unsigned
transaction is not.

**Current status for MULTISIG (the only rail with a working
independent-verification story today):** partially conforming, by
scope choice rather than oversight. Server-side construction
(`multisig.provider.ts`'s `buildUnsignedRelease/Refund/Split()`) is the
sole real implementation — no second, SDK-side construction algorithm
exists, so there is no live drift risk today. `packages/sails-ui`'s own
independent verification (`multisigSigningIntent.ts`, Fase 9.1.1 §3)
deliberately does NOT duplicate the server's construction logic for the
RELEASE/REFUND cases it supports — it reuses the server-shared primitive
(`buildExpectedFeeAwareReleaseOutputs()`) for the one piece of
non-trivial arithmetic (fee-aware output splitting) rather than
reimplementing it, and it explicitly REFUSES to attempt independent
verification of SPLIT (whose construction — proportional `buyerBps`
division plus a three-way fee leg — is complex enough that an
independent reimplementation would itself risk becoming the second,
drifting algorithm this invariant exists to prevent).

**What remains genuinely open, not solved by the above:** full
independent *construction* of an unsigned MULTISIG PSBT from raw
inputs (UTXO selection, live fee-rate estimation, dust policy,
arbiter-key handling) — as opposed to verification of a server-proposed
one — has no shared primitive yet; today only the server can build one.
A future pass extending genuine wallet-side construction (not just
verification) MUST factor the deterministic, network-I/O-free parts of
`buildUnsignedRelease/Refund/Split()` into a shared primitive both the
server and `@satsails/p2p-trading-sdk` call — never two independently
maintained implementations of the same construction rules. No such
primitive is built by this pass; this invariant exists so a future
Gen-1 extension or Gen-2 design cannot accidentally reintroduce a second
algorithm without at least having to consciously violate a named,
numbered invariant to do it.

**Derives from:** `INV-09` (Native Rail Semantics Must Be Preserved),
`INV-11` (Deterministic Conformance). Level 2: `DP-5`.

### INV-OP-10. Public Verification Surfaces Disclose the Minimum Necessary Fact, Never the Underlying Row

**Recorded — Missão 11, Fase 9.3.2, 2026-08-25.** A protocol surface (an
HTTP response, an SDK return type, an event payload) MUST disclose only
the information the *receiving actor* needs to independently verify the
normative fact in question or to carry out an authorized protocol
action — never the full internal persistence record merely because that
record was already in hand. Concretely: participant identity, internal
relational identifiers, and historical/administrative metadata MUST NOT
appear on a surface whose stated purpose is verifying a *property*
(has this been seen before, is it signed, what tier does it carry) —
"I have the row" is not a reason to return the row. This does not
prohibit disclosure that is *itself* the normative fact (e.g., that an
`accountHash` exists at all is the entire point of an age-witness
check — see below), nor does it prohibit an authenticated, self-
referential response (a caller reading back data about themselves,
e.g. `register()`/`sign()`'s own response to the party who just acted).
Compliance/legal disclosure remains possible where a *separate*,
explicitly authorized channel defines it — this invariant constrains
the *default*, unauthorized-by-default public surface, not a
deliberately provisioned regulatory hook.

**Closes a real gap, not a hypothetical one.** `GET /v1/settlement/
payment-accounts/:accountHash` (RFC-021 D5) returned the raw
`PaymentAccount` row — including `ownerId`/`signedBy` (platform User
ids) — to any caller who could compute or guess the hash, deanonymizing
which identity owns a real-world payment rail. No invariant in this
document, before this one, actually prohibited that: INV-OP-1/6 govern
*mutation* authorization, not *read*-side field minimization. Fixed by
introducing `PublicPaymentAccountView`
(`payment-account.service.ts`) — a real projection type, not the
Prisma row — returning only `accountHash`/`paymentMethod`/`signed`/
`signedAt`/`firstUsedAt`/`completedTrades`/`chargebacks`/`tradeLimit`.
See `SECURITY_MODEL.md` §4.7 for the full worked example and
`tests/paymentAccountService.test.ts`/`tests/routes.test.ts` for the
mechanical proof (field-presence assertions at both the service and
HTTP layers).

**Existing-surface conformance sweep — Missão 11 Fase 9.3.4, 2026-08-25.**
Two other current public reads were checked against this invariant,
by tracing the actual service code (not inferring from the Prisma
schema alone — Fase 9.3.2's own guess that `GET /v1/settlement/
arbitration/profile/:participantId` had a gap was wrong for exactly
this reason, corrected here):

- `GET /v1/settlement/arbitration/profile/:participantId` —
  **already conformant, no change needed.**
  `MarketArbitrationProvider.getProfile()` has, since before this
  invariant existed, returned `toCandidate(profile)` — a real,
  purpose-built projection (`participantId`, `monetaryCollateral`,
  `collateralAsset`, `arbiterReputation`, `effectiveStake`,
  `cumulativeFeesObserved`) — never the raw `ArbiterProfile` row. No
  `id`/`moduleId`/`protocolVersion`/`updatedAt`/`registeredAt`/
  `slashedAt`/`rulingsTotal`/`rulingsOverturned` has ever been exposed
  here.
- `GET /v1/settlement/payout-addresses/:participantId/:asset` —
  **real gap, fixed.** `PayoutAddressService.getPayoutAddress()`
  returned the raw `PayoutAddress` row. Fixed by introducing
  `getPublicView()`/`PublicPayoutAddressView`
  (`payout-address.service.ts`) — `participantId`/`asset`/`address`
  only; `id`/`moduleId`/`protocolVersion`/`createdAt`/`updatedAt`
  excluded. `address` is the normative settlement fact itself (the
  committed payout destination `escrow.service.ts`'s
  `resolvePayoutAddress()` falls back to) and is preserved in full —
  this is a minimization fix, not an obfuscation of what the route
  exists to disclose. See `tests/payoutAddress.test.ts`/
  `tests/routes.test.ts` for the mechanical proof.

A third surface, `GET /v1/identity/participants/:id`
(`identityService.getParticipant()` → raw `User` row), was found
during the same sweep to also return operator-internal bookkeeping
(`moduleId`/`protocolVersion`) it doesn't need. **Not fixed in Fase
9.3.4** — flagged as a separate, larger item requiring more careful
field-by-field analysis than that bounded sweep's scope.

**Closed — Missão 11 Fase 9.3.5, 2026-08-25.** The CTO declined to
freeze the constitution with a known, locally-remediable violation
still open. Full analysis performed: `publicKey`/`peerId`/`displayName`
are Category A (the route's literal stated purpose — confirming which
cryptographic/transport identity corresponds to a participant id, so a
counterparty can verify a signature or open a P2P connection);
`verified` is a distinct identity-verification-status fact, also kept.
`reputationScore`/`totalTrades`/`disputeCount`/`totalVolumeBtc` are
excluded — not because they're private (they're legitimately public),
but because three of the four already have their own canonical,
dedicated public surface (`GET /v1/reputation/:participantId` →
`reputationService.getScore()`) and duplicating them here would be
scope creep for an identity-lookup endpoint, not a disclosure decision.
`totalVolumeBtc` does **not** currently have an equivalent public
surface — `ReputationScore` carries `cumulativeFeesObserved` (a fee
total), not a BTC-volume figure — so this field is now simply not
exposed publicly anywhere; disclosed here rather than silently assumed
covered elsewhere (a mistake this document has already made once for
the arbitration-profile surface — see the sweep note above). Fixed by
introducing `getPublicView()`/`PublicParticipantIdentity`
(`identity.service.ts`) — `id`/`publicKey`/`displayName`/`peerId`/
`verified` only; `moduleId`/`protocolVersion`/`createdAt`/`updatedAt`
and all four reputation-adjacent fields excluded. `GET /v1/identity/me`
(authenticated, self-referential) is unaffected — it correctly stays
the full raw row, the same self-referential exception this invariant's
own text already carves out for `register()`/`sign()`. The SDK's
`identity.get()` return type narrowed from `Participant` to a new
`PublicParticipant` accordingly (a PRE-LAUNCH BREAKING API CORRECTION —
SDK stays `0.1.3`, unpublished); the one real internal consumer
(`packages/sails-ui/src/pages/Trade.tsx`'s buyer/seller card) was
updated to source reputation stats from `reputation.get()` instead,
its actual canonical home. See `SECURITY_MODEL.md` §4.7 for the worked
example and `tests/identityService.test.ts`/`tests/routes.test.ts` for
the mechanical proof (field-absence assertions at both the service and
HTTP layers). This closes the last known INV-OP-10 violation identified
across the Fase 9.3.2/9.3.4 conformance sweeps of this document's
existing public surfaces.

**Closed a second, distinct violation — Missão 11 Fase 9.6, 2026-08-25.**
An independent adversarial red-team (Kimi K3 R2) targeting the payment-
account surface's fixed GET route found nothing new there — but tracing
its own claim ("hash collision → ownership transfer," refuted: SHA-256
collision is not what a shared accountHash actually requires, and
`getOrCreate()` never mutates `ownerId`) surfaced a real, previously-
unswept sibling gap: `POST /v1/settlement/payment-accounts` and
`POST /v1/settlement/payment-accounts/:accountHash/sign`
(`settlement.routes.ts`) both echoed `getOrCreate()`'s/
`signPaymentAccount()`'s raw return value verbatim — full row,
`ownerId`/`signedBy` included — whenever the caller was NOT the
account's owner (an arbiter/peer attesting someone else's account via
`/sign`, or any authenticated caller supplying a counterparty's real
`accountHash` via the POST create route). The Fase 9.3.1 sweep only
reached the sibling GET route. Fixed the same way: `PaymentAccountService.toPublicView()`
(the projection half of `getPublicView()`, split out so a caller that
already has the row in hand doesn't need a second fetch) is now applied
whenever `account.ownerId !== caller` on both POST routes — a
self-referential response (a brand-new registration, or an owner
re-submitting their own hash) stays full, exactly the same exception
this invariant's own text already carves out.

**Executable conformance principle this invariant establishes:**
*public verification surface != internal persistence model.* Wherever a
route or SDK method exists to let an external party verify a claim
about protocol state, its response type should be an explicit,
named projection — never `{ ...prismaRow }` — and a test should assert
the negative (the private fields are ABSENT), not just the positive
(the public fields are present). A positive-only test cannot catch a
future column added to the underlying model leaking through
unnoticed; asserting the exact key set does.

> **Corrigido/Implementado 2026-08-25 (Missão 11 Fase 9.3.3).** This
> note originally (Fase 9.3.2) flagged an open reconciliation question
> and guessed a tentative "DP-10" label. The reconciliation is now
> done — see "Canonical Hierarchy" near the top of this document.
> **Derives from:** `INV-10` (Verifiability Is a Product Property),
> `INV-01` (Participant-Bound Authority). Level 2: `DP-6` (not DP-10 —
> the guess in the superseded version of this note was wrong; the fresh
> Level 2 catalog numbers from `DP-1`, it does not continue any old
> sequence).

---

### INV-OP-11. Settlement Crash-Recovery Converges to Externally-Observable Truth, Never a Blind Replay

**Derives from:** `INV-07` (Explicit Failure & Recovery — Core, Structural)
and `INV-06` (Exact Economic Conservation — Core, Behavioral). This is a
Level 3 codification of an existing Level 1 law, not a new one: INV-07
already requires that "a recovery path may not itself be blocked by the
very uncertainty it exists to resolve," and already implies its
converse — a recovery path must not itself *create* new uncertainty by
guessing. No counterexample was found that INV-07/INV-06 together fail
to cover; **no new Core Invariant was introduced for this finding.**

**Recorded — Missão 11 Fase 9.6, 2026-08-25.** Closes CONC-03 (Kimi K3
R2, CONFIRMED/P1 in Fase 9.5's independent triage): `escrow.service.ts`'s
`releaseFunds()`/`refundFunds()`/`splitFunds()` and `escrow-pending-tx.ts`'s
`submitTransactionSignature()` all `claimEscrowTransition()` a TERMINAL
escrow status (`COMPLETED`/`REFUNDED`/`SPLIT` — `VALID_TRANSITIONS`'s
own empty terminal set) *before* calling the real settlement provider, and
persist `txReleaseId` only *after* it returns. A hard process crash
(container eviction, OOM-kill — never a catchable JS exception, those
were already handled) landing in that window leaves an escrow claiming
a terminal outcome with no `txReleaseId` and, critically, no way for
the process that resumes to know whether the real fund movement
actually happened before it died.

**The rule this invariant states:** a crash-recovery mechanism for a
settlement-critical operation MUST NOT assume either "it definitely
happened" or "it definitely didn't" — it must ask an authoritative,
externally-observable source of truth, and MUST NOT re-execute an
action whose real-world effect it cannot first rule out having already
occurred. Where no such authoritative source exists for a given rail,
recovery MUST fail closed (flag for manual review) rather than guess in
either direction — a stuck-but-safe state is always preferable to a
guessed, possibly-duplicate one.

**How this is met today — MULTISIG only.** `escrow-settlement-reconciliation.service.ts`'s
`reconcilePendingSettlements()` finds every terminal-status escrow with
a null `txReleaseId`. For MULTISIG (the only rail whose settlement
transaction is fully deterministic and reconstructable from already-
persisted, already-collected data — the unsigned PSBT plus every
required signer's already-submitted signed copy, both durable well
before finalization ever runs), `multisig.provider.ts`'s
`reconcilePendingSettlement()` deterministically rebuilds the exact
transaction a crashed attempt would have produced (same combine/
finalize logic `finalizeSpend()` itself uses — one shared implementation,
not a second one that could drift, the same discipline ECON-04's
investigation confirmed this codebase already applies to fee-basis
math) and asks Bitcoin itself: does a transaction with this exact txid
already exist on the network? If yes, local state converges to that
observed truth with **no new broadcast**. If no, it checks whether the
funding outpoint is still unspent; only then does it broadcast — the
one and only real settlement action this escrow's signatures could ever
produce, never a second, independently-constructed one. If the outpoint
is spent by something that isn't this reconstructed transaction, that
is a genuine anomaly (structurally should be impossible, given a single
2-of-3 script and this escrow's own already-collected signatures) —
reconciliation fails closed and reports it, moving no funds.

**Deliberately narrow.** No other rail in this codebase has an
equivalent authoritative-truth primitive today. MOCK/WDK_USDT_EVM move
funds via a direct, single-call path with no persisted, independently-
reconstructable transaction to compare against; LIGHTNING_HODL/
SAFE_GUARD_EVM are structurally signature-collection rails like
MULTISIG but have never had this primitive built for them (out of
scope for this phase — see `docs/TECHNICAL_DEBT_AUDIT.md`). For any
escrow this mechanism cannot safely reconcile, it does exactly what
this invariant requires: fails closed, flagged for manual review,
moving no funds. See `tests/multisigProvider.test.ts`'s
`reconcilePendingSettlement()` suite (real signed PSBTs, real fetch-mocked
network responses — the "expected txid" every test asserts against is
independently computed, never asserted by fiat) and
`tests/escrowSettlementReconciliation.test.ts` for the mechanical proof,
including the fail-closed paths and the "a concurrent reconciliation run
already converged this escrow" race guard.

**Extended — Missão 11 Fase 9.7, 2026-08-25 (C5 closure).** Fase 9.6's
own report explicitly disclosed a narrower, distinct gap it had found
but not closed: a crash landing AFTER `txReleaseId` is durably
persisted but BEFORE `emitEscrowTransition()` completes leaves the
DOWNSTREAM completion effects (fee obligation, `Trade.status`,
reputation, volume, the `settlement.escrow.*` event) silently missing —
not duplicated, missing. This is a genuinely different failure mode
from the on-chain-truth question above (by this point the real fund
movement is already a confirmed fact — no further truth-seeking is
needed for ANY rail, not just MULTISIG), so this invariant's own text
is extended here rather than minting a new one: **a settlement's
downstream completion effects must apply to exactly one logically
consistent outcome per real settlement, with safe catch-up when
missing — never a blind guess in either direction, the same rule this
invariant already states for the fund movement itself.**

**Root cause, audited directly (Fase 9.7), not assumed.** Several of
these downstream effects have no idempotency key of their own:
`recordTradeCompletion()`'s `totalTrades`/`totalVolumeBtc` increments
and `reputationService.recordOutcome()`'s `reputationScore` increment
(`common/events/handlers.ts`) are raw `{ increment: n }` writes — a
naive re-run would double-count them. **Refuted as a safe reuse:**
`Trade.completedAt`/`cancelledAt` were investigated as a possible
existing-field idempotency claim and found UNSAFE for the refund side
specifically — `trade.service.ts`'s own manually-triggered
`updateStatus()` (a participant cancelling an ACTIVE trade directly,
unrelated to escrow settlement) can ALSO set `cancelledAt`, so treating
it as "has this trade's settlement-completion already run" would
wrongly skip a real, later escrow refund's own reputation/vouch effects
for a trade someone had separately, earlier, manually cancelled.

**The actual fix — `emitEscrowTransition()` itself (`escrow-lifecycle.ts`)
is now the single, atomic idempotency claim**, keyed on `(escrowId,
toStatus)` — a pair `VALID_TRANSITIONS`' own state graph never revisits
for a real escrow (every status is reachable at most once per escrow's
lifetime), verified directly, not assumed. The claim (does an
`EscrowEvent` for this exact transition already exist?) and the
row-creation that answers it for the next caller both happen inside the
SAME `withEscrowFundingLock()` advisory-lock transaction already used
elsewhere in this file; `eventBus.emit()` itself — and everything it
cascades into — only ever runs for the ONE caller that wins the claim.
This protects EVERY caller in the codebase (the normal completion
paths, already independently protected against a concurrent duplicate
by `claimEscrowTransition()`'s own status gate, AND the reconciliation
catch-up path below, which has no such independent protection of its
own) with one shared mechanism, not two independently-maintained ones.

`escrow-settlement-reconciliation.service.ts`'s second pass
(`reconcileMissingCompletionEffects()`) finds every terminal escrow with
`txReleaseId` already set, and — for ANY rail, not just MULTISIG, since
no further truth-seeking is needed once the fund movement is already
confirmed — re-runs the same downstream-effects sequence the normal
path uses, safely, because `emitEscrowTransition()`'s own claim is what
actually prevents a double-fire, not this pass's own (merely advisory)
peek. One genuine, disclosed limitation: a direct-call-rail (MOCK/
WDK_USDT_EVM) SPLIT with no surviving `EscrowPendingTransaction` row
cannot recover its `buyerBps` (never persisted anywhere durable on that
path) — fee-obligation recording is explicitly SKIPPED and flagged for
manual review in that one case, never guessed. See
`tests/escrowSettlementReconciliation.test.ts`'s "Fase 9.7" describe
blocks and the dedicated `emitEscrowTransition()` idempotency tests in
that same file for the mechanical proof.

**Adjacent, not overlapping:** `INV-OP-5` (Reputation Score Changes
Through Exactly One Entrypoint) states WHICH code path may mutate
`reputationScore` — a structural property. This invariant's own C5
extension states how many times that ONE entrypoint may actually fire
per real settlement — an execution-count property. INV-OP-5 alone does
not, and was never meant to, guard against its own single entrypoint
being invoked twice for the same event; that gap is what this
extension closes.

**No new Core Invariant.** Same derivation as above (`INV-07` + `INV-06`
— read broadly enough to cover the protocol's own volume/reputation
ledgers as part of "exact economic conservation," not narrowly as
"Bitcoin sats only"), no new one introduced. No genuine counterexample
was found that INV-07/INV-06 together fail to represent.

### INV-OP-12. Three Identities Stay Separate: Current Authority ≠ Replay Identity ≠ Provider Evidence

*(Issues #291 / #294 / #298 — added 2026-09-21.)*

Once an economic operation has crossed its authoritative commit
boundary, every retry, recovery and projection must reproduce that same
result, and neither a stale authority nor a duplicate delivery may
manufacture a different economic truth. Three independent proofs, none
of which substitutes for another:

- **Current Authority** — is this actor/action authorized to perform the
  operation *now*? (Capability Authority / ADR-004, Economic Disposition
  Authority / ADR-005, Destination Authority, signatures, ruling
  generation.)
- **Replay Identity** — is this retry the exact same immutable Sails
  operation that already crossed the commit boundary? (The durable
  pending operation id / operation digest / execution attempt.)
- **Provider Evidence** — what did the external network actually do?
  (`Escrow.txReleaseId`: Bitcoin txid, `arkTxid`, Safe `userOpHash`, WDK
  `txHash`.) Evidence, never the Sails operation identity.

What the implementation guarantees:

1. **Settlement result is write-once** (`persistSettlementResult()`,
   `escrow-repository.ts`). `null → A` writes; `A → A` is an idempotent
   no-op that preserves the original `releasedAt`; `A → B` is a
   `SettlementResultConflictError` — never overwritten, never silently
   ignored — for every writer (direct release/refund/split,
   signature-collection, C8, PASS 1). The database backstops it
   (`escrows_settlement_result_write_once_guard`): a direct `UPDATE`
   cannot change a populated `txReleaseId` or `releasedAt`.
2. **External success is never reverted as a local failure.** Only a
   failing provider call reverts the claimed status; once the provider
   has returned, a failing local step leaves the escrow in its claimed
   state and reconciliation converges it from durable facts.
3. **Escrow is authoritative; Trade is a projection.** The Trade status
   is derived from the *persisted* Escrow state under the escrow lock,
   monotonically (a stale/reordered event cannot regress it), with
   `completedAt`/`cancelledAt` write-once. A manual Trade transition is
   CAS-guarded and refused once the Escrow governs the outcome.
4. **Event delivery is idempotent per projection.** Each downstream
   effect (Trade projection, trade counters, reputation outcome, vouch
   burn, notifications) is applied at most once per
   `(durable eventId, projectionKey, subjectId)` — claim and mutation in
   one transaction (`event_projection_claims`) — so N deliveries by N
   instances produce one effect.
5. **Claim ≠ publish ≠ projection.** The escrow transition claim, the
   durable event and the completed projections are three separate facts
   (`transition.claimed` / `durable_events` / `transition.projected`).
   Reconciliation PASS 3 finds a claimed-but-unprojected transition and
   re-publishes (no durable event yet) or redelivers (event exists) the
   canonical event; idempotent projections make that harmless.

**Not claimed:** LIGHTNING_HODL / SAFE_GUARD_EVM provider-specific
UNKNOWN-outcome and restart semantics (tracked separately); no unique
`(escrowId, toStatus)` constraint (repeated legitimate transitions under
appeal/reopening are not ruled out).

**Derives from:** `INV-07` (Explicit Failure & Recovery), `INV-05`
(Historical Meaning Is Immutable), `INV-OP-11`.

---

## How Invariants Are Enforced

Unlike Principles (which guide judgment) and Philosophy (which explains
reasoning), Invariants should be checked mechanically wherever possible:

- **RFC Review** (`GOVERNANCE.md` §5): every RFC's "Principle Alignment"
  section should also state, explicitly, that it does not violate any
  invariant above — silence on this is not sufficient once Implementation
  Freeze begins.
- **Code review, once Implementation Freeze starts:** the discipline the
  CTO specified — every new module or API references the RFC that defines
  its behavior — makes Invariant violations checkable at review time, not
  just at design time. A pull request implementing settlement logic that
  doesn't cite `SettlementProvider`'s interface, or that adds a
  Sails-operated custody path, is checkable against Invariant 1 and 2
  mechanically, not just by judgment call.
- **A violation found after the fact is not "documented as an
  exception."** Per the definition above, a violation means the resulting
  system is not Sails Protocol — the fix is to remove the violation, not
  to add a caveat to this document.

---

## Conformance Is Not "Tests Pass"

**Added 2026-08-25, Missão 11 Fase 9.3.3.** A feature is not
protocol-conformant merely because its own test suite is green. Tests
prove the feature does what its author intended; they don't by
themselves prove that intention was the right one under this
constitution. A feature earns "conformant" only once it satisfies, in
order:

1. **Every applicable Level 1 Core Invariant** (Structural and
   Behavioral alike) — does the feature's *design* violate a law that
   can never be broken, regardless of how well the code implementing
   that design is tested?
2. **Every Level 2 Derived Property those invariants require** — does
   the feature actually deliver the concrete consequence the Core law
   demands, not just something that sounds compatible with it?
3. **Every applicable Level 3 Operational Invariant** — does the
   feature's *code* match the specific, already-agreed implementation
   obligation (which route requires auth, which field a public
   projection may carry, which algorithm is the one normative
   construction path)?
4. **Executable evidence, wherever the property is mechanically
   testable** — a claim of conformance for anything Level 3 (and most
   of Level 2) that isn't backed by a real, checked-in test is a claim,
   not a proof. Where a property genuinely can't be mechanically tested
   (most Level 1 laws are architectural, not runtime-checkable), review
   against this document's own text is the enforcement mechanism (see
   "How Invariants Are Enforced" above) — that's a deliberate exception
   for the untestable tier, not a loophole for the testable one.

This governance rule does not itself add a new numbered invariant — it
states how the existing three levels are meant to be used together
when someone (human or AI reviewer) is asked "is this conformant."
