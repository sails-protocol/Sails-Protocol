# CORE_IMPLEMENTATION_ARCHITECTURE.md
### Sails Protocol — Engineering Handoff · Core Implementation Architecture Baseline

> Read `SEMANTIC_KERNEL.md` and `CORE_ARCHITECTURE.md` first. This
> document assumes K1/K2/K3, the Assertion rule, and the frozen Pure
> Core / Runtime / Modules / Providers macro architecture as fixed
> input. It answers a narrower question than either: not *what* Sails
> Core must be, but *how* it can actually be built — represented,
> bounded, and migrated into — without distorting the semantics it
> exists to materialize. Where anything here appears to conflict with
> either document, they govern and this document is wrong.

---

## 1. Purpose

`CORE_ARCHITECTURE.md` froze what Sails Core is responsible for. It
deliberately left open how any of that gets represented in real code,
how a second, independent implementation could exist at all, and how
the current Sails implementation could migrate toward it without ever
running two competing sources of semantic authority at once. This
document closes that gap.

**Why Sails needs a Pure Core boundary at all**: without one, "is this
transition valid," "who authorized it," and "does this outcome still
mean what it meant when authorized" end up answered by whichever
service function happens to run first — which is exactly how semantic
authority silently fragments across a codebase over time. A Pure Core
gives those three questions one, deterministic, side-effect-free home,
checkable independently of the database, the network, or which
language implements it.

**Why this must be language-neutral**: a protocol that can only be
correctly reasoned about by reading one team's TypeScript source is not
independently implementable, and independent implementability is a
direct, tested requirement of the frozen Core Architecture. Everything
in this document is written to survive being read by a team that will
never see the Sails TypeScript codebase.

## 2. Status

**FROZEN IMPLEMENTATION ARCHITECTURE BASELINE.** The result of a closed
adversarial process — clean-room derivation, an adversarial Red Team
across representation, boundary, and migration questions, a targeted
revision, a final validation that directly inspected this repository's
own dependency-resolution behavior rather than assuming it, and a final
wording arbitration. It is canonical as of this document's own commit
and, like the documents above it, revisable only through an explicit,
versioned process.

**Current-state correction (2026-09-16):** this implementation architecture
was frozen before the implementation program started. The later Sails Core
Implementation Program created `packages/sails-core/`, an internal/private
TypeScript workspace package named `@sails/core`, as the physical
implementation surface for the **Pure Semantic Core** boundary described
here. That later package creation does not retroactively mean this freeze
authorized package creation, and it does not expand the boundary: Runtime,
Modules, Providers, persistence/orchestration, and application adapters
remain outside `@sails/core`. Selected Runtime slices now invoke
Core-authoritative semantics, but the migration is partial and the legacy
implementation has not become globally Core-authoritative. `@sails/core`
remains internal/private and is not a public npm package. Future-looking
implementation language below is retained as freeze-time program context
unless explicitly corrected by a later dated note.

## 3. What This Document Is Not

Not the Semantic Kernel or the Core Architecture. Not an implementation
— no runtime code changes as a result of this document. Not a package
specification, API specification, or database schema. **At freeze time,
`@sails/core` did not yet exist and was not authorized by this document.**
A later authorized implementation program created the internal/private
package without changing the authority or scope of this baseline. Not a
claim that a second (Rust, Go, or otherwise) implementation exists, that
formal cross-language equivalence has been proven, or that the described
migration has been completed.

---

## 4. Macro Architecture, Restated for Implementers

```
      Domain Module                         Provider
      (implements domain               (executes external
       semantics conforming                effects, reports
       to Core's contracts)                 back as Assertions)
            │                                     ▲
            │ conforms to                         │ dispatch / report
            ▼                                     │
      ┌─────────────── Pure Core ───────────────┐ │
      │  defines semantic contracts;              │
      │  evaluates whatever it is given;          │
      │  fetches nothing, persists nothing,       │
      │  dispatches nothing                       │
      └─────────────────────┬─────────────────────┘
                             │ wires inputs in,
                             │ evaluation results out
                             ▼
                          Runtime
              (assembles inputs, commits durably,
               orchestrates dispatch and recovery)
```

