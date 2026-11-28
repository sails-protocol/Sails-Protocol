# SEMANTIC_KERNEL.md
### Sails Protocol — Engineering Handoff · Semantic Kernel Baseline

> Read `PROJECT_CONTEXT.md` first if you haven't. This document assumes
> familiarity with `PROTOCOL_INVARIANTS.md` (the Constitution) and
> `PROTOCOL_SPECIFICATION.md` (the primitive-level spec). It answers a
> narrower, more fundamental question than either: not "what does this
> protocol version require," but "what must remain true for something to
> be Sails at all."

---

## 1. Purpose

Every prior architecture document in this repository describes Sails
*as built* — its modules, its invariants, its current primitives. None
of them separately answers a smaller, harder question: which of those
properties are the protocol's actual identity, and which are policy,
security hardening, or implementation convenience that a differently-built
but still-recognizable Sails could lack?

This document records the answer, reached through a closed, adversarial
process (§18): a **Semantic Kernel** of exactly three properties. It
exists so that future architecture — a Sails Core software layer, a new
settlement rail, an independent reimplementation — has something stable
to conform to that does not depend on today's module boundaries, database
schema, or choice of settlement rail.

## 2. Status

**Frozen baseline, not immutable forever.** The three properties below
(K1–K3) and the supporting Assertion rule are canonical as of this
document's own commit. Future evidence may justify revision, but only
through an explicit, versioned **Semantic Kernel Revision** process — not
by silent reinterpretation during implementation work. If a future
architecture decision seems to require reading K1–K3 differently than
written, that is a signal to open a revision, not to proceed on a private
interpretation.

**Current-state correction (2026-09-16):** this document was frozen before
the Sails Core Implementation Program created an implementation package.
The internal/private workspace `packages/sails-core/` now exists as the
TypeScript implementation surface for the **Pure Semantic Core** boundary,
and selected Runtime slices now invoke Core-authoritative semantics. This
changes implementation timing, not the Semantic Kernel. **Semantic Kernel
≠ package**: K1/K2/K3 and the Assertion rule remain the semantic identity;
`@sails/core` is one implementation of the Pure Core boundary derived from
that identity. Runtime, Modules, Providers, persistence/orchestration, and
application adapters remain outside `@sails/core`, the full legacy system
has not migrated, and no public npm `@sails/core` package is authorized by
this correction.

## 3. What the Semantic Kernel Is

The minimum set of properties that must hold for an economic interaction
governed by Sails to actually be governed by Sails — independent of
settlement rail, transport, database, UI, or AI framework. It answers:
*what must remain true for Sails to remain Sails?*

## 4. What It Is Not

- Not a data model, package, or class hierarchy.
- Not `@sails/core`. At freeze time no such package existed and this
  document did not authorize package creation; a later authorized
  implementation program created the internal/private package. That later
  implementation does not turn the Semantic Kernel itself into a package.
- Not the current module set (`OpenP2P`/`OpenSettlement`/`OpenIdentity`/
  `OpenProof`/`OpenReputation`/`OpenAgents`/`OpenLiquidity`) — those are
  one reference implementation's organization of responsibilities, not
  identity.
- Not the Constitution (§8) — the Constitution is broader and includes
  security/conformance rules for the *current protocol version* that are
  not identity-defining.
- Not a novelty claim. Whether any of K1–K3 is original to Sails is a
  separate question this document does not address (see §17).
- Not a security or formal-verification claim (§17).

## 5. K1 — Valid Transition

> An interaction's economic state changes only through a condition that
> is both satisfied and economically valid under the specific ruleset
> that interaction is bound to; that binding changes only via a valid
> transition, never silently.

