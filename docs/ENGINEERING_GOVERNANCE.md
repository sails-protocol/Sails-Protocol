# ENGINEERING_GOVERNANCE.md

> **Sails Protocol — Engineering Operating System, Document 1 of 2**
> (companion: `docs/GITHUB_PROJECT.md`). Written during Mission 9.9,
> 2026-08-31, following the Mission 9 Recovery Baseline freeze
> (`b0c581dd26281f230a3795dfdaa48412574ea5c1`). This document exists so
> a future human or AI contributor can join Sails and know **why** the
> process exists, **who** decides what, and **when to STOP** — without
> re-deriving it from git history or a chat transcript.
>
> **This document = why / authority / gates / methodology.**
> `CONTRIBUTING.md` = how a contributor works day-to-day.
> `docs/GOVERNANCE.md` = how the protocol *specification itself* changes
> (the RFC process) — this document does not duplicate it, only connects
> it to day-to-day Issue/PR mechanics.
> `docs/GITHUB_PROJECT.md` = GitHub Project governance/configuration model and dated program-state snapshots; the live GitHub Project owns current operational state.
>
> One canonical source per concept. If you find the same rule stated
> differently in two places, that is a bug in this documentation — file
> it as such.
>
> **Engineering institutional context:** `docs/engineering/README.md` routes the
> philosophy, principles, methodology and intellectual references that explain
> how this engineering system emerged. Those documents provide context and
> judgment criteria; this file remains the authority for repository engineering
> governance and gates.

---

## 1. The Central Governance Principle

> **Anyone may challenge the architecture. No one may silently redefine it.**

Seniority does not grant unilateral architectural authority — not for a
human, not for an AI agent, not for the original author of the code being
changed. A contributor may challenge an existing decision at any time, by
providing:

- the problem;
- a counterexample, where one applies;
- the property to be gained;
- the property potentially sacrificed;
- architectural, protocol, security, privacy, UX, and compatibility impact;
- evidence;
- migration consequences;
- a proposed validation strategy.

**Preference is not evidence. Seniority is not evidence. Familiarity is
not evidence. Framework preference is not architecture.**

> **Experience grants the right to challenge a decision, not the right to
> bypass the process that protects it.**

A strong counterexample can override an old design — see §8, "Architecture
Change Process." The architecture is not sacred. The process is.

---

## 2. Repository, Project, Issue, PR — the mental model

- **Repository explains the architecture.** `docs/`, `rfcs/`, the code
  itself, and this file are the durable record of *what Sails is and why*.
- **GitHub Project explains the work.** What's being done right now, by
  whom, in what order — operational, not architectural memory. See
  `docs/GITHUB_PROJECT.md`.
- **Issues define executable units of work.**
- **Pull Requests provide evidence of change.**

**Canonical protocol truth must never live exclusively inside a GitHub
Project card.** A Project field can say an item is "Done"; only the
repository (code + docs + tests) can say what "done" actually means. If
the two disagree, the repository wins.

---

## 3. The BY-DESIGN Model

Sails does not evolve as a hand-off chain (Product → Developer implements
→ UX fixes later → Security reviews later). Every discipline constrains
every other discipline from the start of a change, not at the end of it:

```
                    Product Intent
                         │
                         ▼
                 Economic Meaning
                         │
                         ▼
              Protocol / Architecture
                   /           \
                  /             \
             Security         UX / Human Meaning
                  \             /
                   \           /
                    Engineering
                         │
                         ▼
                      Evidence
```

Product, Protocol, Architecture, Security, Privacy, UX/UI, Engineering,
Testing, and Evidence are not sequential silos with a handoff between
them — they are constraints that apply simultaneously to the same
proposed change. A change that satisfies Engineering but violates a
Security assumption is not "done, pending a security pass" — it is not
done.

### 3.1 Authority by discipline

| Discipline | Determines |
|---|---|
| **Product Direction** | what problem matters, user value, prioritization, roadmap direction, product constraints, desired experience, ecosystem strategy |
| **Protocol / Architecture** | semantic boundaries, invariants, authority, states, transitions, compatibility, evidence requirements, architectural constraints |
| **Engineering** | implementation within the authorized architecture, implementation trade-offs that do not alter frozen semantics, technical execution, tests, observability, maintainability |
| **UX/UI** (BY DESIGN, not a beautification pass) | state legibility, action legibility, authority legibility, uncertainty preservation, recovery continuity, progressive technical disclosure, privacy legibility |
| **Security / Privacy** (BY DESIGN wherever a change can alter authority, value movement, trust assumptions, disclosure, identity, correlation, recovery, or external execution) | consequence analysis, adversarial behavior |

This is not an authoritarian model — no discipline has unilateral veto
over another's domain. It is an explicit model: a change that touches
authority or value movement **requires** Security's constraint to be
considered before merge, the same way a change to human-visible state
**requires** UX's constraint to be considered — "requires considering,"
not "requires sign-off from a person with that job title," since Sails
does not yet have dedicated headcount for every discipline. See §7 for
who actually fills these roles today.

### 3.2 Protocol UX by design (preserved, not designed here)

```
Protocol State → Human Meaning → User Action
```

A Reference UI must not invent the protocol; it must make the protocol
understandable. Relevant principles, unchanged from prior sessions and
not redesigned here: **State Legibility, Action Legibility, Authority
Legibility, Uncertainty Preservation, Recovery Continuity, Progressive
Technical Disclosure.** This mission does not implement a Reference UI —
it ensures the Issue/PR workflow (§9, `.github/PULL_REQUEST_TEMPLATE.md`)
asks for UX impact early whenever a change affects human-visible
semantics, so UX consideration is not deferred to a "polish" phase.

---

## 4. Consequence-Weighted Development

> **The cheaper the consequence of being wrong, the earlier reality can
> participate. The more irreversible the consequence, the earlier
> semantics and invariants must constrain implementation.**

| Consequence class | Required order |
|---|---|
| Reversible UI / product surface | A running candidate can come early — build, look at it, iterate |
| Shared application semantics (cross-module contracts, event shapes) | Hybrid — design and implementation proceed together, checked against `CONTRIBUTING.md`'s Four-Layer Rule |
| Protocol semantics (a primitive, an Intent type, a module boundary) | Specification first — an RFC (`docs/GOVERNANCE.md` §5) before implementation |
| Financial authority / value movement (settlement, signing, destination, recovery) | Invariant → architecture → implementation → adversarial validation → evidence, in that order, every time |

This is not a slogan — it is what determines Definition of Ready (§5),
which Issue template applies (`docs/GITHUB_PROJECT.md` §Issue Taxonomy),
and how much of the PR template (§9) is required versus "N/A."

`docs/GOVERNANCE.md` §3 already has a real, working instance of this
table — the "What Requires an RFC" list. That table is the authoritative
one for protocol-specification changes specifically; this section
generalizes the same reasoning to engineering work that never touches
the spec at all (a UI change, a test, an internal refactor).


### 4.1 Economically Critical Production Readiness

For behavior that can affect settlement, signing, balances or accounting,
authorization, value release, recovery, fees, or any other economic authority,
**green CI is necessary evidence, not production-readiness authority**. The same
is true of a passing test suite, completed human review, or AI-assisted review.

> **PATCH PASSES TESTS ≠ ECONOMIC SAFETY PROVEN.**