**Core defines semantic contracts — it never statically depends on any
specific Domain Module.** Modules implement domain semantics conforming
to those contracts. Runtime wires Core and Modules together at
evaluation time and owns everything that touches the outside world.
Providers execute and report back; they translate, never redefine.
This graph is expressed in role terms, not import syntax, precisely so
it maps identically onto TypeScript, Rust, or Go.

## 5. Semantic Identity

Five distinct identities exist. **Only three carry semantic-history
significance.**

| Identity | Carries semantic weight? |
|---|---|
| Ruleset Identity | **Yes** |
| Canonical Evaluator Identity | **Yes** |
| Canonical Semantic Profile Identity | **Yes** |
| Implementation package identity (npm/crate version) | No |
| Implementation artifact identity (a binary/bundle hash) | No |

A Ruleset declares, as ordinary data, its *expected* Canonical
Evaluator Identity and Canonical Semantic Profile identity/version. An
evaluation context supplies the *actual* evaluator and profile identity
being invoked. **Core performs a pure, deterministic identity/reference
consistency check before evaluation proceeds** — a declared-vs-actual
mismatch on either identifier is rejected by Core itself, before any
question of authority arises. Package version and artifact hash never
enter this comparison and never define semantic equivalence: a TS
implementation at `payments@1.0.3` and a Rust implementation at
`payments@2.1.0` may both legitimately claim the same Canonical
Evaluator Identity — their package versions are irrelevant to whether
they do.

**A Canonical Evaluator Identity is legitimate only if it resolves to a
publicly identifiable semantic behavioral definition** — one letting an
independent implementer understand the behavior it denotes without
reading Satsails' own source or requesting private maintainer
interpretation. No registry or certification bureaucracy is designed
here; this freezes a required *property* of a legitimate identity.

## 6. Conformance

**Recognized identity ≠ conformant artifact.** A recognized identity has
a public definition (§5). A conformant artifact is one with
independently-checkable evidence supporting its specific claim to
implement that identity. Declaring an identifier does not make an
implementation conformant. **Conformance vectors are evidence, never
proof** — a permanent, disclosed limit of testing-based conformance, not
a defect. Before an evaluator becomes authoritative, its implementation
must have such evidence available; no certification infrastructure is
designed here beyond this requirement.

## 7. Input Contract

**Declared semantic input dependencies are part of the Canonical
Evaluator Identity's own published definition** — never left to each
implementing artifact's independent discretion. Two artifacts declaring
different input dependencies while claiming the same identity are not,
by definition, implementing the same semantics. This is what makes
complete input assembly, historical re-evaluation, cross-language
implementation, and Transition Record minimality (§13) all possible at
once.

## 8. Condition Semantics

The four-state model — `SATISFIED`, `NOT_YET_SATISFIED`,
`UNSATISFIABLE`, `UNKNOWN` — is frozen in `CORE_ARCHITECTURE.md` §12–14
and is **not redefined here.** The only implementation-level addition:
`ConditionResult` and the correspondence/execution-validity roles below
(§9, §11) must remain non-confusable semantic roles even where they
share the identical underlying four-value shape — never a second
canonical definition of the four states themselves.

## 9. Correspondence

Final vocabulary: **MATCH / DIVERGENT / PENDING / UNKNOWN.** No
`CONFLICTED` state — conflicting execution evidence is resolved into one
of these four by Module/Ruleset policy, exactly as contradiction is
already handled for `ConditionResult`.

- **PENDING** — the bound execution semantics declare a specific
  completeness condition not yet satisfied (await N confirmations,
  await a second leg); additional evidence is expected under those same
  semantics.
- **UNKNOWN** — available admissible evidence is insufficient or
  irresolvable under the bound semantics, and no declared completeness
  condition classifies the state as merely pending.

**Correspondence is evaluated for one authorized Outcome against that
Outcome's own bound, accumulating execution-evidence set** — never a
single report in isolation.

## 10. Historical Integrity