Covers both discretionary and fully deterministic paths without
enumerating mechanisms (consent, threshold agreement, discretionary
endorsement, and pre-agreed deterministic rules are all valid ways to
satisfy K1 — none is privileged, and this list is illustrative, not
exhaustive by design). Content-validity ("was this economically sound
under the ruleset") and procedural validity ("was this the right kind of
condition") are both required — a validly-attributed actor cannot
authorize an outcome the ruleset itself forbids.

## 6. K2 — Attributed Discretion

> When a state change depends on discretionary judgment, it must be
> attributable to a specific actor and bound to that exact interaction
> and transition — never inferred from whoever executes it.

Activates only when K1's condition involves discretion; fully
deterministic interactions never invoke it. This is the Kernel-level
generalization of `INV-12` (§8) — the same requirement, stated
independent of any one settlement rail or dispute mechanism.

## 7. K3 — Semantic Settlement Independence

> When a transition authorizes an economic outcome, that outcome's
> meaning is defined independently of whatever mechanism executes it; a
> mechanism may translate that meaning into its own terms but never alter
> what was authorized.

Conditional, not universal — most transitions (`OFFER_CREATED`,
`PAYMENT_SENT`, `DISPUTED`, `PENDING_BANKING`) authorize no economic
outcome at all and never engage K3 (§12). Deliberately carries no
"tolerance" concept of its own: whether a specific translation (rounding,
minimum-unit conversion, fee deduction) still counts as the same
authorized outcome is a question K1's own content-validity clause answers
for that interaction's ruleset — K3 states the absolute rule (never
alter), not a provider-declared exception to it.

## 8. Supporting Semantic Rule — Assertion

> An Assertion is an attributable, interaction-bound statement — never
> itself truth — that becomes part of that interaction's permanent record
> once submitted for its evaluation; corrections are new Assertions, not
> edits; unsubmitted internal signals need no such record.