Production readiness for economically critical behavior requires evidence
proportionate to the consequence of failure. Where applicable, that evidence
includes:

- explicit economic and security invariants;
- adversarial validation designed to *falsify* those invariants, not merely
  confirm the intended happy path;
- failure-path, concurrency, restart, and recovery evidence;
- defense in depth and blast-radius containment, so failure of one control does
  not automatically become catastrophic economic loss;
- independent review or independent evidence appropriate to the consequence of
  failure; and
- an explicit STOP when the intended property cannot actually be demonstrated,
  even when CI remains green.

A fix to economically critical code is itself a new security-sensitive change.
Closing vulnerability A does not establish that the patch did not introduce
vulnerability B. The patched behavior therefore receives scrutiny proportional
to its potential consequence, including adversarial testing of the patch's new
assumptions and failure modes.

**AI-specific boundary.** AI review is an engineering instrument, not a
security or economic certification authority. Claude, GPT, or any other AI may
investigate, implement, review, generate tests, and gather evidence; agreement
among AI agents does not itself establish correctness. Authority remains with
the architecture, explicit invariants, reproducible evidence, adversarial
validation, and the established CTO/human merge gate. This specializes §7 for
economically critical work; it does not create a parallel AI process.

This section reinforces §6's existing rules — **Correct STOP > Artificial
PASS** and **Do not optimize for passing the gate. Make the gate difficult to
fool.** It also complements
`docs/PROTOCOL_INVARIANTS.md` §"Conformance Is Not \"Tests Pass\"": that
section owns protocol-conformance truth; this section owns the
engineering/production-readiness gate. Neither substitutes for the other.

**Institutional lesson, not imported architecture.** This clarification was
motivated in part by Blockstream's September 23, 2026 *Liquid Network Security
Incident Assessment*. The report describes a consensus-critical rangeproof
verification-cache defect, a remediation for an earlier cache defect that
introduced a distinct byte-boundary failure mode not caught by multiple review
streams, and a downstream peg-out control path whose insufficient operational
containment allowed accepted unbacked LBTC to become a much larger reserve
loss. Sails adopts the general engineering lesson — critical patches need
adversarial evidence and independent containment layers — not Liquid's
architecture, consensus model, or incident-response design.

Reference:
https://blog.blockstream.com/liquid-network-security-incident-assessment/

---

## 5. Definition of Ready

An Issue does not become **Ready** merely because someone wants to code
it. Requirements are **consequence-weighted** (§4) — a documentation typo
does not require the ceremony a settlement-authority change requires.

**Every Issue, minimum bar:**
- the problem is stated;
- the desired property is stated;
- scope is defined (what's in, what's explicitly out).

**Additionally, for Shared-application-semantics work and above:**
- dependencies identified;
- canonical docs linked (which doc this touches or must update);
- acceptance criteria defined;
- evidence requirement defined (what proves this is done — see §11).

**Additionally, for Protocol-semantics work and above:**
- invariants potentially affected identified (`docs/PROTOCOL_INVARIANTS.md`);
- an RFC exists or is explicitly not required, with the reason stated
  (`docs/GOVERNANCE.md` §3's table);
- security/privacy/economic consequence classified.

**Additionally, for Financial-authority work:**
- STOP conditions defined in advance (§6);
- the adversarial validation strategy is stated before implementation
  begins, not retrofitted after.

---

## 6. STOP Gates

> **Correct STOP > Artificial PASS.**
> **Do not optimize for passing the gate. Make the gate difficult to fool.**

STOP is a successful engineering outcome, not a failure. A contributor
**must** STOP — pause, document, and escalate rather than push through —
when, for example:

- implementation requires changing a frozen invariant
  (`docs/PROTOCOL_INVARIANTS.md`);
- implementation exposes a missing semantic rule;
- evidence contradicts the architecture;
- required authority is not defined;
- a security property depends on an assumption not in the model;
- tests pass but the real, intended property is not actually satisfied;
- scope expansion has become architectural redesign;
- a required external fact (chain state, a signature, a durable record)
  cannot be established;
- the repository baseline is invalid (dirty tree, `HEAD != origin/main`,
  unexpected diff);
- migration consequences for protocol-sensitive behavior are unknown.

A STOP is recorded — in the Issue, in the PR, or as a new Issue if none
existed — stating what was found and why proceeding would have been
unsafe. It is never silently absorbed into "I decided to do it a
different way" without the reasoning being visible to the next reader.

This is not new to Sails — every Mission 9 sub-mission (M9-R, M8-RF,
M9-F, M9-EI, M9-TC) used exactly this discipline, and the M9 Final Freeze
report is the concrete, checked-in example of what "evidence-bounded, STOP
where warranted" looks like in practice. This document names the pattern
so a future contributor does not have to reconstruct it from those reports.

---

## 7. Human + AI Contributor Model

The governance in this document applies identically to human and AI
contributors. There is no parallel, lighter process for AI-generated work.

> **AI generation ≠ permission. AI recommendation ≠ economic authority.
> AI implementation ≠ architectural approval.**

AI-generated work — whether from an interactive session or an autonomous
agent — must satisfy the same Issue scope, the same architecture
boundaries, the same tests, the same evidence requirements, and the same
STOP gates as human-authored work, before a human reviewer merges it. An
AI agent does not receive special standing to bypass §1's central
principle; a challenge it raises is evaluated on the evidence it presents,
exactly like a human's.

**Who fills the disciplinary roles today (§3.1), stated plainly, not
aspirationally:** Sails does not yet have dedicated headcount per
discipline. The repository owner (`alan-schramm`) holds Product Direction
and final merge authority; a second collaborator (`renipinto`) holds
write access and participates in engineering/infrastructure work; AI
sessions (Claude Code and others) do a substantial share of
implementation, architecture investigation, and evidence-gathering under
this same governance, always subject to human review before merge. This
is disclosed here rather than implied by an org chart that does not
exist — see `docs/GITHUB_PROJECT.md`'s CODEOWNERS discussion for the
concrete, current reviewer configuration.

---

## 8. Architecture Change Process

**This is not a new process.** `docs/GOVERNANCE.md` §5 (the RFC process)
already is the Architecture Change Process for anything that meets its
§3 table's bar (a new primitive, a new module, a new Intent type, a
change to `PRINCIPLES.md`). This section exists only to state, in one
place, the questions a proposal should answer before it's written up as
an RFC or a Core-RFC (`docs/GOVERNANCE.md` §6A) — a pre-flight checklist,
not a second, competing process:

1. What is wrong or insufficient? Can it be reproduced?
2. What property is missing?
3. What current property might be sacrificed?
4. Is this Core / Protocol / Runtime / Provider / SDK / UX?
5. Does it affect authority (`INV-01`, `INV-02`, `INV-12`)?
6. Does it affect economic meaning?
7. Does it affect security or privacy?
8. Does it affect compatibility?
9. What alternatives were considered?
10. What evidence would falsify the proposal?
11. What tests/experiments are required?
12. What docs/invariants would need revision?
13. Is migration required?
14. What is the STOP condition if the answer to any of the above is
    "unknown"?

A change that clears `docs/GOVERNANCE.md` §3's table as **not** requiring
an RFC (an adapter, a bug fix, a typo, an additive event) does not need
this checklist either — see §4's consequence weighting.