Same-Outcome evidence may legitimately move the correspondence verdict
— `PENDING → MATCH`, `MATCH → DIVERGENT`, `DIVERGENT → MATCH` — **only**
when the new evidence belongs to the *same* Outcome and its *original*
execution semantics already permitted the later completion (a delayed
second leg of an originally multi-leg authorization is the paradigm
case; a reversal or reorg reported as new evidence about the *same*
execution is another).

**A compensating action authorized by a NEW Transition never rewrites
the historical correspondence of the original Outcome.**

```
Outcome A  --execution evidence-->  DIVERGENT   (permanent, historical)
Transition B --> Outcome B  --own evidence-->  MATCH  (independent)
```

The Interaction's *current net economic position* may become corrected
by B's existence. Outcome A's own historical correspondence record
never changes. Historical execution correspondence and current net
economic position are never the same value.

## 11. Execution Validity

Transition-condition evaluation and execution-validity evaluation
("may this already-authorized Outcome still be dispatched?") are
**distinct semantic roles**, sharing the identical four-value algebra
where useful. The architecture requires this distinguishability of
*role* — it does not require two concrete classes or types; a
discriminated result, separate types, or any other realization is an
implementation choice.

---

## 12. Transition Record

**No semantic decision becomes Core-authoritative before a durable
Transition Record exists for that decision class.** The Record may
initially support only the first migrated slice — it does not need its
eventual universal shape before that slice's authority transfer.

The authoritative commit establishes the semantic decision, the
resulting semantic-history position, and the durable Record together,
under one **visibility-consistency boundary**: no observer may see the
Record as authoritative without also seeing the State it describes as
current, or vice versa. This is satisfiable by a single database
transaction, an event-sourced append (trivially, one write serves both
views), or any mechanism preserving the same property — never assumed
to require a SQL transaction specifically. Confirmed compatible with
Postgres, event-sourced, and local-first Runtimes alike.

## 13. Record Minimality

For the first deterministic migration slice, the minimum Record binds:
Interaction scope; prior semantic-history position; the Transition
itself; resulting State binding; Ruleset binding; the actual Canonical
Evaluator Identity and Profile identity used; and the committed,
consumed semantic inputs (via the semantic-history binding, §14) — this
last item's own combination with the evaluator's published input
contract (§7) makes a separate "semantic provenance" field redundant,
and none is included.

For discretionary transitions, the Record additionally carries: the raw
attribution proof; the historically-resolved identity/key material
relied upon; and the exact decision binding. **Never persist only a
cached `verified=true` conclusion** — a bare boolean is not
independently re-verifiable years later; the raw proof and resolved
identity state are what a future verifier actually needs.

## 14. Semantic-History Binding

May include, only when semantically consumed: State; Ruleset content;
Assertions; the actual Canonical Evaluator Identity; the actual
Canonical Semantic Profile identity/version; historical
identity-resolution material (when Attribution applies); an explicit
time input/source identity (when a leaf predicate consumed one); and
Outcome/destination references.

**Never treated as semantic identity**: Core implementation package
version, Module implementation package version, npm version, crate
version, SDK version, Provider version. Artifact hashes may exist for
operational reproducibility without ever becoming semantic identity.

---

## 15. Destination Binding

Outcome meaning remains **rail-independent** ("70% to Buyer" is the
semantic content, unchanged regardless of settlement rail). Execution
destination may be rail-specific (a Bitcoin address, an EVM address, a
bank account, a Lightning invoice). Where destination is economically
material, **a destination binding is fixed at authorization time.**

**Its existence and reference are structurally visible** in the
semantic Record/Outcome envelope; its internal content may remain
opaque and rail-specific. Core never needs to understand Bitcoin
address, IBAN, Lightning-invoice, or EVM-account syntax — only the
responsible Module/correspondence evaluator needs canonical
interpretation of whatever binding shape it supports. **The existence
of a destination binding must never be buried entirely inside opaque
Outcome bytes** — this is what closes the "right amount, wrong
recipient" failure mode: amount-only correspondence checking cannot
catch a substituted destination; a visible, decision-time-bound
reference can.

## 16. Destination Rotation

