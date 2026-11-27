# CORE_ARCHITECTURE.md
### Sails Protocol — Engineering Handoff · Core Architecture Baseline

> Read `SEMANTIC_KERNEL.md` first. This document assumes K1/K2/K3 and the
> supporting Assertion rule as fixed, immutable input and answers a
> narrower question than that document does: not *what must remain true
> for something to be Sails*, but *what minimum software architecture
> materializes that truth*. Where anything here appears to conflict with
> `SEMANTIC_KERNEL.md`, the Kernel governs and this document is wrong.

---

## 1. Purpose

`SEMANTIC_KERNEL.md` froze *what* must remain true for Sails to remain
Sails. It deliberately left open *how* any of that gets built in
software (`SEMANTIC_KERNEL.md` §27). This document closes that gap: it
records the validated software architecture — **Sails Core** — that a
future implementation must conform to in order to faithfully materialize
K1, K2, K3, and the Assertion rule.

## 2. Status

**FROZEN ARCHITECTURE BASELINE.**

This is the canonical software-architecture derivation of the frozen
Semantic Kernel. It is the result of a closed, adversarial design
process (§5) — not a first draft accepted at face value — and is
canonical as of this document's own commit. Like the Kernel itself, it
may be revised only through an explicit, versioned process, never by
silent reinterpretation during implementation.

**Current-state correction (2026-09-16):** this architecture was frozen
before implementation began. The later Sails Core Implementation Program
created `packages/sails-core/`, an internal/private TypeScript workspace
package named `@sails/core`, as the implementation surface for the **Pure
Semantic Core** boundary defined here. That implementation fact does not
change this document's provenance or expand the boundary: Runtime, Modules,
Providers, persistence/orchestration, and application adapters remain outside
`@sails/core`. Selected Runtime slices now invoke Core-authoritative
semantics, but the full legacy implementation has not migrated. The package
remains internal/private and is not a public npm package. Statements below
that say the package did not yet exist are preserved as freeze-time context,
not as current repository-state claims.

## 3. What This Document Is Not

- Not the Semantic Kernel itself — see `SEMANTIC_KERNEL.md`.
- Not the Constitution, security model, or Specification.
- Not an implementation. No line of runtime code changes as a result of
  this document.
- Not a package specification. **At freeze time, `@sails/core` did not
  exist and was not authorized by this document.** A later authorized
  implementation program created the internal/private package without
  changing this architecture's authority or scope.
- Not an API specification, serialization specification, database
  schema, or wire format.
- Not a provider implementation, runtime implementation, or SDK design.
- Not a claim of novelty, formal verification, production readiness, or
  audited status (§42).

## 4. What Sails Core Is

**Sails Core is a pure semantic evaluator.** Given explicit, already-
assembled semantic material — a bound ruleset, the relevant prior State,
the specific admitted Assertions that matter to one candidate action —
it determines whether that action is valid, checks who it is
attributable to when discretion is involved, and, when it authorizes an
economic outcome, derives that outcome's meaning exactly as the ruleset
defines it. It is deliberately small: everything that touches the
outside world — databases, networks, settlement rails, retries, crash
recovery — sits outside it, in a separate layer this document calls the
**Runtime**.

## 5. Provenance

This architecture is the surviving result of a five-phase, closed
adversarial process against `SEMANTIC_KERNEL.md`'s frozen K1/K2/K3:
a clean-room semantic-to-software derivation; an adversarial boundary
and abstraction Red Team across twenty-two attack classes; a targeted
revision incorporating the Red Team's earned corrections; a final
validation pass holding the revision to a stricter burden of proof
(finding, among other things, that a mandatory "economic anchor" type
and a mandatory concurrency-dependency model were both unnecessary
over-specification); and a final targeted structural revision removing
that over-specification and re-validating the result across fifteen
worlds. As with the Kernel, this document preserves the model that
survived, not the diary of reaching it (`GOVERNANCE.md` §6C).

## 6. Kernel Traceability

| Kernel element | Core architecture element |
|---|---|
| K1 — Valid Transition | Transition Evaluation (§23–24), the four-state condition model (§15–17), ruleset semantic identity (§20) |
| K2 — Attributed Discretion | Attribution (§33), conditional Actor role (§31), decision-time evidence capture (Rule 5, §32) |
| K3 — Semantic Settlement Independence | Outcome semantics (§25–26), execution correspondence (§27) |
| Assertion rule | Assertion semantics (§22), Assertion Admission & Correction (§33) |

`SEMANTIC_KERNEL.md` → this document → future implementation. This
dependency direction is fixed and never reversed: nothing in this
document may be read back into the Kernel, and no implementation
convenience may be read back into either.

---

## 7. Macro Architecture

Four parts, in plain language first:

- **Sails Core** decides what's true and what's meant — nothing else.
- **Runtime** does the actual work: fetching what Core needs, writing
  down what Core decided, dispatching real effects, recovering from
  crashes.
- **Modules** supply the domain rules — what a "trade" is, what
  conditions govern a dispute, what an outcome looks like for P2P
  trading specifically.