---

## 8A. External Capability Evolution Policy (2026-09-07)

**Institutional gap this section closes, confirmed by direct inspection,
not assumed:** `.github/dependabot.yml` already discovers dependency
updates weekly. Its own Mission 9.10 comment states an explicit rule —
**"any package touching signing, key material, hashing, or Bitcoin/EVM
transaction construction must never be added to a [group] pattern"** —
covering, by that description, `@noble/curves`, `@noble/hashes`,
`sodium-native`, `tweetnacl*`, `bitcoinjs-lib`, `bip32`, `ecpair`,
`tiny-secp256k1`, `@aws-sdk/client-kms`, and (transitively, via
`@tetherto/wdk-wallet-evm`/`SAFE_GUARD_EVM`) `ethers`. Separately, as a
mechanical consequence of the six group patterns currently defined
(`tooling`, `testing`, `storybook`, `infrastructure`, `fastify`,
`ui-tooling`) — not because the config declares them crypto-sensitive —
`@qvac/sdk`, `@tetherto/wdk-wallet-evm`, `@arkade-os/sdk`, `hyperdht`,
and `hyperswarm` also currently match no group and are opened
individually today. Precision matters here: **do not read Dependabot's
config as explicitly classifying every one of these packages as
"crypto-sensitive"** — only the first list is covered by the config's
own stated rule; the second list is ungrouped as a side effect of the
current pattern set, which could change if a future pattern were added
without re-deciding this rule first (the comment's own warning). Either
way, every package above opens as its own individual PR today, and
branch protection (`GITHUB_PROJECT.md` §8) already requires human
review before any of them merges. That is real, working **discovery**
(periodic awareness that something changed — see Triggers below, not
itself a review) and **review gating**. What does not exist anywhere in
this repository: a rule for **deciding whether to actually adopt** what
a dependency update offers. This section is that rule — it does not
touch Dependabot's configuration or branch protection, both already
sufficient for their own job.

### Canonical principle

> **CONTINUOUS AWARENESS, DELIBERATE ADOPTION.**
> **ADOPT CAPABILITIES, NOT VERSIONS.**

A newer version is never, by itself, a reason to upgrade. A capability,
a security property, a compatibility requirement, an operational
improvement, or a necessary ecosystem evolution may justify it. This
generalizes, to every external dependency, the same discipline
Principle 6 (`PRINCIPLES.md`, "Infrastructure Neutral") already applies
to settlement/transport providers: **external dependencies remain
implementation/capability providers, never accidental protocol truth.**

> **EXTERNAL SDK VERSION ≠ SAILS PROTOCOL VERSION.**
> **PROVIDER EVOLUTION ≠ SEMANTIC AUTHORITY.**

### Scope

Applies to any dependency whose evolution could plausibly affect a
Sails property, not a comprehensive vendor registry (one is not created
by this section). At minimum: QVAC (`@qvac/sdk`, local-inference agent
capabilities, RFC-016/RFC-017's boundary), WDK (`@tetherto/wdk-wallet-evm`,
`WDK_USDT_EVM` settlement), Pears/HyperDHT/Hyperswarm (`TransportProvider`,
Principle 6), Ark/Arkade (`@arkade-os/sdk`, `LIGHTNING_HODL` settlement),
Bitcoin libraries (`bitcoinjs-lib`, `bip32`, `ecpair`, `tiny-secp256k1`,
`MULTISIG` settlement), EVM libraries (`ethers`, transitively via
`@tetherto/wdk-wallet-evm`/`SAFE_GUARD_EVM`), crypto-primitive libraries
(`@noble/curves`, `@noble/hashes`, `sodium-native`, `tweetnacl*`),
`@aws-sdk/client-kms` (arbiter/guard co-signer identity), and — once a
real dependency exists for it (none does today; `LIQUID_COVENANT`
remains a reserved, unimplemented `EscrowType` per `docs/DATABASE.md`
§2) — any future Liquid-related provider dependency. Framework/
infrastructure dependencies already grouped in `dependabot.yml`
(`fastify`, `pg`/`prisma`/`ioredis`, tooling/testing) are out of scope
unless a specific update to one of them would itself affect a Sails
property covered below.

### Lifecycle

```
DISCOVER → CLASSIFY → CAPABILITY DELTA REVIEW → COMPATIBILITY /
BREAKING CHANGE REVIEW → SECURITY / TRUST-BOUNDARY REVIEW →
ARCHITECTURE FIT → EVIDENCE → CTO DECISION →
ADOPT / DEFER / REJECT → FREEZE / DOCUMENT
```

**DISCOVER** is already handled by Dependabot (or direct upstream
awareness for an event-triggered review, below) — this policy does not
duplicate that mechanism.

### Triggers

**A. Periodic awareness.** No new, invented cadence — Dependabot's
existing `schedule.interval: weekly` (`.github/dependabot.yml`) is the
periodic **awareness/discovery trigger** this policy relies on. It is
not itself a review: opening a PR performs neither a Capability Delta
Review, a Security Review, an Architecture Fit check, nor a CTO
Decision. A review under this policy only begins once the surfaced
change is classified (below) as Class A/B, or as a Class C/D change
touching a property named in the Security-Sensitive Rule. This policy
adds no second calendar — it only names what the existing one does and
does not accomplish. **Discovery ≠ Review. Review ≠ Adoption.**

**B. Event-triggered review**, any of: a security advisory; a breaking
release; a major API removal; a relevant new capability; a
production-critical bug fix; an important performance/runtime change; an
upstream deprecation; an ecosystem/protocol change (e.g. a Bitcoin/EVM
network upgrade); a provider changing a guarantee relevant to Sails; a
dependency reaching an unsupported/EOL state. Not every patch release
requires an architecture review — most Dependabot PRs are routine
Class C/D (below) and merge through the existing human-review gate with
no separate process.

### Change classification

> **CLASSIFICATION ≠ CONSEQUENCE.** Classification describes *why* /
> *what kind* of upstream change this is. It does not, by itself,
> determine how much evidence and review the change requires — that is
> the job of the Security-Sensitive Rule and the Decision Test below,
> applied to the actual property affected, not to the class label
> alone. A Class C (Compatibility) update is not automatically "safe to
> merge with no property review" — a compatibility-driven change can
> still touch signing, settlement, or another security-sensitive
> property, and if it does, it is reviewed accordingly regardless of
> its class.

- **Class A — Security/Correctness.** A material security fix,
  correctness property, vulnerability, or production-safety issue.
- **Class B — Capability.** A new capability that may materially
  improve Sails.
- **Class C — Compatibility/Maintenance.** A required compatibility,
  deprecation, support, tooling, or runtime/ecosystem maintenance
  update.
- **Class D — Non-Material.** Version churn with no meaningful
  property/capability gain — the default classification for most
  routine Dependabot PRs.

### Decision test

Before adopting a Class A or Class B change to an in-scope dependency —
or a Class C/D change that touches a property named in the
Security-Sensitive Rule below — answer:

1. What changed upstream?
2. What capability/property does Sails gain?
3. What existing behavior could break?
4. What trust/security boundary changes?
5. What API/semantic assumptions change?
6. Can Sails safely remain on the current version?
7. What evidence is required before adoption?
8. What migration cost/complexity is introduced?
9. Can the capability be adopted without coupling Sails semantics to the
   vendor implementation?
10. What rollback/containment posture exists if adoption fails?

**Decision outcomes** (exactly one; no implicit "always upgrade"):

- **A — Adopt.**
- **B — Adopt with bounded conditions** (e.g. behind a feature flag,
  scoped to one provider, with a named residual disclosed).
- **C — Defer / remain on current version.**
- **D — Reject.**
- **STOP — architectural contradiction or insufficient evidence** —
  same STOP discipline as §6, recorded the same way.

A Class C/D change that touches none of those properties needs none of
this — it merges through Dependabot's existing human-review gate,
consistent with Classification ≠ Consequence above: most routine bumps
carry a routine consequence, but the classification alone never settles
the question.

### Security-sensitive rule

**Applies regardless of class** (Classification ≠ Consequence, above).
For an update — Class A, B, C, or D — touching signing, settlement,
transaction construction, key custody, verification, finality,
retry/idempotence, authorization, transport security, or semantic
behavior: **no upgrade is justified merely by version freshness,
marketing claims, release notes alone, new API availability, or
"latest is better."** Require evidence proportionate to the property
affected — the same evidence discipline §10/§11 already require for any
Sails-authored change, applied here to a vendor-authored one. A
security/correctness (Class A) upgrade's urgency can override normal
sequencing, but only after classification — never used to skip
classification itself, and never used to skip this rule for a
Class C/D update that happens to touch one of these properties.

### Agent/QVAC authority rule

**QVAC/AI capability evolution ≠ protocol authority evolution.** A
`@qvac/sdk` update must never silently expand signing authority,
settlement authority, `CapabilityGrant` authority, protocol-truth
authority, or blocking/enforcement authority. Any such expansion is a
separate architectural decision (`docs/GOVERNANCE.md` §5's RFC process),
never a side effect of a version bump. This is the same boundary
RFC-016 (Crypto-Native Agent) and RFC-017 (Social Engineering
Agent — "detects, it does not act") already establish for QVAC's
current capabilities; this rule states explicitly that a future SDK
update inherits that boundary, it does not get to redraw it. Preserve:
**Detection ≠ Enforcement. Agent ≠ Authority. AI Recommendation ≠
Authority** — unchanged, restated here specifically against dependency
evolution, not just against a feature's initial design.

### Semantic stability rule

An external upgrade must not silently redefine Intent, Authority,
Conditions, Evidence, Outcome, Settlement semantics, Capability
semantics, event meaning, or conformance meaning. If an upstream API
forces one of these to change, **STOP** — that is no longer a
dependency upgrade, it is an architecture change, and follows §8's
process (and `docs/GOVERNANCE.md` §3's RFC table) like any other.

### Version / range / lockfile policy

Confirmed by inspection: `package.json` already mixes conventions
deliberately, not by accident — caret ranges for most dependencies
(`"@qvac/sdk": "^0.15.0"`), an exact pin only where `package.json`
itself already needed one (`"@fastify/rate-limit": "11.1.0"`,
`"react-router": "8.3.0"` under `overrides`), and `package-lock.json`
resolving every range to one concrete version actually installed. This
policy does not universally prescribe exact-pinning or universal caret
ranges — no evidence justifies overriding either existing convention
wholesale. It adds one vocabulary distinction, useful precisely because
the other two already exist informally:

- **Declared range** — what `package.json` permits (e.g. `^0.15.0`).
- **Resolved version** — what `package-lock.json` records for that
  dependency across the whole tree. With a committed lockfile, a normal
  `npm install` reproduces the resolved version already recorded — it
  changes only when dependency resolution runs again and the lockfile
  is updated or regenerated (e.g. `npm update`, a fresh `npm install`
  after a `package.json` range change, or a manual lockfile
  regeneration), not merely because another ordinary install happens.
- **Reviewed version** — the specific version against which current
  Sails evidence (tests, live verification, a Mission Freeze) was
  actually produced. This is the version this policy's Decision Test
  and Evidence Obligation (below) are about — not merely "whatever the
  lockfile currently resolves to."

### Automation policy

Dependabot may discover, notify, open PRs, and surface changelogs/
security advisories — it already does. Automation must never
self-authorize architectural adoption, self-merge a critical dependency
upgrade, or convert a version bump into an accepted capability claim.
**Automated update ≠ architectural approval.** No automation change is
made or proposed by this section — `.github/dependabot.yml`'s existing
per-package grouping (signing/key-material/hashing/Bitcoin-EVM-tx
packages never grouped, per its own stated rule; several other
packages, QVAC/WDK/Arkade/Hyperswarm/HyperDHT among them, likewise
ungrouped today as a consequence of the current pattern set) and branch
protection's existing human-review requirement (`GITHUB_PROJECT.md`
§8) already enforce this in practice; this section states the rule the
existing mechanism was already, correctly, built to satisfy.

### Evidence obligation

Every adopted in-scope upgrade leaves evidence proportionate to its
actual consequence (Classification ≠ Consequence, above) — not a fixed
record size tied to its class label. For a Class A/B upgrade, or any
upgrade touching a Security-Sensitive Rule property: previous reviewed
version, new reviewed version, relevant upstream changes, Sails
capabilities/properties affected, tests/evidence performed, unresolved
residuals, claim impact, and rollback/defer rationale if relevant. For a
genuinely non-material Class D update touching no such property, this
may be minimal — version change, classification, tests/checks run, and
a one-line "no material property impact observed" — not the full record
above; routine bumps must not be made to carry a disproportionate
paperwork cost. A new RFC is not required for every library bump —
only if the upgrade crosses into the Semantic Stability Rule above, per
`docs/GOVERNANCE.md` §3's existing table. `docs/TECHNICAL_DEBT_AUDIT.md`/
`docs/BACKLOG.md` are the existing homes for recording a residual or a
deferred decision — no new ledger is created by this section.

### Representation

No new GitHub Project card per dependency and no new vendor registry.
The existing "Code Quality & Production Reality — Bounded Remediation"
card is reused for the first concrete application of this policy (the
QVAC SDK Capability Delta Review registered in `docs/BACKLOG.md`'s
Known Debt section); a distinct "External Capability Evolution" Project
representation is created only if and when a real review is scheduled
that does not fit an existing card — not speculatively, by this
section.

---

## 9. Definition of Done

DONE does not mean "code merged." Requirements are consequence-weighted
(§4), same as Ready:

**Every change, minimum bar:**
- implementation complete against the stated scope;
- acceptance criteria satisfied;
- repository clean (no stray files, no accidental unrelated diff);
- PR merged.

**Additionally, for Shared-application-semantics work and above:**
- tests appropriate to consequence (see `docs/GITHUB_PROJECT.md`'s CI
  reliability note for what "appropriate" has meant in practice this
  freeze);
- regressions clean;
- docs updated in the same change if canonical understanding changed
  (`CONTRIBUTING.md` §7's existing rule, unchanged);
- technical debt registered, not hidden, if any was knowingly introduced
  (`docs/TECHNICAL_DEBT_AUDIT.md`).

**Additionally, for Protocol-semantics work and above:**
- evidence recorded, classified per §11's vocabulary;
- claims bounded per §10;
- no unauthorized invariant drift (`docs/PROTOCOL_INVARIANTS.md`
  unchanged unless the RFC that authorized the change says otherwise).

**Additionally, for Financial-authority / significant architecture work:**
- a Sacrifice Check performed (§12) and included in the PR;
- adversarial validation evidence, not just happy-path tests.

---

## 10. Claim Discipline

> **OUTPUT ≠ EVIDENCE ≠ PROPERTY ≠ CLAIM**

- **Output** is what was produced — code, a test, a document.
- **Evidence** is what was directly observed — a test passed, a log line
  fired, a real transaction was decoded.
- **Property** is what the evidence demonstrates — not automatically the
  full intended guarantee, only what was actually shown.
- **Claim** is what may safely be said, publicly or in a canonical
  document — never broader than the demonstrated property.

An implementation output is not automatically evidence. Evidence does not
automatically establish the intended property. A property demonstrated in
one slice (e.g. the MULTISIG rail) does not justify a universal claim
(e.g. "multi-rail recovery"). The `M9_FINAL_FREEZE` report
(commit `b0c581d`) is the concrete, checked-in worked example of this
discipline applied at scale — its §14/§38-40 sections are the pattern to
follow, not re-read in full for every future PR.

---

## 10A. Product Reality Discipline (2026-09-10)

Origin: the Institutional Scope & Product Truth Sweep
(`docs/PRODUCT_TRUTH_SWEEP_2026-09-10.md`), frozen by CTO verdict as
institutional truth. This addendum extends §10's Claim Discipline
(OUTPUT ≠ EVIDENCE ≠ PROPERTY ≠ CLAIM) to product/UX journeys
specifically, following the exact dated-addendum pattern established by
§8A.

**New Product Reality test:**

> A technically complete subsystem cannot be considered product-complete
> if the intended Reference Wallet user journey cannot complete
> correctly.

This is the product-journey analogue of §10's rule that a property
demonstrated in one slice does not justify a universal claim. A
`SettlementProvider` being testnet-evidenced (Evidence) demonstrates
that *provider* can settle (Property) — it does not by itself demonstrate
that a real end user can complete the *Reference Wallet's* declared
journey through that provider (a broader Claim), because the journey
includes every step the Reference UI actually exposes, not only the
steps the provider's own test coverage exercises. The concrete worked
example is F1 in the Product Truth Sweep: `Trade.tsx`'s release-funds
path sends a hardcoded demo address for every escrow type with a real
provider, because no address-entry UI exists — provider maturity is
real, the Reference Wallet payout journey is not yet completable.

**Restated governing rule, preserved from the sweep verbatim:**

> Implementation convenience must never silently become Product
> Direction.

Also preserved: implementation ≠ truth; protocol identity ≠
implementation identity; interoperability ≠ protocol identity; backend
completion ≠ product journey completion.

**Explicit placement note:** this property is Product/Engineering
governance — it governs how completeness is *claimed and tracked*, not
what makes Sails Sails. It is deliberately **not** added to
`docs/SEMANTIC_KERNEL.md`, which answers a narrower, closed question
(the protocol's own minimal identity-defining property set) that this
discipline does not change.

---

## 11. Evidence Classification

Distinct evidence states, used in PRs, Issues, and canonical docs:

- **HYPOTHESIS** — a stated idea, not yet designed.
- **DESIGNED** — an architecture/interface exists, no implementation.
- **IMPLEMENTED** — code exists and compiles/runs.
- **SUPPORTED** — the mechanism is understood to work by direct code
  trace or a closely analogous test, but was not independently exercised
  for this specific case.
- **DEMONSTRATED** — directly, independently exercised and observed
  (a real test ran, a real log line fired, real primitives were used).
- **VALIDATED** — demonstrated under adversarial conditions, not just the
  happy path.
- **FROZEN** — validated and formally closed against further silent
  change (a Mission Freeze report, e.g. `M9_FINAL_FREEZE`).

> **Evidence status is not upgraded by inheritance.** A shared code path
> is not independently demonstrated behavior. If RELEASE is DEMONSTRATED
> and REFUND shares the same function, REFUND is at most SUPPORTED until
> it is itself exercised — this exact discipline is what kept the M9
> Final Freeze's RELEASE/REFUND/SPLIT disposition matrix honest, and it
> generalizes to every future PR.

This vocabulary is richer than what belongs in a GitHub Project field —
see `docs/GITHUB_PROJECT.md` for which subset is actually tracked there
and why the rest stays doc-only.

---

## 12. Sacrifice Check

Required for significant architecture, security, or protocol work (§9's
"Financial-authority" tier, and any Core RFC per `docs/GOVERNANCE.md`
§6A):

1. What property did we gain?
2. What property might we have sacrificed?
3. What complexity did we introduce?
4. Did the complexity earn its place?
5. What remains explicitly not demonstrated?

This is not new — every Mission 9 sub-report performed one. It is now a
named, reusable step, not something reinvented per mission.

---

## 13. Document Status / Knowledge Hygiene

> **Retrieval does not confer authority.**

An AI agent (or a human) retrieving a document, a chat transcript, or a
search result has *found* a document, not *confirmed* it is current
canonical truth. External AI tooling has previously confused historical,
rejected reasoning with current canonical state in this repository — the
rule below exists specifically to prevent that from recurring.

Vocabulary for classifying a document's authority:

- **CURRENT CANONICAL** — the live, authoritative statement. Everything
  under `docs/` reached via `docs/00-INDEX.md` is canonical unless
  explicitly marked otherwise inside the file.
- **SUPERSEDED** — was canonical, replaced by a later decision; the file
  usually says so inline (e.g. `docs/PROTOCOL_INVARIANTS.md`'s own
  "Corrigido/Implementado" annotations, `docs/BACKLOG.md`'s "Superseded"
  markings on the old Protocol Fee row).
- **HISTORICAL** — a true record of a past state or decision, not a
  current instruction (e.g. mission reports, `rfcs/` entries for a
  rejected proposal — GOVERNANCE.md §5 keeps rejected RFCs numbered and
  in place deliberately, as history, not as live guidance).
- **REJECTED** — considered and explicitly declined, kept for the record
  (a rejected RFC, or a documented "deliberately not adopted" decision
  like `docs/BACKLOG.md`'s CRDT/WebRTC row).
- **RESEARCH** — exploratory, not a commitment (`docs/SDK_usecases.md`,
  `docs/ECOSYSTEM_INTEGRATIONS.md` — both explicitly self-labeled
  "vision/roadmap, not a spec").
- **HYPOTHESIS** — a named idea with no write-up yet — see
  `docs/GITHUB_PROJECT.md`'s Master Backlog bucket D for the current
  list (Capability Composition, Ecosystem Flywheel, Sails Trilemma, and
  others named in Mission 9.9's own brief but not yet documented
  anywhere in this repository — named here, not elaborated, precisely
  because elaborating them now would be inventing architecture this
  document has no standing to invent).

This mission does **not** perform a full sweep re-labeling every existing
document — that is future Knowledge Architecture work, out of scope here
(mission §28's own instruction). This section only makes the vocabulary
explicit so a future sweep has a fixed target to use.

---

## 13A. System Coherence Discipline (2026-09-13)

Origin: the System Coherence & Integration Audit
(`docs/SYSTEM_COHERENCE_INTEGRATION_AUDIT.md`) and its two bounded
corrective missions (F-01 SPLIT representation, F-06 payout-address
privacy — `COHERENCE-CORRECTIVE-1`). Extends §10/§10A's Claim Discipline
from individual claims to the system as a whole, following the same
dated-addendum pattern as §8A/§10A.

> A system is not coherent because its parts are individually correct.
> Coherence must be re-proven as the system evolves.

> Every new layer creates new integration risk, even when no existing
> layer changed.

> Architecture can be coherent and still produce an incoherent
> real-world experience.

> Institutional truth should be easy to find, easy to read, and hard to
> duplicate.

> Documentation must compress knowledge, not merely accumulate it.

**Three practices institutionalized by this addendum:**

- **System Coherence Audit** — an adversarial, cross-layer audit
  (Product → Architecture → Runtime → API/SDK → UI → Actor Visibility)
  run at integration milestones, not only when something is suspected
  broken. Its posture is to try to break the system, not confirm it
  works — `docs/SYSTEM_COHERENCE_INTEGRATION_AUDIT.md` is the worked
  example, not re-read in full for every future milestone.
- **Practical Reality Simulation / End-to-End Reality Test** —
  simulating real use by USR/AGT/OPS/INT, a wallet, and a partner
  integrator, checking whether the experience actually closes end to
  end, not only that each layer's own contract is satisfied in
  isolation.
- **Documentation Coherence & Reduction Audit** — run periodically to
  remove duplication, stale truth, and unnecessary intermediate
  documents, and to improve the reading path for a third party. Restates
  §14's "memory, not diary" principle as a recurring maintenance
  obligation, not a one-time rule.

**Benchmark rule, generalizing a pattern already applied informally
across several missions:**

> Benchmark the interaction reality, not the architecture.

Zest, Sovryn, Hodl Hodl, Bisq, Binance P2P, and similar products may
serve as practical references for interaction patterns — never as
authority for copying custody, authority, or architecture models.

**Frozen:**

> Every frozen product model must survive an end-to-end reality
> simulation before being treated as interaction-complete.

**Explicit non-goal:** this addendum does not mandate a new document per
audit, per §28 of the mission that produced it — `docs/BACKLOG.md` and
`docs/PROJECT_CONTEXT.md` carry a pointer/summary only, never the full
findings, consistent with §14's own "memory, not diary" rule applied to
these three practices specifically.

---

## 14. Repository Memory Principle

> **GitHub is the memory of the architecture, not the diary of how we
> discovered it.**

Canonical documentation (`docs/`) should state conclusions, cross-
referenced to evidence, not the chronological narrative of how the
conclusion was reached. Mission reports, PR descriptions, commit
messages, and `rfcs/` entries are where chronology and process belong —
they are permanent, searchable, and exactly where a reader looking for
"why did we decide this" should go. A canonical doc bloated with mission
history is harder to trust as current truth, not easier — this is the
same discipline `docs/GOVERNANCE.md` §6C already applies to what's
public at all, generalized here to what belongs in a *canonical* file
specifically, public or not.

---

## 15. Non-Decisions of This Mission

Mission 9.9 (this document's own origin) is engineering-governance and
contributor-readiness work. It explicitly did not, and its existence
must never be read as having:

- modified Sails Core semantics, the Semantic Kernel, the Constitution,
  Protocol Invariants, any state machine, settlement behavior, recovery
  behavior, or Destination Authority;
- changed the database schema or added a migration;
- activated protocol fees or changed economic behavior;
- begun M10 implementation;
- redesigned OpenP2P, implemented agents, implemented privacy
  architecture, or implemented a new settlement rail;
- published an npm package or bumped SDK version;
- performed a broad repository redesign unrelated to contributor
  readiness.

See `docs/GITHUB_PROJECT.md` §"Important Non-Decisions" for the list of
named-but-undocumented conceptual fronts (ZK, anonymous credentials, the
Sails Trilemma, Portable Economic Proofs, Pubky/PKARR, Nostr as
transport, mandatory Pear transport, exact capability-negotiation
mechanism, a universal interoperability layer, multi-attempt execution
architecture, automatic World-C convergence) that this document
deliberately does not promote to any status beyond "named, registered,
undocumented." DLC has been removed from the roadmap and is not
reintroduced by this document.

---

## 16. AI-Oriented Engineering Discipline (2026-09-13)

Origin: `AI-ENGINEERING-DISCIPLINE-1`, absorbing properties learned from
Sails' own mission history (`SYSTEM-COHERENCE-1`, `COHERENCE-CORRECTIVE-1`,
`PRE-M3-REALITY-GATE-1`, and others) and from external engineering
methodology — Loop Engineering, Spec-Driven Development, Harness
Engineering, TDD, adversarial review, decision-frontier reasoning,
research/prototype discipline, domain modeling, and industry benchmarks
including AI Hero. **External methodology is evidence/input, never
authority** — see §16.21. This section extends, and does not replace,
§1 (challenge without unilateral redefinition), §4 (Consequence-Weighted
Development), §6 (STOP > artificial PASS), §7 (Human + AI Contributor
Model), §10/§10A (Claim Discipline), §11 (Evidence Classification), §12
(Sacrifice Check), and §13A (System Coherence Discipline).

> AI-assisted engineering is not about producing more code. It is about
> reducing reasoning error before, during, and after code is produced.
> Process must make wrong assumptions easier to expose than to
> propagate.

### 16.1 Decision Frontier Review

A Decision Frontier is the set of decisions legitimately resolvable now,
because their prerequisites are already established:

```
KNOWN TRUTH → OPEN DECISIONS → DEPENDENCIES → CURRENT DECISION FRONTIER
→ GRILL / RESEARCH / PROTOTYPE → NEW FRONTIER
```

> Do not answer a downstream decision while an upstream decision it
> depends on remains unresolved. Unknown prerequisites must not be
> converted into convenient assumptions.

Required before Protocol-semantics-or-above work (§4). A §6 STOP is
frequently a Decision Frontier violation made visible.

### 16.2 Grilling Discipline

For a complex Product/Architecture decision, do not generate an
indiscriminate question list. Ask first only what changes the decision,
unblocks another decision, resolves an assumption, or materially narrows
the solution space — then recompute the Decision Frontier (§16.1).

> Questions earn their place by changing the decision space.

### 16.3 Wayfinding — Mission / Decision Mission / Program

- **Mission** — bounded execution fitting one controlled session/context.
- **Decision Mission** — exists to resolve a decision required before
  implementation, not to implement.
- **Program / Decision Map** — a problem too large to resolve honestly in
  one Mission. Represents destination, known truth, open decisions,
  dependency graph, sequencing, STOP points, evidence needed, and which
  executable Missions each decision unlocks.

> Large problems should first be decomposed into decisions, not directly
> into implementation tickets.

`docs/GITHUB_PROJECT.md` §2's Bucket C ("Architectural fronts") is the
existing structural home for a Program's Decision Map — this names the
discipline for working a bucket-C front; it does not create a new
backlog bucket.

### 16.4 Spec-Driven Development

> Resolved decisions become specification before consequential
> implementation.

```
Problem → Desired Property → Decision → Spec/Contract → Acceptance
Evidence → Implementation
```

This is §4's Consequence-Weighted Development restated as a pipeline,
not a competing rule — `docs/GOVERNANCE.md` §3's table still governs
when a full RFC is actually required. Implementation must not silently
redefine the spec because it became easier to do so — that is a §6 STOP,
not a judgment call. Preserved: Product defines what must exist and why;
Architecture defines how meaning/boundaries/replaceability are
preserved; Implementation proves what actually exists at runtime.

### 16.5 Research Discipline

Primary-source-first for architectural, capability, and security claims:
protocol specification → official documentation → official source code
→ official implementation/repository → measured runtime evidence →
reputable secondary source → community discussion as supporting signal
only. Every material conclusion separates **FACT / EVIDENCE / INFERENCE
/ DECISION / UNKNOWN**.

> Five agents reading weak evidence do not produce strong evidence.
> External research may inform Sails truth. It cannot silently become
> Sails truth.

Operational home: `.github/ISSUE_TEMPLATE/research.md`.

### 16.6 Prototype Discipline

> A prototype answers a question. It does not become implementation
> merely because it works. Prototype code is evidence until explicitly
> promoted through the normal engineering process.

Every prototype — including a throwaway branch, a provider PoC, or an
external no-code/design tool output — states: the question being
tested, its assumptions, what result would falsify the idea, whether it
is disposable or promotable, and what property it does and does not
prove. A working prototype is, at most, DEMONSTRATED per §11 — never
FROZEN — until it is promoted through §16.4 and §16.10.

### 16.7 Harness Engineering

> Every material uncertainty should seek the shortest trustworthy
> feedback loop available. If a bug is expensive to reproduce, the first
> engineering task may be to make reproduction cheap.

Feedback-loop ladder — adapt per case; never use a level smaller than
the property actually requires:

```
focused unit test → focused integration test → curl/API script →
deterministic fixture → CLI harness → headless browser → replay fixture
→ throwaway harness → property/fuzz loop → differential old/new harness
→ real external system → human-in-the-loop
```

### 16.8 TDD Discipline

> Test the property at the narrowest seam that can actually prove it.
> Do not mock the property you claim to prove.

Before writing the test: which property is being proved; which seam can
observe it; what must fail before the implementation exists; what mock
would make the test stop proving the property. Preserve Red → Green →
Refactor where applicable. A test that mirrors implementation is weaker
evidence than one that challenges observable behavior — this restates
§11's Evidence Classification at the level of a single test, not a new
hierarchy.

### 16.9 Vertical Demonstrable Slices

> Implementation layers are means. Observable properties are completion
> units.

Every executable Mission/Issue answers: *what can be demonstrated when
this is done?* The answer is behavior/property ("an authenticated
participant can resume X after Y while preserving Z"), not a layer
("create a repository," "add a service," "implement an abstraction")
unless that layer itself proves an observable result. This sharpens
§5's existing "the desired property is stated" minimum bar — it does not
add a new Definition-of-Ready field.

### 16.10 Quad Review

Four independent review lenses; each can fail a PR that already passed
the others:

- **A. Spec Conformance** — did it implement exactly the authorized
  behavior?
- **B. Engineering Standards** — is it robust, simple, testable,
  readable, maintainable?
- **C. Product/Architecture Truth** — does it preserve Product
  Direction, authority, semantics, UX, privacy, and architecture (§3)?
- **D. Evidence/Claim** — does the evidence actually prove the property,
  and does the claim not exceed it (§10)?

> Correct implementation of an incorrect assumption is still incorrect.

A+B passing does not imply C; A+B+C passing does not imply D.

### 16.11 Loop Engineering

```
BUILD/ANALYZE → VERIFY → ATTACK → FINDINGS → CORRECT → RE-RUN →
RE-ATTACK → STABILITY CHECK
```

No fixed loop count. Continue when a new pass finds a Critical, a High,
a new material failure class, or a systemic contradiction. The stop
condition is defined by the Mission (e.g. "no unresolved Critical/High
affecting the declared property") — never "ran N times" as a substitute
for stability. This names, as a reusable pattern, the loop
`SYSTEM-COHERENCE-1` and `PRE-M3-REALITY-GATE-1` already ran ad hoc.

### 16.12 Blind-Spot Review

After a solution appears correct, ask: *what did we not ask because the
current implementation made us think it was irrelevant? What would
break, mislead, or silently weaken the next Mission if we continued
now?* Look for hidden coupling, silent assumptions, stale truth, a
missing actor, a missing interruption/recovery path, authority collapse,
failure/absence collapse (§16.17), maturity overclaim, and false
equivalence across providers/interfaces. This names, as a reusable step,
the exact practice `docs/SYSTEM_COHERENCE_INTEGRATION_AUDIT.md` and
§13A's System Coherence Discipline already perform — not a new audit
type.

### 16.13 Domain Modeling / Ubiquitous Language

> Vocabulary drift is architectural drift. A new term must sharpen the
> model or not exist.

Central terms (Intent, Offer, Trade, Settlement, Outcome, Authority,
Capability, Eligibility, Asset, SettlementRail, SettlementScope,
SettlementAdapter, SettlementProvider, Economic Identity, Transport
Identity, Node Identity) each carry exactly one meaning. A term carrying
two meanings is a §6 STOP, not a documentation nuance — reconcile before
proceeding. Glossaries are compressed/reconciled periodically — §13A's
Documentation Coherence & Reduction Audit is the existing mechanism, not
a new one.

### 16.14 Pre-Build Architecture Leverage Check

Before a large block of work, ask: *what could we change now to make the
upcoming work materially easier, safer, or more testable?* A prior
refactor is justified only if it reduces risk, reduces repeated
complexity, creates a better testing seam, eliminates directly relevant
coupling, or simplifies the upcoming change — never for aesthetic
abstraction.

> Refactor when it reduces the cost or risk of real upcoming work, not
> because a cleaner abstraction is aesthetically attractive.

### 16.15 Agent Context Engineering

> Instructions should maximize behavior change per unit of context.
> Compress redundancy, not truth.

Before extending a Mission brief, ask: if this instruction were removed,
could agent behavior materially worsen or change? If not, compress or
remove it — but never sacrifice a load-bearing constraint for brevity. A
large Mission separates: authority, goal, baseline, constraints, known
findings, allowed changes, forbidden changes, required evidence, STOP
condition, required return.

### 16.16 Context Handoff Discipline

> A process that works only because one AI session remembers the
> conversation is not an engineering process.

A Mission must be resumable by a different agent without private memory
of the prior session. For material work, register: baseline, current
truth, decisions, unresolved decisions, evidence, STOPs, output, and
next gate — the same discipline every Mission return in this
repository's own history already follows (e.g. `docs/BACKLOG.md`'s dated
append pattern); this names it as a general requirement, not a new
format.

### 16.17 Evidence Escalation & Failure Taxonomy

Evidence strength should match the claim, not follow a fixed universal
ladder:

```
typecheck < unit test < integration test < adversarial test <
harness/replay < cross-implementation test < real-provider test <
independent integration < controlled real-value evidence
```

> Use the weakest test capable of falsifying the claim, then strengthen
> evidence when the consequence demands it.

This refines §11's Evidence Classification with a companion notion of
*how* evidence was produced — not a replacement for it.

**Failure Taxonomy — never collapsed:** Absence ≠ Failure ≠ Unknown ≠
Pending ≠ Rejected ≠ Unavailable — for APIs, provider calls, settlement,
agents, UI, tests, and harnesses alike. A swallowed error does not
become success; a timeout does not become a confirmed economic failure;
a 404 does not automatically become UNKNOWN. `PRE-M3-REALITY-GATE-1`'s
P3-F03 fix (`packages/sails-ui/src/hooks/useEscrowKey.ts`) is the
concrete, checked-in worked example of this rule applied to a real bug.

**Cross-layer rule (`AI-ENGINEERING-DISCIPLINE-1-R1`, 2026-09-13):**

> Error semantics are cross-layer truth. Runtime, API, SDK, and Product
> may expose different detail, but must preserve the same underlying
> failure and recovery meaning.

> UI copy may vary by product and actor. Error meaning, retryability,
> economic-state implication, and recovery semantics may not.

The Failure Taxonomy above is not only a per-layer discipline — the same
distinction (Absence ≠ Failure ≠ Unknown ≠ Pending ≠ Rejected ≠
Unavailable) must survive translation across every layer that touches
an error before a human sees it. The conceptual mapping a layer boundary
must preserve:

```
Runtime Code → API/Error Envelope → SDK Typed Error → Semantic Category
→ Retryability → Economic State Impact → Required Recovery Action →
Product Presentation
```

Each layer may add context; none may change the underlying meaning. A
backend 401 becoming an SDK type that a UI then treats as "nothing to
sign" (exactly `PRE-M3-REALITY-GATE-1`'s P3-F01/P3-F03 bug) is this rule
being violated, not a UI wording choice — different products, partner
wallets, and integrators may word the resulting message however fits
their audience, but they may not disagree on whether the situation is
retryable, whether it implies an economic-state change, or what action
it requires.

**Four preservation rules — restatements of the same principle at
different points in the chain, not four new rules:**

1. **Error meaning must survive translation.** An auth error must not
   become a generic error when the correct recovery is reauthentication;
   a forbidden must not become "try again" when the real problem is
   authority; an external timeout must not become "transaction failed"
   when the real outcome is unknown; a circuit breaker must not present
   as a definitive economic failure.
2. **Retryability is semantic, not an arbitrary UI choice** — e.g. auth
   expired → recoverable after auth; forbidden → not retryable without
   an authority change; rate limit → retryable later; transport failure
   → potentially retryable, but economic side effects may need
   reconciliation; internal/economic-integrity ambiguity → fail closed /
   operator attention; absence → may be a legitimate no-op depending on
   context. Illustrative, not an exhaustive or permanent taxonomy of
   every protocol error.
3. **Economic-state implication must remain explicit.** A technical
   failure does not automatically define an economic outcome; an
   unknown external outcome must not be rewritten as a failed economic
   action — this section's Absence ≠ Failure ≠ Unknown, applied
   specifically to an economic side effect.
4. **Product copy is not protocol truth.** Human-facing copy is a
   presentation layer over stable error semantics, not the canonical
   error model itself. Sails Market, a partner wallet, and a direct API
   integrator may each word a message differently — none may turn
   rejected into unavailable, unknown into failed, pending into error,
   hide an authority rejection as a connectivity issue, or treat absence
   as success for convenience.

**Current typed-parity gap — registered as a future audit obligation,
not a runtime defect fixed here:** verified directly, not assumed —
`src/common/errors/index.ts` defines real backend error codes
(`ECONOMIC_AUTHORITY_AMBIGUITY`, `CIRCUIT_BREAKER_OPEN`,
`RATE_LIMIT_UNAVAILABLE`, among others) that
`packages/sails-sdk/src/errors.ts`'s `ERROR_CODE_MAP` does not yet map
to a dedicated subclass; an unrecognized code falls through to the
generic `SailsError` fallback in `errorFromResponseBody()` (that
function's own comment: "still a real, well-formed Sails error
response, just not one of the known AppError subclasses"). Information
is preserved — the real `code`/`statusCode`/`message` are never lost —
but typed parity across every backend code is incomplete. Registered as
a backlog obligation (`docs/BACKLOG.md` item 35), not implemented here.

### 16.18 Agent Authority (extends §7)

> Agent access ≠ Agent authority.

An AI agent may investigate, propose, implement within scope, gather
evidence, and attack assumptions. It does not thereby gain Product
authority, Architecture authority, economic authority, merge authority,
or claim authority — this restates §7's "AI generation ≠ permission" for
*access* specifically; it is not a new rule.

### 16.19 Architecture / Product Balance

> No discipline defines the product alone. Each discipline protects part
> of the truth. Local optimization must never become global product
> truth.

Restates §3.1's Authority-by-Discipline table as a single governing
sentence: engineering simplicity does not redefine Product; UX
simplicity does not eliminate authority/risk; security must not create
disproportionate friction; architecture must not lose the real user
journey; operations does not gain privileged authority because it would
be convenient.

### 16.20 How This Fits the Existing Flow

Does not replace `MISSION → EVIDENCE → CTO GATE → FREEZE → BACKLOG
DELTA → PROJECT SYNC → NEXT MISSION`. Expands the pre-implementation
portion of that cycle:

```
ORIENT → DECISION FRONTIER/WAYFIND → RESEARCH/PROTOTYPE if needed → SPEC
→ VERTICAL SLICE → HARNESS → IMPLEMENT/TDD → QUAD REVIEW →
REALITY/BLIND-SPOT LOOP → EVIDENCE → CTO GATE → FREEZE → BACKLOG
DELTA/PROJECT SYNC → KNOWLEDGE COMPRESSION
```

**Not every phase is mandatory for a trivial or reversible change** —
§4's Consequence Weighting governs how much of this actually applies,
exactly as it already governs §5 and §9. A typo fix or an additive,
reversible change does not require a Decision Frontier review or a
Harness; the more irreversible, financially material, authority-bearing,
or protocol-meaning-affecting the change, the more of §16.1-§16.19
applies.

### 16.21 External Methodology Positioning

External methodologies (Loop Engineering, Spec-Driven Development,
Harness Engineering, TDD, adversarial review, decision-frontier
reasoning, AI Hero, and any other industry practice) are evidence/input
only — never architectural authority, never a mandatory dependency,
never canonical Sails terminology. The vocabulary in this section (e.g.
"Decision Frontier Review," not any external tool's own command name) is
the vocabulary used in Sails Missions, Issues, and PRs going forward.


---

## External Timestamp Infrastructure Authority Boundary (2026-09-20)

OpenProof timestamp infrastructure follows the same authority discipline as other external mechanisms:

- Sails owns the `TimestampAnchor` interface and its invariants.
- OpenTimestamps implementations and calendars are replaceable evidence infrastructure, not sources of Protocol Truth or Economic Authority.
- Provider/calendar availability MUST NOT become an economic-state prerequisite without a separately accepted architecture decision.
- Redundancy is implemented above individual calendar identity: no public calendar, and no future Sails-operated calendar, acquires privileged authority merely by being configured or operated by Sails.
- Evidence from successful calendars may be preserved while other calendar submissions fail; partial provider failure is not grounds to discard already-valid evidence.
- Any future Sails-operated OpenTimestamps-compatible infrastructure remains an optional participant in the open ecosystem and receives no special protocol authority.

Cross-reference: `docs/BACKLOG.md` owns the Day-0 multi-calendar implementation/evidence obligation; `docs/ROADMAP.md` owns the optional/future Sails-operated aggregator/calendar horizon.