A destination may change only through a **separately, properly
authorized, prospective Transition**, never silently by Runtime or
Provider. The old Record remains historically unchanged forever; a new
Transition establishes a new binding for the still-unexecuted Outcome
going forward — no retroactive mutation.

**Architecture clarification, 2026-08-30 (Mission M8.5 — Destination
Authority & Provenance).** §15/§16 above fix *when* a destination
binding is fixed and *how* it may change, but neither states *whose*
authorization fixes it in the first place — a real gap M8 found live in
`dispute.service.ts`'s `resolveDispute()` (a discretionary authority's
own request parameter, not the beneficiary, unconditionally supplied the
destination). `docs/DESTINATION_AUTHORITY_ARCHITECTURE.md` closes this:
destination authorization is the beneficiary's own authority (`INV-01`),
never the discretionary authority's, the Runtime's, or the
settlement-key holder's — verified via the same generalized Attribution
primitive M5 already built (`packages/sails-core/src/attribution.ts`),
requiring no Kernel or Core change. See that document in full.

**Implementation boundary (M8-R/M8-R2).** Sections 15–16 state the
normative contract, not universal rail conformance. In the MULTISIG
arbitrated path, `commitAuthoritativeDisputeRuling()` reads registered
beneficiary destinations inside the transaction that claims the ruling
and inserts the authoritative Outcome record. The binding reflects the
values read by that transaction; READ COMMITTED alone does not establish
that every concurrent profile update is serialized at Outcome commit
or that multiple beneficiary reads share one database snapshot.
`PayoutAddressService` registration updates the standing address, not
an existing Outcome binding. Other reference rails resolve registered
destinations at settlement time rather than using this same atomic
Outcome snapshot. The prospective correction Transition described above
is a normative requirement; the registration upsert is not evidence of
its implementation. No universal rotation, recovery or production
homologation guarantee follows.

---

## 17. Pure Core Effect Boundary

**A Pure Core implementation must have a mechanically enforced
dependency/effect boundary from the first line of implementation.**
Forbidden dependencies and ambient effects — Prisma, network clients,
Provider SDKs, Redis, environment access, an implicit clock,
`fetch`/network access — must be **statically detectable before
merge.**