This is **not a fourth Kernel property.** It is the supporting primitive
K1 and K2 depend on to be checkable at all — a claim, endorsement, or
observation that a Transition's evaluation may consume as input. It
carries no truth-status, confidence score, or "sufficiency weight" of its
own: sufficiency is always contextual, decided by a specific Transition's
own evaluation against the interaction's bound ruleset, never stored on
the Assertion itself. The trigger for permanent, append-only retention is
*submission for evaluation*, not eventual use, validity, or hypothetical
future relevance — a transient internal signal (an AI's unsubmitted
intermediate estimate, a provider's debug telemetry) never crosses this
boundary and needs no Kernel-level record.

## 9. Kernel Equation

```
Bound State (under a fixed, only-transitionally-changeable ruleset)
    --[condition: satisfied AND economically valid]-->
Bound State

(when the transition authorizes one)
Economic Outcome
    --[execution mechanism, translating only]-->
same economic meaning
```

## 10. Identity Statement

> For Sails to remain Sails: every economic state change must satisfy a
> condition that is both valid and economically sound under that
> interaction's own fixed ruleset; when the condition involves
> discretion, it must be attributable to a specific actor; and any
> authorized outcome's meaning must survive unaltered by whatever
> executes it.

Explanatory only. Where any tension exists between this statement and
K1/K2/K3's own text, K1/K2/K3 govern.

## 11. Freeze Provenance

This Kernel is the surviving result of a closed, adversarial process —
not a first draft accepted at face value. In order: broad semantic
discovery across the current implementation and specification; aggressive
object-count compression (an initial seven-object model reduced under
scrutiny); a dedicated Red Team pass constructing counterexamples against
every surviving claim (this is where the once-considered "non-custody is
Kernel identity" and "Coordinator≠Executor≠Value-Controller" framings
were tested and demoted — see §9 below); a final semantic arbitration
resolving the remaining ambiguities (the shape of the Assertion primitive,
sufficiency-as-contextual, the reduction from five candidate objects to
three properties); a final validation pass testing necessity, pairwise
independence, joint sufficiency, blind independent re-derivation, and
conformance-testability; and a final wording arbitration closing three
concrete gaps (explicit ruleset/version binding in K1, explicit
content-validity in K1, and removing an exploitable "provider-declared
tolerance" clause from K3). The process's own working record is not
reproduced here — this document preserves the model that survived, not
the diary of reaching it (`GOVERNANCE.md` §6C's own publication
discipline applies equally here).

## 12. Kernel vs Constitution

**Constitution defines what implementations of the current protocol
version must satisfy — a broader, more detailed, and more
policy-laden set of rules than identity alone.** The Kernel is
narrower: only what must remain true for something to be Sails *at all*,
regardless of protocol version or deployment policy.

| Kernel property | Supporting invariants | Relationship |
|---|---|---|
| K1 | Structural Invariant 1 (Core never knows concrete implementations); `INV-04` (Verify Before State Transition); `INV-11` (Deterministic Conformance) | K1 is the Kernel-level generalization; the invariants are its current-version, code-traceable expression |
| K2 | `INV-01` (Participant-Bound Authority); `INV-02` (Propose, Don't Impersonate); `INV-12` (Attributed Authority Integrity) | K2 **is** `INV-12` restated independent of rail and dispute mechanism — not a new requirement, the same one at a higher level of abstraction |
| K3 | Structural Invariant 6 (Infrastructure Neutrality); `INV-09` (Native Rail Semantics Must Be Preserved) | `INV-09`'s own text — rail semantics must be preserved, not silently redefined — is close to a direct restatement of K3 at the current-version, rail-specific level |

Constitutional properties confirmed **not** Kernel-derived, kept in the
Constitution because they protect real, current-version goals beyond
identity: Structural Invariant 2 (non-custody, §13), Structural Invariant
3 (fiat settles outside the protocol — itself substantially derived from
Structural Invariant 2, not an independent axiom), Structural Invariant 4
(every module optional — a conformance/packaging rule, not identity),
`INV-07`/`INV-OP-11` (recovery and crash-consistency, §14). No invariant
is removed, weakened, or reworded by this document.

## 13. Non-Custody Classification

**Non-custody is not Semantic Kernel identity.** A coordinator that holds
custodial control over a participant's value can, in a narrow and
carefully constructed scenario, still preserve independently-verifiable
authorization and independently-detectable execution divergence — meaning
K1 and K2 do not logically require it. It remains exactly what it already
was: a Constitutional, security, and conformance requirement (Structural
Invariant 2), and the disclosed live violation in `WdkSettlementProvider`
remains classified the same way it already was — a real, tracked
Constitutional nonconformance, not evidence that the system in question
stops being Sails. This does not weaken the protocol's non-custodial
design goal; it means only that *identity property* and *security/
conformance property* are different categories, and non-custody sits in
the second.

## 14. Recovery Classification

**Recovery is not Semantic Kernel identity.** None of K1, K2, or K3
reference durability across a crash — all three concern semantic validity
*while the system is operating*. A system satisfying K1–K3 perfectly that
loses an authorized-but-unexecuted outcome on crash is bad, unreliable
Sails — not not-Sails. Mission 11's own finding, `RECONSTRUCT EXECUTION ≠
RECONSTRUCT AUTHORITY`, remains fully important and fully valid; it is
correctly classified as an operational/security/correctness obligation on
any implementation that persists Kernel decisions, not as part of the
Kernel itself. Its importance is not demoted by this classification —
only its provenance is stated accurately.

## 15. Authority Classification

Three distinct dimensions, established across Mission 12/13, remain
distinct and are not collapsed by this document:

- **Participant Authority** → `INV-01` / `INV-02`
- **Custody / Signing Control** → Structural Invariant 2
- **Attributed Economic Authority** → `INV-12`, generalized at Kernel
  level as **K2**

K2 is the Kernel-level expression of the third dimension only. It does
not absorb, replace, or require the other two.

## 16. Mission 13 Consistency

Mission 13 (`arbitration-authority.ts`, MULTISIG rail) demonstrated **K2
conformance**: a signed authority decision, independently verifiable
against the deciding actor's own registered identity, with no unsigned
fallback. This achieved **Target 1 — Verifiable Attribution**: divergence
between an authorized decision and its execution is independently
detectable. It did **not** achieve Target 2 — cryptographic impossibility
of divergence. A server colluding with a participant could still, in
principle, produce a Bitcoin-valid disposition inconsistent with a signed
decision; K2 and Mission 13 together guarantee this would be detectable,
not that it cannot happen. This document makes no claim beyond that.
`sweepExpiredAutoResolutions()`'s advisory-only behavior (QVAC has no
verifiable authority to offer, so it does not execute) is consistent with
K2: discretion without independent attribution correctly does not
authorize a transition.

## 17. Settlement Boundary

The Kernel defines what an authorized economic outcome *means*.
Settlement mechanisms define *how* that meaning is executed — translating
representation, selecting rail-specific mechanics, performing execution,
reporting execution and finality facts back. A settlement mechanism may
never redefine the meaning it was handed (K3). Settlement is not
mandatory: a Sails interaction may produce a fully authorized economic
outcome and never execute it (§12 of the Kernel's own validation history)
— the Kernel's obligations end at producing that outcome.

## 18. Economic Disposition Optionality

Not every Transition produces an economic outcome. `OFFER_CREATED`,
`PAYMENT_SENT`, `DISPUTED`, and `PENDING_BANKING` change economic state —
altering commitments, available actions, or uncertainty — without
authorizing anything for a settlement mechanism to execute. K3 activates
only for the subset of Transitions that do produce an outcome; it is not,
and must never be documented as, a universal Transition output.

## 19. Ruleset / Version Binding

Each Interaction is bound to a specific, identifiable semantic ruleset.
That binding may change only through the interaction's own valid
Transition (an explicit, consented migration) — never silently, and never
by a later, unilateral reinterpretation of what an already-recorded
artifact meant. A historical Transition's validity is fixed to whatever
ruleset governed it at the time it occurred (consistent with `INV-05`,
historical meaning is immutable) and is not retroactively altered by a
later migration. This does not forbid migration — it forbids migration
happening any way other than through a valid, interaction-scoped
Transition. **No concrete mechanism for this exists in the current
implementation** — see §22 and Technical Debt items 34/35.

## 20. Assertion Boundary

An Assertion crosses into the Kernel's permanent record the moment it is
deliberately submitted into an Interaction's evaluation context — not
when it is used, found valid, or judged important. A submitted receipt,
a submitted AI recommendation, and a signed endorsement offered as proof
are all Assertions, retained regardless of whether they are ultimately
consulted or found correct. An AI's unsubmitted internal estimate, a
provider's debug telemetry, and other transient signals never cross this
boundary and require no Kernel-level record. Sails is not, and this
document does not make it, a universal event-logging protocol.

## 21. Assertion Correction and Sufficiency

Submitted Assertions are never rewritten. A correction is a new,
independent Assertion that supersedes or contradicts the prior one; the
prior Assertion remains part of the permanent record. Two contradictory
Assertions may both be genuinely authentic — the Kernel holds both
without adjudicating which is true. Sufficiency — whether a given
Assertion is enough to satisfy a specific Transition's condition — is
never a property of the Assertion itself; it is determined by that
Transition's own evaluation against the interaction's bound ruleset. The
same Assertion may be sufficient for one Transition, irrelevant to
another.

## 22. Specification Reconciliation

| | Status | Note |
|---|---|---|
| K1 | ALIGNED | State-machine/transition language is already pervasive in `PROTOCOL_SPECIFICATION.md` for Trade/Escrow/Dispute lifecycles. |
| K2 | PARTIAL | See Technical Debt item 35 — the Specification's own Arbiter treatment (§1.9: "a genuinely new actor," "not a protocol-native role") never anchors K2's "specific actor" language to one defined actor category. This is a real, disclosed gap, not a conflict. |
| K3 | ALIGNED | `SettlementProvider`'s own documented framing ("chain-agnostic in principle") directly anticipates K3. |

No Specification text is changed by this document — correcting the
Arbiter-classification gap would require an actual normative decision
(is the Arbiter a Participant? An Agent? Neither, formally, forever?)
this mission is not authorized to make. Recorded as debt (item 35), not
silently patched.

## 23. Current Implementation Conformance

> **Corrected/Implemented 2026-11-27 (historical delimitation):** the table below records the state when this document was frozen. It is a dated conformance record and not a current status: later work added an internal `packages/sails-core` package, a durable semantic transition record for MULTISIG disputes and a published Condition Algebra vector set, among other things, and the rows have not been re-evaluated here. Where this table and a newer evidence record disagree, the newer record governs.

| | Status | Evidence |
|---|---|---|
| K1 | IMPLEMENTED | Real state machines with valid-transition gating for Trade/Escrow/Dispute. |
| K2 | IMPLEMENTED (MULTISIG dispute-resolution path); PARTIAL elsewhere | `src/modules/open-settlement/arbitration-authority.ts`, `dispute.service.ts`'s `resolveDispute()` gate — verified to run unconditionally for every escrow type reaching that function, but dedicated adversarial test coverage exists only for MULTISIG (Technical Debt item 36). |
| K3 | PARTIAL | Rail-independent representation confirmed for `buyerBps`-style SPLIT dispositions; not every provider's translation discipline has been independently re-verified against K3's exact wording. |
| Assertion rule | PARTIAL | `evidence[]`/append-only intent exists (`DP-2`); the full type-taxonomy and submission-triggered-retention model this document states is conceptual, not literally implemented as a distinct mechanism. |
| Version/ruleset binding | ABSENT | No explicit interaction-scoped ruleset-version identity mechanism exists in the current schema. See Technical Debt items 34/35. |

Nonconformance recorded here is not remediated by this document — this
is a truthful handoff, not a fix.

## 24. Core Requirement Provenance

**A. Kernel-derived** (a future Sails Core must satisfy these because
K1–K3 require it, not as a stylistic choice):
- Represent economic state and valid-transition conditions without
  requiring any rail-specific transaction representation.
- Let a discretionary actor's endorsement be checked against that actor's
  own identity, not only an internal record.
- Scope every claim, endorsement, and observation to the specific
  interaction, transition, and ruleset-version it concerns; reject
  mismatches.
- Represent an authorized economic outcome as a standalone artifact,
  obtainable before, and independent of, any execution attempt.
- Let a settlement mechanism translate an authorized outcome, never
  redefine it.
- Remain fully coherent with zero Assertions recorded and zero
  discretionary actors ever invoked.
- Preserve every consequentially-submitted claim, endorsement, and
  observation as an immutable record; represent correction as a new
  record, never a mutation.

**B. Constitution/security-derived** (real, important, but not required
by K1–K3 themselves):
- The specific mechanism by which an actor's identity is externally
  checkable (e.g., a particular key scheme) — K2 requires independent
  attributability in the abstract, not any one cryptographic realization.
- Value control must not be assumed to reside with the semantic
  coordinator (Structural Invariant 2's own concern, not K2's).

**C. Operational/implementation** (important for a trustworthy, durable
system; not Kernel-derived):
- Be able to reconstruct an already-authorized outcome after failure
  without generating a new one on anyone's behalf (Mission 11's own
  finding — real, necessary, and explicitly outside Kernel identity per
  §14).

## 25. Future Sails Core — Conceptual Definition (historical framing)

**Sails Core** was described here as the future protocol-level software
responsible for implementing and exposing the Semantic Kernel, and the
minimum supporting machinery required to preserve it, across whatever
protocol modules a given deployment implements. **Corrected/Updated
2026-08-29**: this section originally stated "no architecture decision
made here" — that architecture was subsequently frozen in
`docs/CORE_ARCHITECTURE.md`. **Current-state correction 2026-09-16:** the
later Sails Core Implementation Program has since created the
internal/private `@sails/core` workspace package at `packages/sails-core/`
as the TypeScript implementation surface for the Pure Semantic Core. This
does not retroactively change what this document authorized at freeze time,
does not expand the Pure Core boundary, and does not imply full migration.
Runtime, Modules, Providers, persistence/orchestration, and application
adapters remain outside `@sails/core`; selected Runtime slices now invoke
Core-authoritative semantics while other paths remain legacy-authoritative.
The package remains internal/private and is not a public npm package.

This is explicitly **not** the existing "Core — 6 Formal Components"
named in `ARCHITECTURE.md` §1B (Intent Engine, Coordination Engine, Event
Bus, State Machine, Capability Registry, Policy/Rules Engine) — that is
today's real, shipped implementation topology, evaluated against the
Kernel in §23 like any other part of the system, not assumed to already
be it. Whether a Sails Core implementation is built by extending those six
components, replacing them, or something else is an implementation question,
not decided by the Kernel itself. **Kernel ≠ package. Pure Core ≠ current
module collection.**

## 26. Same Semantics, Different Consumers

A future Core's semantic surface (state, valid actions, economic
consequences, authority requirements, Assertion/evidence requirements,
ruleset/version, uncertainty, finality, capabilities, recovery status) is
architecturally intended to serve multiple consumer categories
identically — protocol code, AI/agents, human-facing UX, SDK integrators,
and other protocol modules — rather than each consumer inventing its own
partial view. This is a direction for future work, not a claim that such
a surface exists today. In particular:

- **UX**: a future interface layer translates protocol state into human
  meaning and abstracts mechanics, but must never let UI state define
  Core state, and must preserve whatever the Kernel makes verifiable
  rather than hiding it behind a simplified label.
- **AI/Agents**: an AI may consume Assertions and reason about protocol
  state, but an AI's recommendation is never automatically truth, a
  protocol rule, or economic authority (K2, §8) — QVAC's current
  advisory-only status for disputed MULTISIG settlement (§16) is the
  concrete, already-shipped instance of this principle. Any future
  delegated agent authority requires its own explicit authorization
  semantics; none is authorized by this document.
- **Context/Knowledge**: retrieval does not confer authority, and shared
  general knowledge is not the same thing as shared private interaction
  context. A future machine-readable knowledge/context architecture may
  use the Kernel's own vocabulary as an anchor, but is a separate,
  transversal concern this document does not define.

## 27. Open Core Architecture Questions

**Answered, 2026-08-29, by `docs/CORE_ARCHITECTURE.md`** — the frozen
software-architecture derivation of this Kernel. That document does not
change anything written here; it is evaluated against this Kernel, not
the reverse. The questions below are preserved as the record of what was
open before that derivation, not reopened by this note.

- What is the minimum Core semantic API?
- How are Interaction / ruleset / State / Transition best represented —
  stored directly, derived/projected, or both?
- How are Transition Conditions represented in a way that unifies
  deterministic and discretionary paths without privileging either?
- How is an economic outcome represented without coupling to any
  settlement rail's internals?
- How are Assertions represented and referenced across an interaction's
  lifetime?
- How is ruleset/version identity concretely represented and checked?
- What is Core's responsibility versus a protocol module's? Versus a
  settlement provider's?
- What semantic surface should SDK, UX, and AI consumers actually
  receive, and in what shape?
- How is conformance to K1–K3 concretely tested?

## 28. Explicit Non-Goals of This Document

This document does not claim: formal verification; novelty, originality,
or priority over any other system (a separate, closed inquiry — not
reopened here); production readiness; completed security audit;
immutability of the Kernel forever; that all Constitutional rules are
Kernel identity; or that all modules or rails currently conform to K1–K3.
At freeze time it also did not claim that Sails Core existed or authorize
`@sails/core` or any other package. The later existence of the internal
`@sails/core` implementation is a separate implementation-program fact and
does not retroactively alter this document's provenance or semantic scope.