- **Providers** are the execution mechanisms — a Bitcoin multisig, a
  Lightning hold invoice, a bank rail — that carry out what was
  authorized and report back.

No technology name is fundamental to any of the four. The full canonical
statement:

> Sails Core is a pure, deterministic evaluator. Given a candidate
> Transition and the committed semantic material it depends on — a
> bound ruleset, the relevant prior State, and the specific admitted
> Assertions consulted — Core determines whether the Transition's
> condition is satisfied, not-yet-satisfied, unsatisfiable, or presently
> unknown; checks attribution when the transition depends on
> discretionary judgment; and, when the ruleset authorizes an economic
> outcome, derives that outcome's meaning exactly as the ruleset defines
> it. Core produces one self-contained Transition Record — immutable
> once committed — but never persists it, dispatches it, or fetches its
> own inputs.
>
> A conformant Runtime assembles Core's inputs, commits each Record
> visibly together with the State it authorizes, dispatches external
> effects only afterward, honors any execution-validity conditions the
> authorization carries, and never re-derives authority once fixed.
> Modules supply domain rulesets and their meaning; Providers execute
> and report back, never redefining what was authorized. An outcome's
> meaning survives execution because the ruleset that authorized it —
> not whatever later executes it — remains its sole, checkable
> definition.

### 7.1 Architecture Diagram

```
   Modules / Rulesets  (domain rules, conditions, Outcome meaning)
           │  (immutable, versioned, canonically-profiled content)
           ▼
   Committed Semantic Material  (ruleset + State + admitted Assertions,
                                   bound as one semantic-history position)
           │
           ▼
   ┌───────────────── Pure Sails Core ─────────────────┐
   │  Semantic Model & Commitment Resolution             │
   │  Transition Evaluation & Outcome Derivation         │
   │  Attribution (when K2 applies)                      │
   │  Assertion Admission & Correction                   │
   └───────────────────────┬─────────────────────────────┘
                            │  Transition Record
                            ▼
                Runtime / Orchestration
        (commits Record + State together, visibly;
         dispatches only after commitment;
         enforces execution-validity conditions)
                            │
                            ▼
                        Providers
                            │
                            ▼
              execution-report Assertion ──▲
              (re-enters Assertion Admission, then
               Core's correspondence evaluation)
```

### 7.2 Trust Boundary Diagram

```
  SEMANTIC AUTHORITY       OPERATIONAL AUTHORITY      EXECUTION AUTHORITY      EXTERNAL WORLD
  (Pure Core: defines/     (conformant Runtime:       (Providers: execute,     (bank rails, chains,
   validates meaning,       enforces commitment,       report back, never       counterparties — not
   never enforces)          atomicity, ordering)       define validity)         directly observed by
                                                                                  Core)
```

Verification guarantees *change* across each boundary — they do not
simply stop. Some behavior remains independently checkable across every
boundary (§36); some becomes operationally trusted at the Runtime
boundary (§9, §36); some is merely externally asserted once it crosses
into the external world (§27, §36).

---

## 8. Pure Core Boundary

Sails Core does **not**, fundamentally:

- fetch network data or read/write a database;
- dispatch settlement or hold value;
- call providers, retry, or perform crash recovery;
- choose transport or storage;
- decide whether a ruleset's own economics are substantively fair
  (K1's "under the ruleset" is procedural, never substantive — §26);
- establish world truth from a provider's own report (§27).

It receives explicit semantic material and evaluates meaning. Precise
wording discipline, applied throughout this document: **Core rejects an
invalid candidate when evaluated against complete, authentic semantic
inputs — it does not "prevent" anything a caller chooses not to route
through it.**

## 9. Runtime Boundary

A conformant Runtime:

- assembles the committed semantic material a candidate Transition
  needs;
- establishes one authoritative ordering over whatever semantic scope
  an evaluation actually spans (§29) — not necessarily one Interaction;
- rejects stale semantic bindings before committing anything (§16, §24);
- commits an authoritative Transition Record visibly-consistent with
  the State it describes (§24);
- dispatches consequential external effects only after that commitment
  is authoritative (§28), and only while execution-validity conditions
  hold (§28);
- prevents duplicate dispatch, in cooperation with Provider-declared
  idempotency;
- preserves the semantic history needed for completeness auditing
  (§19);
- performs recovery/reconciliation without ever inventing or
  reconstructing discretionary authority (§41).

Mechanism remains entirely open: single-process, distributed,
snapshot/MVCC, or event-sourced Runtimes are all valid realizations of
this same contract (§38).

## 10. Module Boundary

Modules own domain semantics: Transition and condition definitions,
domain-specific State interpretation, Assertion type interpretation,
discretion requirements, Outcome meaning, and execution-correspondence
semantics. **A Module gains no authority merely by supplying rules** —
Core evaluates what a Module declares, but a malicious or nonconformant
Module can still violate protocol conformance (e.g., by under-declaring
what a leaf predicate actually reads, or by defining a correspondence
function that always reports a match). This is a disclosed, accepted
**Module Conformance** trust boundary, not something Core architecture
can close by construction (§19).

## 11. Provider Boundary

Providers translate an authorized Outcome into mechanism-specific
execution, execute it, and return execution-report Assertions. They
declare which of their own operations are consequential (§34) and
expose capability/finality information. Providers may **not**: decide
whether a Transition was semantically valid; invent discretionary
authority; redefine an authorized Outcome's meaning; declare their own
report to be world truth; or silently reinterpret a ruleset.

---

## 12. Condition Semantics

Four states, defined semantically, not by example:

- **SATISFIED** — the condition holds under the exact inputs evaluated.
- **NOT_YET_SATISFIED** — does not hold now, but a specific, known path
  to satisfaction remains open.
- **UNSATISFIABLE** — cannot hold for *this proposal*, evaluated against
  *this submitted input set* — never a claim about a future, differently
  scoped proposal.
- **UNKNOWN** — a required input's own resolution is itself uncertain;
  unlike NOT_YET_SATISFIED, there is no known guarantee the uncertainty
  ever resolves.

`CONFLICTED` is **not** a universal Core status. A domain ruleset that
needs to represent contradictory evidence does so using one of the four
states above, plus its own `reason` text (e.g., NOT_YET_SATISFIED,
reason: "conflicting endorsements, awaiting arbiter") — contradiction-
handling is domain semantics, not Core semantics.

## 13. Condition Algebra

**Verification note**: the composition rules below were checked for
commutativity, associativity, idempotence, monotonicity, and internal
consistency (AND and OR both reduce to the general N-of-M rule at
N=M and N=1 respectively) before being recorded here — this is
verification of an existing result, not architecture discovery
performed inside this freeze.

Total order: `UNSATISFIABLE < UNKNOWN < NOT_YET_SATISFIED < SATISFIED`.
**AND = min, OR = max** over this order.

AND:

| AND | UNSAT | UNKNOWN | NOT_YET | SAT |
|---|---|---|---|---|
| **UNSAT** | UNSAT | UNSAT | UNSAT | UNSAT |
| **UNKNOWN** | UNSAT | UNKNOWN | UNKNOWN | UNKNOWN |
| **NOT_YET** | UNSAT | UNKNOWN | NOT_YET | NOT_YET |
| **SAT** | UNSAT | UNKNOWN | NOT_YET | SAT |

OR:

| OR | UNSAT | UNKNOWN | NOT_YET | SAT |
|---|---|---|---|---|
| **UNSAT** | UNSAT | UNKNOWN | NOT_YET | SAT |
| **UNKNOWN** | UNKNOWN | UNKNOWN | NOT_YET | SAT |
| **NOT_YET** | NOT_YET | NOT_YET | NOT_YET | SAT |
| **SAT** | SAT | SAT | SAT | SAT |

**N-of-M** (threshold N over M sub-results, counts `s`=SATISFIED,
`p`=NOT_YET_SATISFIED, `k`=UNKNOWN, `f`=UNSATISFIABLE): if `s ≥ N` →
SATISFIED; else if `s+p+k < N` → UNSATISFIABLE (unreachable even
optimistically); else if `s+p ≥ N` → NOT_YET_SATISFIED (known paths
alone suffice); else → UNKNOWN (reaching N requires an uncertain slot
to resolve favorably). Deterministic and grouping-independent by
construction (a flat count, never sensitive to how a threshold
expression is parenthesized).

## 14. UNKNOWN / System-Error Boundary

**Core semantic UNKNOWN is always an output a leaf predicate produces
from a well-formed input** (including an explicit "unavailable" marker
Runtime may supply) — never Core inferring its own IO failure. Runtime
inability to assemble required input, an invalid EvaluationContext, a
missing mandatory Assertion, or an unavailable historical semantic
artifact **prevent evaluation from happening at all** — Core is simply
never invoked, and no ConditionResult of any kind is produced. An
implementation must not silently translate a Runtime assembly failure
into a semantic UNKNOWN result.

---

## 15. Semantic Binding

A **committed semantic-history position** (neutral term — no storage
representation implied) binds one evaluation to the ruleset semantics,
prior State, and admitted-Assertion history it depends on. Its purpose
is fourfold: historical interpretation, staleness detection, semantic
provenance, and completeness auditing (§19). **Not frozen**: MVCC,
database transaction IDs, Merkle trees, blockchains, event-log offsets,
or any specific hash format — all remain open, mechanism-independent
choices.

## 16. Commitment: Integrity, Equivocation, Completeness

"Commitment" is not one property — it decomposes into three, and no
single mechanism solves all three by itself.

**Content integrity**: given content and its claimed commitment
material, an independent verifier can determine whether they match,
using only information already in their possession. No global consensus
implied.

**Equivocation**: conflicting semantic resolutions for "the same"
reference must be representable in independently-comparable form, so
that when two resolutions are available to the same verifier, or are
exchanged between verifiers, their divergence can be conclusively
demonstrated. **This is a capability, not an automatic guarantee** —
classified as a Conformance/Security capability, not a Pure Core
property. A recommended practice fully realizes it using existing
architecture with no new mechanism: a party submits its own resolved
ruleset commitment as an ordinary, admitted Assertion within the
Interaction; comparing two admitted Assertions referencing the same
ruleset for differing commitments is then durable, admissible evidence
of equivocation. This is Level A (§36) — detectable when the practice is
followed, never globally or automatically detected.

**Semantic completeness**: all semantic material actually consumed by
an evaluation is bound into its resulting record. This does **not**
mean "all facts in the universe were included," and it does **not**
mean Core can detect a nonconformant Module that intentionally ignores
an admitted Assertion its own domain rules say it should have consumed
— that remains an explicit Module Conformance boundary, stated honestly,
not closed by architecture.

## 17. Ruleset Semantic Identity

A ruleset identity binds: a stable identifier, a version, a canonical
commitment representation, and the applicable shared semantic-
conformance profile (§18). Domain-specific external semantics (e.g. a
particular oracle's own data format) remain the ruleset/Module's own
responsibility, not duplicated into a shared profile. No encoding
mechanism is prescribed here.

## 18. Canonical Semantic Profile

**Architecturally required, not yet specified.** A future conformance
artifact (working name only — not approved terminology) must define,
wherever independent implementations need to agree: canonical
commitment encoding, numeric semantics, time semantics, string
normalization, ordering, identifier normalization where relevant,
cryptographic representation, and ruleset-version identity conventions.
**Distinction that must not be lost**: semantic *outputs* (a
ConditionResult, an Outcome's meaning) need only be semantically
equivalent across implementations; only the specific material that
feeds a **commitment calculation** needs exact, bit-reproducible
canonical encoding. This document does not author that profile — see
`TECHNICAL_DEBT_AUDIT.md` item 37.

---

## 19. Assertion Semantics

`SEMANTIC_KERNEL.md`'s Assertion rule (§8) is preserved verbatim and is
**not reinterpreted** by this document. Sources are classified broadly —
human, agent, provider, oracle, system — without restricting
attribution to human/participant claims only: a system-computed
observation (e.g. a protocol-maintained sequence counter) is
attributable to "the protocol/Runtime itself" as a declared source, as
long as that source is stated, not smuggled in as if from nowhere.

**Non-normative implementation note** (explicitly marked as such,
pending future specification work if ever needed, and not a
reinterpretation of the frozen rule's own wording "once submitted for
its evaluation"): a submission attempt (syntactically arrives, may be
malformed, duplicate, or out-of-scope) is distinguished from an admitted
Assertion (passes those checks). A rejected submission never achieves
Assertion status, so its rejection does not touch the Kernel's own
"becomes part of the permanent record" clause — there is nothing yet to
record. Only a genuinely internal, non-fallible value that could never
be wrong (a protocol-maintained sequence counter) may bypass Assertion
admission entirely as bare evaluation context; anything external or
fallible must be submitted and admitted as an ordinary Assertion.

**Permanent record ≠ permanent plaintext.** What must survive is the
commitment/provenance of the submission fact; raw content lifecycle
(retention, deletion, redaction, encryption) is a Runtime/security
policy question, not a Kernel-level data-retention mandate.

---

## 20. Transition Record

**One authoritative semantic record concept — not two mandatory,
separately-persisted classes.** A Transition Record represents a
K1-relevant State change, binding at minimum: Interaction scope, the
prior semantic-history position, the Transition itself, the resulting
State binding, the ruleset binding, and semantic provenance (which
material was actually consulted, per §16's completeness property).

When K2 applies, the Record additionally binds attribution evidence,
captured at the moment of decision — never re-derived later against a
possibly-changed external world (Rule 5, §32). When K3 applies, it
additionally binds the authorized Outcome.

**"Decision" is descriptive terminology for a Record that happens to
carry those additional, conditionally-present fields — it is not a
second required durable object.**

## 21. Visibility Consistency

**Semantic atomicity, stated without database language**: a Transition
Record becomes authoritative if and only if the State transition it
describes becomes authoritative at the same committed semantic-history
position. This is satisfiable by a single database transaction, an
event-sourced log (trivially, since one write serves both views),
two-phase commit, or a single ordered append-only entry — no mechanism
is privileged.

---

## 22. Outcome Semantics

Outcome is **conditional** — not every Transition produces one (K3
activates only "when a transition authorizes an economic outcome").
When it applies: the Outcome has stable semantic identity, its meaning
is ruleset-bound, and execution correspondence is evaluated against
that same meaning. **Content may remain opaque to generic Core.**

**Explicitly not resurrected**: a mandatory `EconomicEffect` anchor
type, and a mandatory `relationGroup` cross-effect structure. Both were
tested as candidate corrections and found unnecessary: a partial
execution report against a multi-leg authorization simply fails
correspondence unless the ruleset's own function explicitly permits
partial fulfillment — atomicity-of-meaning is already fully covered by
the correspondence mechanism (§23) without any additional Core-level
structure.

## 23. Economic Specificity

Sails Core's bare machinery — pure evaluation over opaque, ruleset-
interpreted content — is, by itself, reusable outside economic domains,
the same way a general-purpose database engine is reusable outside
banking. **This is not a defect and is not treated as one.** Sails
Protocol is economic because of the semantics and conformant Modules/
rulesets it actually coordinates — not because Pure Core mathematically
proves a payload represents scarcity. No economic type-checker is built
into Core, and none is recommended for the future. This is not, and
must never be read as, a novelty or superiority claim.

## 24. Execution Correspondence & ExecutionReport

An Outcome's meaning is fixed before execution. A **provider execution
report is an Assertion, never world truth** — Evidence ≠ Truth,
preserved exactly as the Kernel's own Assertion rule requires. Core may
establish that a reported execution *corresponds* to the authorized
Outcome; it may never establish, merely from that report, that the
external world definitely behaved as claimed. The ruleset/Module defines
correspondence semantics as a committed, ruleset-bound function; Core
invokes it consistently. **A Provider never supplies its own
correspondence truth for its own execution** — this boundary is
absolute, not a matter of degree.

## 25. Execution Validity Scope

A committed Outcome may be dispatched only while its own declared
execution-validity conditions remain satisfied. Representation is not
frozen — a deadline, a validity interval, an execution precondition, a
ruleset-defined predicate, or an explicit unbounded declaration are all
valid realizations.

**Re-check rule**: checking execution validity at dispatch time is
**not** a full re-run of the original Transition evaluation — the
original authorization is permanent (§20). It is a narrow, targeted
evaluation of only the specific, already-declared execution-validity
predicate. A pass allows dispatch to proceed unchanged; a fail triggers
the ruleset's own declared fallback. **This check never creates a new
Decision.** An Outcome containing execution-time-relative semantics
(e.g. "transfer the market-value equivalent of X at execution time") is
K3-compliant only if the pricing *rule* itself was part of what was
authorized at decision time — a Provider applies that rule using
externally-submitted data (an ordinary Assertion), it never supplies its
own interpretation of the rule. **Valid Decision ≠ eternally executable
Decision.**

## 26. Ordering / Concurrency

Core requires **no** dependency-set declaration, read/write-set model,
MVCC, optimistic concurrency, or fine-grained locking. Coarse
serialization over the relevant semantic scope, combined with stale-
binding rejection (§16), is fully sufficient for correctness — fine-
grained concurrency is available only as an optional Runtime
performance optimization, never a Core architecture requirement.

Ordering scope is **not** frozen as "one Interaction" — some semantics
span shared collateral, liquidity, reputation, or global limits across
Interactions. The generic property: a conformant Runtime establishes
authoritative ordering over whatever semantic scope an evaluation's
binding actually spans, which may exceed one Interaction. Mechanism
remains open.

## 27. Introspection Boundary

Core's minimum obligation is **candidate validation/evaluation only** —
`validate(candidate) → ConditionResult` (plus Outcome, when applicable).
Schema introspection, state-aware action enumeration, and consequence
preview are **not** Core architecture — they remain fully possible as
SDK, reference-UX, agent-adapter, or Module-metadata layers, built on
top of repeated validation calls and Module-declared metadata.
**SDK/UX usefulness ≠ Core necessity** — this does not foreclose a rich,
future machine-readable semantic surface; it keeps that surface out of
Core.

---

## 28. Semantic Roles

No magic concept count is frozen. Instead, roles are classified by
whether they are load-bearing:

**Unconditionally required**: Interaction (as scope, not necessarily an
object — §29), Ruleset, State, Transition, Assertion.

**Conditionally required**: Actor / attribution material — only when K2
applies (a deterministic timeout needs none); Outcome — only when K3
applies.

**Representational conveniences** (useful, not semantically mandatory as
independent types): TransitionCondition (could be a field of Transition);
Role (folds fully into a ruleset-evaluated leaf predicate — "does Actor
X currently hold Role R" is itself an ordinary evaluated condition, not
a separate permission-table concept).

**Derived / call-shape convention** (no persistent identity of its own):
EvaluationContext — the bounded set of committed material one evaluation
call needs, entirely determined by the roles above.

These are semantic roles an implementation must account for — never
mandatory classes, database tables, packages, or wire types.

## 29. Interaction as Scope

Interaction may be realized as a mere scope/namespace rather than a
first-class persisted object — what is required is a semantic scope
binding a ruleset, State, and Assertion history together, not
objecthood.

---

## 30. Final Architecture Rules

Nine rules — smaller than an earlier eleven-rule candidate, reflecting
genuine removal, not forced symmetry. Discovery-phase labels (D1–D7,
SR-*, MC-*) are deliberately not reproduced here; they belong to the
process that found these rules, not to the rules themselves.

| # | Rule | Source | Failure if removed | Layer |
|---|---|---|---|---|
| 1 | A Transition Record is bound to the exact semantic-history position it was evaluated against | K1 + completeness (§16, §19) | Silent substitution or omission becomes undetectable | Core + Runtime |
| 2 | No consequential external effect is dispatched before its Record is durably, visibly committed with the State it authorizes | K1 / K2 | Orphaned or duplicated authority on crash | Core + Runtime |
| 3 | A committed Record is never edited; corrections are new, validly-evaluated Transitions | K1 "never silently," K2 attributability | Silent historical rewrite | Core + Runtime |
| 4 | Provider execution never defines semantic validity or redefines an authorized Outcome's meaning | K1 / K3 | Provider-defined economics | Provider + Core |
| 5 | Attribution evidence relied upon at decision time is captured then, never re-derived later against a possibly-changed external world | K2 | Unreconstructible historical authority | Core + Runtime |
| 6 | A ruleset identifier resolves to semantically immutable content, sharing one canonical execution-semantics profile | K1 historical interpretation, independent implementability | Cross-language / cross-time divergence | Core + conformance spec |
| 7 | Commitment material uses canonical, exactly-reproducible encoding; semantic outputs need only be semantically equivalent | Independent implementability | False divergence between conformant implementations | Core + conformance spec |
| 8 | A committed Outcome may be dispatched only while its declared execution-validity conditions hold, checked as a narrow targeted predicate, never a full re-run | K1 / K3 meaning-preservation under delay | Stale or economically absurd late execution | Core + Runtime |
| 9 | Core never fetches its own inputs, persists state, dispatches effects, or judges a ruleset's own substantive economics | Definitional to Pure Core + K1 "under the ruleset" | Core overreach; enables malicious-Runtime behavior | Core |

## 31. Core Responsibility Areas

Four conceptual areas — **not** packages, classes, services,
repositories, or microservices; a future implementation may map them
differently provided it remains conformant:

1. **Semantic Model & Commitment Resolution**
2. **Transition Evaluation & Outcome Derivation**
3. **Attribution**
4. **Assertion Admission & Correction**

## 32. Conceptual Core Operations

Capabilities only — no function names, no interfaces, no public API:

- evaluate a proposed Transition;
- evaluate discretionary attribution, when K2 applies;
- admit/validate an Assertion under Interaction semantics;
- derive an authorized Outcome, when K3 applies;
- evaluate execution correspondence, when applicable.

## 33. Core I/O Compression

```
Committed Semantic Material
    +
Candidate Transition
        ↓
Transition Evaluation
        ↓
Authoritative Transition Record
    (+ attribution material, when K2 applies)
    (+ authorized Outcome, when K3 applies)
```

```
Authorized Outcome
    +
Execution Assertion
        ↓
Correspondence Evaluation
```

Runtime makes the Record authoritative; Pure Core evaluates and produces
the semantic result — it never makes anything authoritative itself.

---

## 34. Consequential External Effect

Freezing a principle, not a provider lookup table: an external operation
is consequential when it creates a persistent economic cost, lock, or
obligation that would remain, or require active reversal, even if the
corresponding authorization were never made authoritative. **Each
Provider classifies its own operations under this shared principle** as
part of its own capability declaration — Core does not maintain, and
this document does not attempt, a per-rail classification table.

## 35. Level A / Level B

| Failure | Classification | Layer |
|---|---|---|
| Ruleset substitution | Detectable (content integrity) | Core + Runtime |
| Equivocation | Conditionally detectable — only if the submitted-commitment practice (§16) is followed | Runtime + Counterparty |
| Assertion omission | Detectable (completeness, §16) | Core + Runtime |
| Stale proposal | **Prevented** (pre-commit rejection, §16) | Runtime |
| Duplicate execution | Prevented, if Runtime/Provider honor idempotency; else detectable after the fact | Runtime + Provider |
| Outcome divergence | Detectable, never prevented (§24) | Core |
| Provider lie (plausible report) | Neither — undetectable at Core level; disclosed limit | Provider (trust boundary) |
| Runtime lie (forged inputs, no cross-check) | Detectable only if a counterparty independently checks | Runtime (trust boundary) |

Exactly one genuine Level B (mechanically prevented) case exists in this
architecture — everything else is Level A (independently detectable
given the required evidence/checking) or an explicitly disclosed trust
boundary. No claim here should ever be read as broader than this table
states.

## 36. Independent Implementation Expectations

Two independent implementations, given equivalent committed semantic
material, **must** derive semantically equivalent: Transition validity,
ConditionResult, attribution result (when applicable), Outcome meaning
(when applicable), execution correspondence, and historical ruleset
interpretation. They **need not** share: storage engine, programming
language, object taxonomy, database, event model, method names, package
structure, concurrency strategy, or SDK introspection surface. Achieving
this depends on adopting the Canonical Semantic Profile (§18) — without
it, cross-language commitment-equivalence claims are not supportable.

## 37. Representation Independence

Snapshot/MVCC, event-sourced, single-process, and distributed Runtimes
are all valid conformant realizations of this architecture — none is
excluded by Core semantics, though they are not claimed equally easy to
build.

## 38. Rail Independence

Core semantics do not fundamentally depend on Bitcoin, Lightning, EVM,
bank rails, wallets, or blockchains — these are Module/Provider
implementation choices. No rail may redefine semantic validity.

## 39. Authority Independence

Core supports semantics compatible with deterministic conditions, mutual
consent, discretionary human authority, scoped delegated authority,
threshold authority, and cryptographic/ex-ante conditions. K2 activates
specifically when discretion exists — authorization is never reduced
universally to actor signatures.

## 40. Recovery Boundary

Preserved from Mission 11: **reconstruct execution ≠ reconstruct
authority.** Recovery is not Semantic Kernel identity (`SEMANTIC_KERNEL.md`
§14). A Runtime may recover and reconcile execution state; it must never
fabricate a historical discretionary authorization that was never made.

## 41. UX / AI Relation

UX and AI **consume** Core semantics; neither **is** Core. The same
semantic surface (State, valid actions, economic consequences, authority
requirements, Assertion/evidence requirements, ruleset/version,
uncertainty, finality) is intended to serve human-facing UX, AI/agents,
SDK integrators, and other protocol Modules identically, rather than
each inventing a partial view — this is architectural direction, not a
claim that such a surface exists today. An AI may consume Assertions and
reason about protocol state; an AI's recommendation is never
automatically truth, a protocol rule, or economic authority. QVAC's
current advisory-only status for disputed MULTISIG settlement
(`SEMANTIC_KERNEL.md` §16) is the concrete, already-shipped instance of
this principle and is unchanged by this document.

## 42. Security Claim Discipline

This document makes none of the following claims, and none should ever
be read into it: a trustless Runtime; a trustless Provider; world-truth
verification; global non-equivocation; cryptographic prevention of all
divergence; production readiness; formal verification; institutional-
grade security; audited status; or complete multi-rail conformance.
Every guarantee stated above is qualified by its actual layer (§35) and
its actual precondition (e.g. "if the practice in §16 is followed").

---

## 43. Current Implementation Conformance Mapping

> **Corrected/Implemented 2026-11-27 (historical delimitation):** sections 43 and 44 are freeze-time records, dated by the correction in section 2, and predate the current package layout (`packages/sails-core` and the other workspace packages). Rows that read "missing", "absent" or "not yet applicable" describe that moment; several have since changed (for example the transition record, `docs/CORE_TRANSITION_RECORD.md`, and the Condition Algebra vector set, `docs/CONDITION_ALGEBRA_CONFORMANCE_EVIDENCE.md`, where vectors are evidence and not certification and not a second independent implementation). They are not re-evaluated here, and the newer evidence records govern.

Evidence-based, not aspirational. This does not restructure or fix
anything — it records where the current repository already stands
relative to this frozen architecture, for the next implementation
program to use as a starting point.

| Area | Status | Evidence |
|---|---|---|
| State machine (Trade/Escrow/Dispute status enums, valid-transition gating) | PARTIAL | Gating logic already resembles Transition evaluation; no self-contained Transition Record artifact with semantic-history-position binding exists yet |
| Ruleset / version identity | MISSING | No explicit interaction-scoped ruleset-version identity mechanism exists (`SEMANTIC_KERNEL.md` §23, Technical Debt items 34/35) |
| Authority path (`arbitration-authority.ts`, `dispute.service.ts` `resolveDispute()`) | ALIGNED | Already a pure-function-shaped, decision-time-evidence-capturing pattern matching Attribution's required shape, for MULTISIG |
| Assertion / evidence handling (`proof.service.ts`, `evidence[]`) | PARTIAL | Append-only intent exists; no admission-validity layer, no commitment-based content-integrity, no formal type taxonomy |
| Settlement / providers (`SettlementProvider` interface) | ALIGNED | Capability-declaration shape already closely matches the Provider boundary (§11) |
| Mission 11 recovery discipline | PARTIAL | "Reconstruct execution ≠ reconstruct authority" is understood and partially implemented; no formal Decision-before-dispatch persistence artifact exists as such |
| Mission 13 signed authority decisions | ALIGNED | Directly matches the Attribution area's required shape, for MULTISIG |
| QVAC advisory-only path | ALIGNED | Directly matches §41 — AI recommendation is an Assertion, never authority |
| SDK | NOT YET APPLICABLE | A future Core semantic surface does not yet exist for the SDK to conform against |
| Event Bus (`PostgresEventStore`) | PARTIAL | Durability pattern reusable; content model would need rework for the commitment discipline (§16) |
| Current persistence layer (Prisma/Postgres schema) | MISSING | No commitment, ruleset-version, or semantic-history-position fields exist anywhere in the current schema |

## 44. Implementation Gap Register

> **Corrected/Implemented 2026-11-27:** G1-G15 are the gaps identified at freeze time. Their "Current state" column is historical and some entries have since been addressed or partly addressed; this register is not a current backlog and is not re-evaluated here.

Bounded evidence for the next program, not a backlog to solve here.

| ID | Architecture requirement | Current state | Severity | Dependency |
|---|---|---|---|---|
| G1 | Ruleset identity/version-binding mechanism (§17) | Absent | High | Canonical Semantic Profile (G2) |
| G2 | Canonical Semantic Profile authored (§18) | Absent | High | None — blocking cross-language conformance |
| G3 | Transition Record / Decision artifact (§20) | Absent — raw status updates only | High | G1 |
| G4 | Commitment/content-integrity mechanism for State/ruleset/Assertion references (§16) | Absent | High | G2 |
| G5 | Execution-validity-scope field on authorized Outcomes (§25) | Absent | Medium | G3 |
| G6 | Four-state ConditionResult model (§12) | Ad hoc booleans/exceptions | Medium | None |
| G7 | Assertion admission-validity layer (§19) | Scattered, not unified | Medium | None |
| G8 | Attribution decision-time evidence capture, generalized beyond MULTISIG | MULTISIG-only (Technical Debt item 36) | Medium | None |
| G9 | Opaque-Outcome + ruleset-bound correspondence-function abstraction (§22, §24) | Only `buyerBps`-style SPLIT disposition exists | Medium | G1 |
| G10 | Cross-language/cross-implementation conformance vectors | None exist | Medium | G2 |
| G11 | Equivocation-evidence practice (submit resolved ruleset commitment as Assertion, §16) | Not applicable — ruleset commitments do not yet exist | Low | G1 |
| G12 | Semantic-completeness auditing (consulted vs. admitted Assertions, §16) | Not implemented | Low | G3 |
| G13 | Joint symmetric multi-ruleset ownership of one Interaction | Open architecture question, no current need | Low | Non-blocking |
| G14 | Ordering/concurrency as a stated semantic-scope property (§26) | Implicit at DB-transaction level | Low | None |
| G15 | Explicit Core/Runtime interface boundary in code | Core-shaped logic embedded directly in service classes | Medium | G3 |

---

## 45. Implementation Handoff

**What is now frozen**: the macro architecture (§7); the nine rules
(§30); the four responsibility areas (§31); the condition algebra
(§12–14); the semantic-role classification (§28); the Transition
Record/Outcome models (§20, §22); the trust-boundary framing (§35–36).

**What remains open**: Canonical Semantic Profile content (§18);
commitment mechanism selection (§16); package topology; programming
language; storage engine; provider choices; joint multi-ruleset
ownership (G13).

**What implementation may choose freely**: storage engine; event-sourced
vs. snapshot Runtime; concurrency granularity beyond the stated minimum
(§26); package structure; SDK method names; serialization formats
except for commitment material (§18).

**What implementation must never violate**: the nine rules (§30); K1,
K2, K3, and the Assertion rule; the conformance-layer distinction
between Core conformance and Full Protocol conformance (§9, §16); no
mandatory economic-anchor type-checker (§23); no mandatory dependency-
set or introspection machinery re-added without a new, evidenced
counterexample.

**Artifacts that must be designed next**: the Canonical Semantic Profile
specification; a concrete ruleset-commitment mechanism; a concrete
Transition Record representation; a conformance test-vector suite.

**Tests required before a Core implementation may be considered
conformant**: four-state condition algebra tests (§12–13); N-of-M
threshold tests; stale-binding rejection tests; Decision-before-dispatch
atomicity tests (§21); correspondence-check divergence-detection tests
(§24); cross-implementation semantic-equivalence tests, once a second
implementation exists (§36).

## 46. Handoff Decision Register

| Question | Status | Owner layer | When decided |
|---|---|---|---|
| Pure Core macro architecture | FROZEN | Architecture | Now |
| Four-state condition algebra | FROZEN | Architecture | Now |
| Nine architecture rules | FROZEN | Architecture | Now |
| Canonical Semantic Profile content | OPEN | Conformance Specification | Implementation Architecture |
| Ruleset commitment mechanism | OPEN | Conformance Specification | Implementation Architecture |
| Transition Record concrete representation | OPEN | Implementation Architecture | Implementation Architecture |
| Package topology | OPEN | Implementation | Later |
| Programming language / storage engine | FREE | Runtime | Implementation |
| Settlement provider choice | FREE | Provider | Implementation |
| Joint multi-ruleset ownership | OPEN (non-blocking) | Core design | Later, only if a real need emerges |

## 47. Open Questions Carried Forward

**Answered, 2026-08-29, by `docs/CORE_IMPLEMENTATION_ARCHITECTURE.md`** —
the frozen representation, boundary, and migration design for actually
building the Core described here. That document does not change
anything written in this one; it is evaluated against this Core
Architecture like any other part of the system, not assumed to already
satisfy it. The questions below are preserved as the record of what was
open before that derivation, not reopened by this note.

None of these block this freeze; each is classified so a future engineer
does not mistake an open implementation choice for architectural
uncertainty. See §46 for ownership and timing.

## 48. Explicit Non-Goals

This document does not claim: that the later `@sails/core` implementation
fully conforms to this architecture; formal verification; novelty or
priority over any other system; production readiness; completed security
audit; or that this freeze itself authorized code, schema, migration,
dependency, or package creation. At freeze time `@sails/core` did not yet
exist. Its later creation by an authorized implementation program does not
retroactively change this document's provenance and does not make the
package synonymous with Runtime, Modules, Providers, or Sails Protocol as a
whole.