This is an architecture-level requirement, not a claim about any
specific tool. In particular: **an npm/pnpm/yarn workspace package's
own omission of a dependency does not, by itself, prevent that
dependency from resolving** under standard dependency hoisting — this
was checked directly against this repository's own configuration and
found true here, so it must never be relied on alone. The requirement
is satisfied by a **static, declaration-level check** (comparing a
package's actual source-code imports against its own declared
manifest, independent of what would or wouldn't resolve at runtime),
realizable via tools such as `eslint-plugin-import`'s
`no-extraneous-dependencies` rule or `dependency-cruiser` — or any
mechanism proving equivalent enforcement.

## 18. Reference Implementation Guidance (not protocol semantics)

The TypeScript reference implementation may use an unpublished internal
workspace boundary, combined with the static checks above and an
independent build/typecheck target. This is implementation guidance,
offered as a reasonable path, not a frozen protocol requirement. The
governing principle: **physical separation from day one ≠ public
package from day one.** At freeze time this document did not itself
authorize `@sails/core`; the later implementation program adopted exactly
this internal-workspace pattern. That later adoption does not make package
identity semantic authority and does not authorize public npm publication.

## 19. Language Neutrality

TypeScript is expected to be the *first* Core implementation. **It is
not the semantic authority.** A future Rust, Go, or other implementation
may implement the same Canonical Evaluator semantics, and no conformant
implementation should ever need to inspect TypeScript source to
discover what a given identity means — the public definition (§5) is
what a conformant implementer reads instead.

---

## 20. Shadow Migration

Shadow evaluation is permitted; **dual authority is forbidden.**
**Shadow evaluation context must be mechanically distinguishable from
authoritative context.** Shadow may compute, compare, and log
diagnostic evidence. Shadow may **never** commit an authoritative
Transition Record, mutate authoritative State, dispatch a Provider,
emit an authoritative semantic event, or exercise economic authority.

## 21. Shadow Divergence

Divergence taxonomy: `LEGACY_DEFECT`, `CORE_DEFECT`, `INPUT_MISMATCH`,
`RULESET_MODEL_GAP`, `EXPECTED_REPRESENTATION_DIFFERENCE`,
`INCONCLUSIVE` — each maps to a genuinely distinct remediation action;
none collapse into another. **Legacy output is evidence to investigate,
never normative authority over Core's own semantics.** On disagreement:
capture both inputs and results; compare semantic assumptions; replay
against the frozen Kernel/Core Architecture directly; check whether
legacy omitted a required input; check whether Core mis-modeled the
required semantics; classify; only then correct the side the
classification actually implicates. **Never automatically patch Core to
match legacy, and never automatically declare Core correct.**

## 22. Authority Partition

**Exactly one authoritative evaluator per semantic decision** — never
per raw transition-type string. Different semantic decisions may
migrate at different times. If a legacy system treats one economic
decision atomically while Core internally decomposes it into several
Transitions, **the migration boundary treats that economic decision as
one indivisible authority unit** unless an explicit analysis first
demonstrates the decomposition creates genuinely independent semantic
decisions. No semantic decision may be simultaneously legacy-
authoritative and Core-authoritative.

## 23. Ruleset Admission

Two responsibilities, kept separate. **Governance/Conformance tooling**
recognizes whether a given Ruleset/Evaluator/Profile combination is
admitted for use — an evidentiary, behavioral, external process,
classified as conformance/governance tooling, not Pure Core runtime
machinery. **Core**, independently, performs a **pure structural
consistency check** on the resolved semantic material it is actually
given: resolved Ruleset identity/commitment consistency; the declared
expected Evaluator Identity; the declared expected Profile
identity/version; and the actual evaluator/profile references supplied
for this evaluation. **Core never certifies behavioral correctness** —
that remains governance's job. **Runtime cannot substitute the bare
claim "this Ruleset was admitted" for Core's own deterministic
structural verification.**

## 24. Time

Time may be an explicit, committed semantic evaluation input — e.g. an
already-recorded lock timestamp plus the current evaluation time,
feeding a timeout predicate — **without automatically becoming an
Assertion.** The Assertion rule (§25) concerns attributable, submitted
statements a party could get wrong; a deterministic environmental value
no one is claiming and that cannot be wrong in that sense is not
manufactured into a fake Assertion.

## 25. Assertion

The frozen Assertion rule (`SEMANTIC_KERNEL.md` §8) is not redefined
here. **Assertion ≠ truth.** Execution reports may be Assertions.
**Record ≠ world truth** — a Transition Record means the authoritative
*Sails semantic record* of a transition; it never means the external
event definitely occurred, the Provider was honest, a bank transfer is
irreversible, or a blockchain confirmation is final.

## 26. Provider Boundary

A Provider executes external effects and may translate authorized
semantic meaning into rail mechanics. **It may never redefine authorized
economic meaning.** Provider reports are Assertions, never world truth.
Provider availability is an executability question, never a semantic
validity question. Provider implementation or version is never semantic
identity.

## 27. Conditional Guarantee

**Core guarantees correct application of its own fixed machinery to
whatever semantic inputs and evaluator implementations it is supplied.**
Module conformance supports domain-semantic correctness, to the extent
evidence supports it. Runtime conformance supports correct evaluator
selection, complete and authentic input supply, authoritative commit,
and orchestration. Provider conformance supports rail execution and
reporting behavior within its declared contract. **No layer repairs a
malicious or non-conformant lower layer.** This document never states
"Core alone guarantees K1/K2/K3" — every guarantee is stated with its
actual conditionality attached.

---

## 28. First Migration Slice

Recommended: **`FUNDS_LOCKED → EXPIRED`** (the existing escrow-timelock
expiry transition). Directly verified against the current implementation
(`src/modules/open-settlement/escrow.service.ts`): deterministic,
genuinely condition-bearing (a real timelock-elapsed check, not bare
structural adjacency), system-observed (`triggeredBy =
'system:expiry-sweeper'`), non-fund-moving, idempotent by construction,
and shadow-comparable against the existing sweeper. It exercises
explicit committed time input (§24), never a synthetic time Assertion.

## 29. Migration Sequence

```
M0  mechanical dependency/effect boundary established
M1  semantic-model types only (no evaluation logic yet)
M2  Canonical Evaluator Identity scheme + conformance-vector harness
M3  first slice (EXPIRED timeout): evaluator logic + minimal durable
    Record for this slice + shadow comparison against the sweeper
M4  first slice becomes Core-authoritative (sustained shadow agreement)
M5  Attribution generalized beyond the single-actor MULTISIG case
M6  CorrespondenceResult + destination-binding introduced
M7  Outcome/correspondence slice becomes authoritative
M8  Provider dispatch, gated on the Record and execution validity
M9  Recovery/reconciliation integration
M10 SDK adapter (three-bucket downgrade: success / failure / pending —
    never collapsing failure and pending together)
```

**No authority transfer occurs before**: the mechanical boundary (M0),
a recognized evaluator identity (M2), a durable minimal Record for that
decision class (M3), and sustained shadow validation.

## 30. Migration Genesis

The first Core Record for a migrating Interaction may bind
`priorPosition = LEGACY_UNVERIFIED` plus the exact, committed legacy
State projection used as trusted migration input. This is an explicit,
disclosed migration assumption, never a claim of retroactive historical
verification — no fabricated history, no synthesized signatures, no
retroactive Core-conformance claim about pre-migration data.

## 31. Machine-Readable Surface (future consumers only)

Future interfaces — SDKs, human-facing UX, agent interfaces — will
consume Core's semantic surface identically ("same semantics, different
consumers," per `CORE_ARCHITECTURE.md` §41). This document does not
design that surface. MCP, WebMCP, and any agent-facing protocol adapter
remain explicitly out of scope and out of Core.

---

## 32. Implementation Program Handoff

Implementation is authorized **only after this repository freeze
succeeds**, and only in this order: **M0 (mechanical boundary) first,
then M1 (semantic model).** Do not jump directly to fund movement,
MULTISIG replacement, Provider dispatch, or public package publication.

## 33. Implementation Non-Goals (this program's initial phase)

Not authorized by this freeze: public `@sails/core` publication;
production Bitcoin changes; production fund-movement changes; a new
settlement rail; MCP or WebMCP implementation; an agent market
implementation; Protocol UX implementation; Reference UI redesign;
schema migration (unless separately approved); npm publication.

## 34. Deferred Backlog (not solved here)

Availability mechanism; the Finality-model documentation gap in
`CORE_ARCHITECTURE.md`; formal verification; cross-language mathematical
equivalence; SDK downgrade ergonomics beyond the three-bucket minimum;
`ExecutionPlan`; public package design; MCP; WebMCP; Agent Interface
Architecture; Human & Agent Interaction Architecture; Agent Authority &
Delegation; Human-in-the-Loop policies; Agent-to-Agent negotiation;
Agentic P2P Markets; Protocol UX by Design; Reference Interaction Model;
Reference UI; Context & Knowledge Architecture.

---

## 35. Authorized Claims

At freeze time, it was accurate to say: Sails had a validated Semantic
Kernel, Core Architecture, and Core Implementation Architecture; the Core
implementation architecture was language-neutral and explicitly separated
semantic identity from implementation package identity; and the architecture
defined a staged migration path from the then-current implementation to a
Pure Core without dual semantic authority. The first implementation was
expected in TypeScript, but TypeScript was never the semantic authority.

**Current-state correction (2026-09-16):** that implementation program has
since begun and the internal/private TypeScript `@sails/core` package now
exists. Selected semantic decisions have migrated to bounded
Core-authoritative Runtime slices, while other paths remain legacy-
authoritative. Therefore it is accurate to claim partial implementation and
partial authority migration, but not full migration, production readiness,
or that `@sails/core` encompasses Runtime, Modules, Providers, or the Sails
Protocol as a whole.

## 36. Forbidden Claims

This document does not support claiming: a Rust implementation exists;
a Go implementation exists; formal cross-language equivalence has been
established; Core is production-ready; a public `@sails/core` package
exists; the migration has been completed; production fund safety has
been demonstrated by this document.
