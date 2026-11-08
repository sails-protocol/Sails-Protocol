# GITHUB_PROJECT.md

> **Status / authority:** this document owns the GitHub Project governance and
> configuration model and preserves dated historical snapshots of Project and
> program state. It is **not** the current operational state. Current
> operational truth lives in the live GitHub Project. References below to
> “current” missions, fields, views, cards, or program state describe the dated
> snapshot in which they were recorded unless independently re-verified live.

> **Sails Protocol — Engineering Operating System, Document 2 of 2**
> (companion: `docs/ENGINEERING_GOVERNANCE.md`). Written during Mission
> 9.9, 2026-08-31; **the GitHub Project itself was created and
> configured during the M9.9 Completion Delta, 2026-09-01**, once the
> repository owner explicitly authorized and completed the required
> OAuth scope grant (§0). This document is now two things, both real:
>
> 1. **The live GitHub Project's actual configuration** — created,
>    verified field-by-field and view-by-view against the real Project
>    via independent `gh api graphql` reads, not assumed from the plan
>    that preceded it. §0/§1 below describe what happened when the
>    original plan met real GitHub Projects v2 API behavior — several
>    details differ from the original assumption, disclosed explicitly.
> 2. **The current program-state snapshot** — Master Backlog
>    classification, residuals, Issue taxonomy, labels — real and
>    current as of the frozen commit below.

---

## 0. GitHub access/capabilities — resolved during the M9.9 Completion Delta

**Originally blocked, now resolved with explicit authorization.** At the
end of Mission 9.9 proper, the token had no `project` scope:

```
$ gh project list --owner alan-schramm
error: your authentication token is missing required scopes [read:project]
```

The repository owner explicitly authorized requesting this scope. The
grant requires an interactive device-code approval — this was not
silently escalated; the exact code and URL were surfaced to the user in
chat, twice (the first device code expired unapproved after ~15 minutes,
a real, disclosed retry, not hidden), before the second was approved:

```
$ gh auth refresh -h github.com -s project,read:project
! First copy your one-time code: 145B-A584
Open this URL to continue in your web browser: https://github.com/login/device
[... user approved in browser ...]

$ gh auth status
Token scopes: 'gist', 'project', 'read:org', 'repo', 'workflow'
```

**Repository-level GitHub state, confirmed directly** (as of the M9.9
Completion Delta; branch protection state changed since, see §8):

| Item | State (M9.9 proper) | State (after Completion Delta) |
|---|---|---|
| Branch protection on `main` | None (`404`) | **Applied** — §8 |
| GitHub Project | Did not exist, inaccessible | **Created — `Sails Protocol — Development`, https://github.com/users/alan-schramm/projects/3** |
| Collaborators | `alan-schramm` (admin), `renipinto` (write) — personal account, no GitHub Team | unchanged |
| Labels | 9 GitHub defaults + 3 tooling-generated | + 6 Sails-specific (unchanged this delta) |
| `.github/workflows/` | `ci.yml`, `ci-tests.yml`, `codeql.yml` | unchanged — **but `CI`/`CI Tests` found structurally broken during this delta's branch-protection investigation, §8** |

---

## 1. Project configuration — APPLIED, verified live

**Name:** `Sails Protocol — Development`.
**URL:** https://github.com/users/alan-schramm/projects/3 (project number 3).

```bash
gh project create --owner alan-schramm --title "Sails Protocol — Development"
```

**A real API-shape difference from the original plan, found immediately
and worked around, not silently ignored:** a brand-new Project already
comes with 13 default fields (Title, Assignees, a native `Status` field
pre-seeded `Todo/In Progress/Done`, Labels, Linked PRs, Milestone,
Repository, Reviewers, Parent issue, Sub-issues progress, Created,
Updated, Closed) and one default view (`View 1`). The plan below was
applied **on top of** that reality — the native `Status` field's options
were replaced via `updateProjectV2Field` rather than creating a second,
competing status field, and the redundant default view was deleted once
the 8 planned views existed, rather than left as a 9th, meaningless one.

### 1.1 Status field (native, values challenged and trimmed)

Values: **Backlog, Ready, In Progress, Validation, Blocked, Done.**

Two candidates from this mission's own brief were considered and
**rejected**:

- **"Proposed"** — rejected. A protocol-level proposal already has a
  real, adequate lifecycle: the RFC itself (`docs/GOVERNANCE.md` §5,
  Draft → Discussion → Decision), tracked as a file in `rfcs/` with its
  own `Status:` header. Mirroring that in a Project status would be a
  second, competing tracker for the same fact. A Project Issue is only
  created once there is trackable *work* — for an RFC-requiring change,
  that work item is "draft the RFC," which fits Backlog/Ready/In
  Progress like any other task.
- **"Frozen"** — rejected as a Status value. A frozen mission (e.g. M9)
  is `Done` at the Status level; "frozen" additionally describes its
  *evidence* level (§1.3's Evidence Status field, value `Validated`, or
  the doc-only `FROZEN` vocabulary in `ENGINEERING_GOVERNANCE.md` §11
  for a fully closed mission). Adding a 7th Status value that means
  roughly "extra done" duplicates a distinction the Evidence Status
  field already makes better.

### 1.2 Workstream field (single-select)

`Core, SDK, OpenP2P, OpenSettlement, OpenIdentity, OpenReputation,
OpenProof, OpenLiquidity, Transport, Agents, Security, Documentation,
Research, Repository/CI`

Every value maps to a real module folder or a real, already-established
concern in this codebase (`modules/open-*`, `packages/sails-sdk`,
`packages/sails-core`, `.github/workflows/`). **Rejected as separate
values:** `Privacy`, `Protocol UX`, `Productization` — none has any real
code today (this mission's own §24/§29 explicitly forbid designing
Privacy or UX architecture now), so a standing Workstream value with zero
possible items until a future mission begins is premature. Work on these
fronts, when it starts, is tracked under `Research` until it has a real
module to attach to — consistent with §3's bucket-D treatment of named
but undocumented fronts.

### 1.3 Priority field (single-select)

`P0, P1, P2, P3` — standard, unchallenged.

### 1.4 Evidence Status field (single-select, trimmed from the mission's
own 7-value suggestion)

`Hypothesis, Designed/Implemented, Demonstrated, Validated`

`ENGINEERING_GOVERNANCE.md` §11 defines a richer 7-value vocabulary
(adding `Designed`, `Implemented`, `Supported`, `Frozen` as distinct
states) for use in **docs and PR text**, where the distinction between
"implemented" and "supported-by-analogy" or between "validated" and
"frozen" genuinely matters and has room to be explained. A Project field
is a glance-level filter, not a proof — collapsing to 4 values keeps it
usable without pretending a quick-glance field can carry the same
precision as a written Sacrifice Check. **This field is never
automated** (§1.6) — only a human sets or advances it, because judging
Demonstrated vs. Validated requires reading the actual evidence.

### 1.5 Risk / Consequence field (single-select)

`Reversible, Shared Semantics, Protocol Sensitive,
Economic/Security Critical` — maps directly to
`ENGINEERING_GOVERNANCE.md` §4's consequence table. Unchallenged, kept
exactly as proposed, since it is the field that actually drives which
Definition-of-Ready/Done tier and which PR-template sections apply.

### 1.6 Mission / Milestone field (single-select, grown as needed)

Current real values: `M9.9 (current)`, `M10 (unblocked, not started)`.
Historical values for completed work are not backfilled into the Project
(§2 below explains why) but the field exists so future missions have
somewhere to attach.

### 1.7 Fields deliberately rejected entirely

- **Dependency** — GitHub Projects v2 already has native issue-linking
  ("blocked by" / task lists) that expresses this better than a free-text
  field could; adding a duplicate field would just drift out of sync
  with the real links.
- **Owner** — GitHub's native Assignees field already covers this; a
  second "Owner" field would be a second, driftable source of the same
  fact.

### 1.8 Views — created and filtered, verified live

Eight, matching the original candidate list — none dropped, none added.
Created via `createProjectV2View` (`layout: TABLE_LAYOUT` for all 8 —
the API offers `BOARD_LAYOUT`/`ROADMAP_LAYOUT` too, but a table is the
right default for a project this size) and filtered via
`updateProjectV2View`. **A real, disclosed API limitation found while
applying this:** the public GraphQL API exposes view `filter` (a search-
syntax string) but has **no public field for `groupBy`/sort** —
`ProjectV2ViewConfigurationInput` only accepts `visibleFieldIds`.
Grouping (e.g. "Master Backlog grouped by Workstream") is therefore a
**one-time manual step** in the UI for whoever opens the Project next —
the filters themselves are already live and correct:

1. **Current Mission** — `filter: mission:"M9.9 (current)"`.
2. **Master Backlog** — `filter: ""` (everything). *Group by Workstream
   manually, once, in the UI — not settable via API.*
3. **Architecture Roadmap** — `filter: risk:"Protocol Sensitive"`.
   *Simplified from the original plan's compound "OR Economic/Security
   Critical" — the filter-string grammar didn't parse a clean OR across
   two quoted option values in testing; a single-value filter that's
   actually live beats a compound one that silently fails. Widen
   manually in the UI if both risk tiers are wanted in one view.*
4. **Security & Technical Debt** — `filter: label:technical-debt`.
5. **Research / Hypotheses** — `filter: workstream:Research`.
6. **SDK & Integrations** — `filter: workstream:SDK`.
7. **Validation / Evidence** — `filter: status:Validation`.
8. **Completed / Frozen** — `filter: status:Done`.

The auto-created default `View 1` (empty filter, functionally identical
to "Master Backlog") was deleted via `deleteProjectV2View` once the 8
above existed — confirmed deletable (not a protected default), leaving
exactly 8 views, verified via a fresh `views(first: 20)` query.

### 1.9 Automations — NOT applied; a second, real API limitation

**The original plan's automations were not applied — not by choice, by
API limitation, found and confirmed, not assumed.** GitHub Projects v2's
built-in workflow automations ("when an item enters Status X, do Y") are
a real GraphQL type (`ProjectV2Workflow`), but the public schema exposes
only `deleteProjectV2Workflow` — **no `create`/`update` mutation for
workflows exists in the public API** (confirmed by introspecting
`__schema.mutationType.fields` directly). This is not documented
prominently by GitHub and was not knowable without checking.

**What this means:** the automation rules below remain the *intended*
behavior, same reasoning as originally designed, but must be configured
**once, manually, in the Project UI's own "Workflows" panel**
(the ⚙ icon on the Project page) — there is no remaining engineering
work, only a UI click-through the API cannot perform on anyone's behalf:

```
new Issue                          → Status: Backlog
PR opened, linked to an Issue      → Status: In Progress
PR merged, Risk = Reversible
  or Shared Semantics              → Status: Done
PR merged, Risk = Protocol
  Sensitive or Economic/Security
  Critical                        → Status: Validation (NOT Done —
                                      a human moves it to Done only
                                      after confirming the evidence)
```

**Deliberately never automated, whether by API or by the UI's own
Workflows panel:** Evidence Status. `PR merged ≠ property validated` —
the lie an "auto-set Evidence Status = Validated on merge" rule would
tell — is avoidable by simply never configuring that specific
automation, which is what's recommended here.

---

## 2. Master Backlog — classification, not conversion to Issues

**Still no real GitHub Issues were bulk-created from the backlog** —
that discipline is unchanged. What changed in the M9.9 Completion Delta:
7 **draft items** (Project-only cards, not repository Issues — lighter-
weight, no Issue-template ceremony, no notification noise) were added
to the now-live Project for exactly the items that were already scoped
and bounded enough to be real work, not speculation: M10, and the 6
registered residuals (§5). Every Bucket-D/E item below remains **text
only**, deliberately not a Project item at all — converting a named-but-
undocumented hypothesis into a card would misrepresent it as scoped
work. Opening the first real repository Issue (as opposed to a draft
card) is still left as the next, natural action for whoever actually
starts M10 or a residual, not manufactured here.

### A. Executable now
Nothing in the existing `docs/BACKLOG.md` P0/P1 table is actually
"executable now" — it's ~95% already ✅ Done (verified against real code
throughout this session and prior ones). The one live executable-now
front is **M10 — SDK Adapter** (§4 below) — now a real draft item in the
Project, `Status: Ready`, `Workstream: SDK`, `Priority: P0`,
`Mission: M10 (unblocked)`.

### B. Near-term
- `docs/TECHNICAL_DEBT_AUDIT.md` items 40–43 (registered this freeze,
  §5 below) — each is a bounded, scoped, well-understood gap. Each is
  now a draft item in the Project, `Status: Backlog`.
- CI reliability: the swagger-ui parallel-load flake (§6 below) and the
  newly-found structurally-broken `CI`/`CI Tests` workflows (§8) — both
  now draft items, `Workstream: Repository/CI`.
- SDK/repository hygiene items already named in `docs/TECHNICAL_DEBT_AUDIT.md`
  (items 25–30: SDK interface, input validation, error types, `/v1/`
  hardcoding, `disconnect()`, `@tanstack/react-query` peer dependency).

### C. Architectural fronts
*(Wayfinding, `docs/ENGINEERING_GOVERNANCE.md` §16.3: a bucket-C front is
a Program too large to resolve honestly in one Mission. Work it by
decomposing into decisions first — Decision Frontier Review, §16.1 — not
by writing implementation tickets directly against it.)*
- `docs/BACKLOG.md`'s H1–H9 MULTISIG production-hardening debt
  (dust validation, `keyIndexFor()` collision strategy, outpoint
  persistence, client key recovery design).
- `INV-OP-9`'s own disclosed gap: no shared wallet-side PSBT-construction
  primitive exists yet (`docs/PROTOCOL_INVARIANTS.md`).
- Multi-Attempt Execution Identity (T1/T2) — `docs/TECHNICAL_DEBT_AUDIT.md`
  item 40, needs its own scoped investigation mission before any
  implementation, per the M9-TC report that found it.

### D. Research / Hypothesis — **named only, not elaborated**
The following fronts were named in Mission 9.9's own brief. **None has
any write-up anywhere in this repository** (confirmed directly — a
repository-wide search for each name returned nothing outside this
document and `ENGINEERING_GOVERNANCE.md`'s own reference to this list).
They are registered here at exactly the abstraction level that's honest:
a name, not a scope, not a design, not a commitment.

Capability Composition Architecture · Capability Negotiation (exact
mechanism) · Cross-Stack Interaction · Ecosystem Flywheel Hypothesis ·
Network Effect Measurement · WDK-style Developer Abstraction Principle ·
Sails Composition Principle · ZK / anonymous credentials · Sails
Trilemma formulation · Portable Economic Proofs · Pubky · PKARR · Nostr
as transport · Pear as mandatory transport · a universal
interoperability layer · Automatic World-C convergence (registered more
concretely as Technical Debt item 40's dependency, see Bucket C) ·
Arbitration Market (beyond what RFC-021 already implements) · Context /
Knowledge Architecture (the full sweep — `ENGINEERING_GOVERNANCE.md` §13
only lays the vocabulary) · Archify · Whitepapers · Engineering
Philosophy (as a dedicated document, distinct from
`docs/PHILOSOPHY.md`) · Final External Red Team.

**DLC was removed from the roadmap in a prior session and is not
reintroduced here.**

#### D.1 Agent & Developer Interfaces (registered 2026-08-31, addendum)

A narrower, more concrete sub-front than the flat list above, worth its
own grouping because it's a real question already partially live in this
repository (`.github/agents`, `.github/skills` exist; MCP/WebMCP were
already named in the Mission 9.9 brief's own Master Backlog preservation
list). Registered here exactly as raised — **a design hypothesis, not
frozen architecture, and not implemented by this addendum**:

- ⬜ Sails CLI / Developer Tooling
- ⬜ Canonical Interaction / Tool Surface
- ⬜ MCP Server
- ⬜ WebMCP Adapter
- ⬜ CLI Adapter
- ⬜ Capability discovery / introspection
- ⬜ CLI conformance / verification tooling
- ⬜ Human / Agent semantic parity

**CLI specifically splits into two, deliberately not treated as one
item:**

1. **Developer/Protocol Tooling CLI** — inspecting canonical objects
   (`sails inspect trade`, `sails verify outcome/evidence/correspondence`,
   `sails conformance run`, `sails providers list`) — the stronger
   candidate, since it's close to what `docs/ENGINEERING_GOVERNANCE.md`
   §3.2's Credible Exit direction already implies: someone should be able
   to inspect/verify Sails artifacts without depending on any one party's
   UI. Not scoped or scheduled here — a named candidate only. **Initial
   scope hypothesis** (still a hypothesis, not a spec): protocol object
   inspection; evidence verification; Outcome verification;
   correspondence verification; conformance tooling; provider/capability
   introspection; integration/debugging support.
2. **Full trading-client CLI** (create trades, negotiate, sign, settle,
   operate agents) — a future hypothesis, explicitly **not** something to
   scope now; it depends on SDK/OpenP2P maturing further first. **Not
   frozen as an architecture and not implemented by this registration.**

**Preserved, unchanged:**

> Different interfaces. Same economic meaning.
> MCP/WebMCP/CLI tool access ≠ economic authority.

**Explicit non-decision:** CLI, MCP, and WebMCP are not, and are not
made, part of Core by this registration — whatever the eventual answer
to the Canonical Tool/Interaction Surface question below turns out to
be, it is an adapter-layer question, the same category as `TransportProvider`
(RFC-002) or `SettlementProvider`, never a Core boundary change.

**The open architectural question, registered for future investigation,
not answered here:** whether CLI, MCP, and WebMCP should each
independently reimplement protocol semantics, or whether they should all
be thin adapters over one **Canonical Tool/Interaction Surface** — the
same "one canonical construction/verification path per concern" discipline
`docs/PROTOCOL_INVARIANTS.md`'s `INV-OP-9` already applies to MULTISIG
transaction construction, generalized to *tool* surfaces instead of
*settlement* construction. If true, `verify correspondence` would carry
identical semantics whether invoked by a developer via CLI, Claude via
MCP, a browser agent via WebMCP, or a wallet via the SDK — "different
interfaces, same economic meaning." This is not decided, not designed,
and not authorized for implementation by this registration — it is named
so a future investigation mission has a fixed starting question instead
of re-discovering it from a chat transcript.

#### D.2 Public Documentation — Mintlify & Developer Docs (registered 2026-09-01, M9.10-R addendum; expanded 2026-09-01, M9.10 Final Governance Checkpoint)

Named for future investigation per the M9.10-R mission brief's own
explicit instruction, and re-asserted with fuller scope in the M9.10
Final Governance & Pre-Merge Checkpoint mission — **not scoped, not
designed, not started, and not authorized for implementation by this
registration.** Same discipline as D.1: a name and a rough shape, not a
spec.

- ⬜ Mintlify plugin capability audit — what Mintlify itself can actually
  do (not investigated)
- ⬜ GitHub → Mintlify sync audit (what would actually need to publish,
  from where, kept in sync how — not investigated)
- ⬜ Automatic deployment behavior (on what trigger, from what branch —
  not investigated)
- ⬜ Repository as canonical source of truth (the public docs site is a
  presentation layer, never an independent source of protocol claims)
- ⬜ Public / internal documentation boundary (the same "would a reader
  without context leave confused, alarmed, or with a stale picture?"
  test `docs/GOVERNANCE.md` §6C already applies elsewhere in this repo,
  extended to whatever ends up public-facing under Mintlify)
- ⬜ Documentation information architecture (IA) for a public docs site,
  distinct from this repo's internal `docs/` tree
- ⬜ CURRENT CANONICAL / SUPERSEDED / HISTORICAL / REJECTED / RESEARCH /
  HYPOTHESIS handling — a status taxonomy for public docs content,
  distinct from (but inspired by) this Project's own Status/Evidence
  Status fields
- ⬜ Getting Started
- ⬜ Architecture overview
- ⬜ Protocol concepts
- ⬜ SDK documentation
- ⬜ Integration guides
- ⬜ Examples
- ⬜ Demonstrated properties
- ⬜ Security model / limitations
- ⬜ Claim-safe documentation — same discipline as this document's own
  "OUTPUT ≠ EVIDENCE ≠ PROPERTY ≠ CLAIM" separation, applied to
  external-facing copy instead of internal mission reports
- ⬜ Documentation versioning (tied to SDK releases? protocol versions?
  neither is decided)
- ⬜ AI-readable documentation

**Preserved, unchanged, verbatim:**

> GitHub owns the truth. Mintlify presents the truth.

> Public documentation must describe the protocol that exists, not the
> protocol we hope to have.

**Explicit non-decision:** whether this becomes a real Mintlify site, a
different static-docs tool, or stays inside this repo's own `docs/` tree
long-term is not decided here — named so a future investigation mission
has a fixed starting question instead of re-discovering it from a chat
transcript.

**Correction — 2026-09-04, Cold Sweep Institutional Sync.** The text
above (2026-09-01) is preserved verbatim as the historical record of
what was true when it was written. It is now stale: a real Mintlify
site (`satsails.mintlify.site`, ~28 populated pages — Introduction,
Quickstart, Architecture, Concepts, Guides, SDK, and a full REST API
reference) already exists and is live, closing the "whether this
becomes a real Mintlify site" non-decision above as **yes, it already
has**. This does not close the rest of D.2's unstarted items (sync
audit, IA, versioning, etc. remain genuinely not investigated) and does
not authorize any content change to that site. Currently authorized:
registering that a **Current Truth Reconciliation** pass against it is
required (`docs/BACKLOG.md`'s "Cold Sweep Institutional Sync" entry —
P0 findings only: a self-contradictory custody claim, `LIQUID_COVENANT`
presented as available despite being reserved/unimplemented, an
unqualified reputation-portability claim, and a stale LIGHTNING_HODL
mechanism description). Not authorized by this correction: any P1/P2/P3
expansion, any actual edit to the Mintlify site, or a decision on the
sync-audit/IA items still listed above as not investigated.

**Documentation surface responsibility model (registered 2026-09-04,
Cold Sweep Institutional Sync)** — this section already gestured at
part of this ("GitHub owns the truth. Mintlify presents the truth.");
recorded here in full now that the other surfaces are confirmed to
exist, not as a new governance framework:

- **Repository — TRUTH.** Authoritative home for protocol semantics,
  code, architecture, RFCs, evidence, invariants, the Master Backlog,
  demonstrated properties, and limitations.
- **Mintlify — BUILD / INTEGRATE.** Primary developer-facing surface
  (SDK, API, quickstart, integration, examples, provider
  capabilities/limitations, developer-relevant trust/security
  boundaries). Derived and non-authoritative.
- **GitBook — UNDERSTAND.** Broader explanatory/ecosystem/product/
  protocol surface. Derived and non-authoritative. Technical sync
  model: **INSUFFICIENT EVIDENCE** — no in-repo config
  (`.gitbook.yaml`/`SUMMARY.md`-equivalent) exists at any point in this
  repository's git history; confirmed live and auto-triggered on every
  push to `main` via commit-status metadata only. Not invented or
  assumed further than that.
- **GitHub Wiki — REMEMBER.** Future historical/engineering knowledge
  layer. Current status: **LOCKED / NO WRITES**. Eligibility pipeline:
  Hypothesis → Investigation → Evidence → Adversarial Review → CTO Gate
  → Freeze → Wiki Eligibility Review → optional publication, plus two
  guards — (1) Wiki material must link back to the frozen repository
  evidence/commit it summarizes; (2) if the frozen source is later
  superseded, the Wiki representation becomes eligible for re-review
  rather than silently remaining current. Frozen ≠ automatically
  Wiki-worthy.
- **GitHub Pages / Archify — VISUALIZE.** Mechanically derived
  architecture visualization only (pinned source commit, generated HTML
  never committed — `architecture-pages.yml`). Non-authoritative.

No two surfaces compete for the same concept as independent truth by
design; where overlap exists, exactly one is authoritative and the
others derive from or point back to it. This model is not a new
lifecycle, schema, or synchronization framework — it is a naming of
roles already implied by "GitHub owns the truth. Mintlify presents the
truth." above, now extended to the two additional real surfaces
(GitBook, prospective Wiki) confirmed to exist since that line was
written.

#### D.3 Preservation-only additions (registered 2026-09-01, M9.10 Final Governance Checkpoint, Phase 6)

Cross-checked against every strategic front named in that mission's own
Phase 6 list. Most were already durably represented — either here (D,
D.1, D.2; Capability Composition/Negotiation, MCP/WebMCP/CLI, Nostr,
Pubky/PKARR, ZK, Portable Economic Proofs, Arbitration Market,
Knowledge Architecture, Whitepapers, Engineering Philosophy, Final
External Red Team), or as real shipped architecture/docs (OpenP2P,
OpenProof, OpenIdentity, OpenReputation, OpenLiquidity, OpenSettlement,
OpenAgents — all named and described in `docs/ARCHITECTURE.md`; Protocol
UX by design and Reference UI — both have their own section in
`docs/ENGINEERING_GOVERNANCE.md` §3.2; Pear/Transport — `TransportProvider`,
RFC-002). The following had **no durable representation anywhere** before
this addition — named only, same "not scoped, not designed" discipline
as the rest of Bucket D:

- ⬜ Selective Disclosure
- ⬜ Privacy Architecture
- ⬜ Versioning / Protocol Lifecycle
- ⬜ Second independent implementation
- ⬜ Multi-language Conformance — distinct from Second independent
  implementation above: this is the conformance harness/vectors
  (`scripts/run-conformance-harness.ts`, `conformance/`) themselves
  being portable/runnable against evaluator implementations in other
  languages, not a second full protocol implementation (registered
  2026-09-02, M9.10 Governance Hardening & Project Reconciliation)
- ⬜ Security Program (an ongoing front, distinct from the one-time
  Final External Red Team already named above)
- ⬜ Prior Art / Novelty Challenge
- ⬜ Productization / Ecosystem Composition (loosely related to
  `docs/ECOSYSTEM_INTEGRATIONS.md`, Bucket E below, but not the same
  scope and not previously named as its own front)
- ⬜ Archify — previously named only as one undifferentiated item; the
  Pass 1 / Pass 2 split from that mission's own list is preserved here.
  **Correction, 2026-09-06 (Current Truth P1+ Cleanup):** this entry was
  stale — Pass 1 has since shipped and merged (PR #54, 2026-09-02,
  `docs/architecture/`, rendered via `architecture-pages.yml`). Pass 2
  remains unscoped, not designed, not started.

#### D.4 WDK / agentic prior-art research (registered 2026-09-02, M9.10 Governance Hardening & Project Reconciliation)

Named per that mission's own explicit list — **not scoped, not designed,
not started, no partnership/endorsement/integration/dependency claimed,
and not authorized for implementation by this registration.** Same
discipline as the rest of Bucket D: a name and a rough shape, not a
spec, not a demonstrated protocol claim.

- ⬜ WDK Modular Capability Composition — study WDK's community-module/
  building-block model as prior art and as a possible capability/
  provider surface beneath Sails
- ⬜ WDK MCP Composition Study — investigate future composition between
  Sails MCP and WDK MCP, preserving **Tool Access ≠ Economic Authority**
- ⬜ WDK Pear Worklet Adapter Study — investigate WDK + Pear/Bare
  integration as a potential execution/runtime composition, without
  coupling Sails Core to Pear
- ⬜ WDK Agentic Architecture Prior Art — track WDK's Agent Skills, MCP,
  CLI, autonomous-agent positioning, and modular financial capability
  model as prior art
- ⬜ Sails Agent Skills — future machine-readable integration knowledge/
  instructions for agents; not implemented now
- ⬜ Canonical Interaction / Tool Surface — preserved as **HYPOTHESIS**:
  investigate whether SDK, CLI, MCP, WebMCP, and Agent Skills can expose
  the same canonical Sails economic semantics without independent
  reinterpretation (same open question already named in D.1, restated
  here in WDK's specific framing)
- ⬜ Capability Composition Architecture — preserve: **"Interoperability
  through capability composition, not stack uniformity"** and
  **"Adapter, not dependency."**
- ⬜ Capability Negotiation / Cross-Stack Interaction — future
  investigation into whether heterogeneous implementations can discover
  compatible identity, transport, and settlement capabilities while
  preserving shared economic semantics
- ⬜ Human / AI / Machine Economic Participants — research hypothesis
  that the same Sails economic semantics may coordinate humans,
  applications, agents, and machines without granting agents implicit
  economic authority
- ⬜ Ecosystem Composition Hypothesis — preserved as **HYPOTHESIS, not a
  demonstrated property**: Sails should benefit when underlying
  ecosystems add capabilities, rather than requiring those capabilities
  to be implemented inside Sails

**Preserved, unchanged, verbatim:**

> Different interfaces. Same economic meaning.

**Strategic WDK/Sails distinction — preserved as strategic hypothesis/
prior-art framing, NOT a demonstrated protocol claim:**

> WDK provides modular financial/execution capabilities. Sails explores
> interoperable economic coordination across heterogeneous capabilities.

No partnership, endorsement, integration, dependency, or demonstrated
interoperability with WDK is claimed anywhere in this registration —
none exists as of this writing.

### E. Future / Parked
Everything in `docs/ECOSYSTEM_INTEGRATIONS.md` and `docs/SDK_usecases.md`
— both already self-labeled "vision/roadmap, not a spec," unchanged by
this mission.

### F. Completed / Frozen
- Constitution / `docs/PROTOCOL_INVARIANTS.md`
- `docs/SEMANTIC_KERNEL.md`
- `docs/CORE_ARCHITECTURE.md` / `docs/CORE_IMPLEMENTATION_ARCHITECTURE.md`
- M0–M8.6, M9-R, M8-RF, M9-F, M9-EI, M9-TC
- **M9 FINAL FREEZE** — `SAILS MISSION 9 RECOVERY BASELINE`,
  commit `b0c581dd26281f230a3795dfdaa48412574ea5c1`

---

## 3. Current program state

```
COMPLETED / FROZEN
  Constitution, Semantic Kernel, Core Architecture, M0–M8.6,
  M9-R, M8-RF, M9-F, M9-EI, M9-TC, M9 FINAL FREEZE
  → baseline b0c581dd26281f230a3795dfdaa48412574ea5c1

  M9.9 — Sails Engineering Operating System
  M9.10 — Repository Security & CI Hygiene
  M9.10 Governance Hardening (enforce_admins: true, PR #40 deviation
    disclosed and remediated — see §8.1)
  M10 — SDK Adapter
    → merge SHA 02e7fb2f502e65ae99323be58c0ba5a4196aba66
    → Verdict B — Partial Adapter / Disclosed Limitations
    → residuals: Correspondence Canonical Read Semantics,
      Historical Arbiter Read Access Policy (both now durable
      Project items, not conversation-only)

CURRENT
  Project Backlog Reconciliation (2026-09-02) — reconciling the
  GitHub Project against the Master Backlog / Norte Fixo (the exact
  38-macrofront strategic map, now durably recorded at
  `docs/NORTE_FIXO.md` — 2026-09-04, Independent Master Backlog Audit).
  Not a protocol implementation mission; capture/classify only.

UNBLOCKED, NOT STARTED
  (none currently designated as the next mission — see the Project's
  own draft items for the candidate frontier)

REGISTERED RESIDUALS  (see §5 — not equal priority; the Project itself
is the durable, up-to-date list — this is a snapshot, not the source
of truth)
  1. Multi-Attempt Execution Identity (T1/T2)
  2. Settlement Consistency Read Surface
  3. Volume Semantics after settlement invalidation
  4. Independent Correspondence Re-verifiability
  5. CI Reliability — parallel-load test flake
  6. SDK / repository production hygiene (named, not scheduled)
  7. Correspondence Canonical Read Semantics (M10 residual)
  8. Historical Arbiter Read Access Policy (M10 residual)

Protocol fee: 0%. Intended 0.40% remains OFF.
Multi-rail recovery: NOT demonstrated (MULTISIG only).
Production readiness: NOT claimed.
SDK version: 0.1.3 (unchanged since M10; not published).
```

---

## 4. M10 tracking — COMPLETED (2026-09-02)

Originally a tracking placeholder for the next mission; M10 has since
run to completion. Kept as a historical record rather than deleted —
the Project item (`M10 — SDK Adapter`) is the live, current source of
truth (`Status: Done`, `Evidence Status: Validated`).

```
Title:       M10 — SDK Adapter
Status:      DONE — frozen as SAILS M10 SDK ADAPTER BASELINE
Merge SHA:   02e7fb2f502e65ae99323be58c0ba5a4196aba66
Verdict:     B — Partial Adapter / Disclosed Limitations
Residuals:   Correspondence Canonical Read Semantics,
             Historical Arbiter Read Access Policy
Depends on:  SAILS MISSION 9 RECOVERY BASELINE (b0c581d) — satisfied
Definition:  provided by the M10 SDK Adapter mission brief
```

No M10 code, design, or scope decision was made by *this* section's
original authoring mission (M9.9). M10 itself was later run to
completion as its own, separate, fully-governed mission — see the
table above and `PR #52`.

---

## 5. Registered residuals (not equal priority)

| # | Residual | Source | Priority signal |
|---|---|---|---|
| 1 | Multi-Attempt Execution Identity (T1/T2) | `docs/TECHNICAL_DEBT_AUDIT.md` #40, M9-TC | Architectural front (Bucket C) — needed only before any future automatic World-C claim, not before M10 |
| 2 | Settlement Consistency Read Surface | `docs/TECHNICAL_DEBT_AUDIT.md` #41, M9-TC | Near-term (Bucket B) — small, additive, no schema change |
| 3 | Volume Semantics after invalidation | `docs/TECHNICAL_DEBT_AUDIT.md` #42, M9-TC | Needs a product decision before any code — Product Direction owns the next step, not Engineering |
| 4 | Independent Correspondence Re-verifiability | `docs/TECHNICAL_DEBT_AUDIT.md` #43, M9-EI/M9-TC | Non-blocking, related to future Credible Exit/Conformance work |
| 5 | CI Reliability — parallel-load flake | M9 Final Freeze report §29/§35 | See §6 — real, understood, not an M9 defect |
| 6 | SDK / repository hygiene | `docs/TECHNICAL_DEBT_AUDIT.md` #25–30 | Deliberately not solved broadly now (mission §30's own instruction) — belongs to a future SDK/DX/hygiene mission |
| 7 | `CI`/`CI Tests` workflows structurally broken (not flaky — always fail) | `docs/TECHNICAL_DEBT_AUDIT.md` #44 — **CLOSED** M9.10/M9.10-R (3 layered real root causes found and fixed: missing `prisma generate`, missing workspace-package build, missing `TRUSTED_ARBITRATORS`; see #44/#49/#50) | Both workflows now confirmed green twice consecutively on real GitHub Actions, same commit (`a92f812`) — whether to make them required branch-protection checks is a pending M9.10-R Phase 6 decision, not yet applied |

---

## 6. CI Reliability residual — precise, not inflated

The M9 Final Freeze's first non-Postgres regression run (2441s) had 4
suites / 14 tests time out under `--maxWorkers=50%` parallel load:
`joinTradeAuthorization`, `securityHeaders`, `cors`, `healthLiveReady` —
all suites whose `buildAppWithEnv()` registers `@fastify/swagger-ui`,
already documented in those files' own comments as slow under
contention. Re-run in isolation immediately: 4/4 suites, 22/22 tests
passed. The second full run (2156s) was 147/147 suites clean with no
intervention. **This is CI/test-infrastructure debt — a resourcing
artifact of parallel workers contending for one slow registration path
— not a Mission 9 protocol defect, and it was not fixed during Mission
9.9** (this mission's own §31 instruction: register it, don't fix it
unless a trivial metadata-only correction is needed for Project
organization — none was).

---

## 7. Issue taxonomy

**Rule** (`ENGINEERING_GOVERNANCE.md`'s companion to this doc, stated
here since it's an Issue/label mechanic): **a Project field carries
workflow metadata that changes as work progresses (Status, Evidence
Status). A label carries intrinsic classification that doesn't change
once an Issue exists (what kind of Issue this is, what risk class it
touches).** Putting the same fact in both places would let them drift.

### 7.1 Type labels

Existing GitHub defaults, kept, not duplicated: `bug`, `documentation`,
`enhancement`, `question`, `good first issue`, `help wanted`,
`duplicate`, `invalid`, `wontfix`.

New, created this mission (`gh label create`):

| Label | Color | Meaning |
|---|---|---|
| `architecture` | `#5319e7` | Touches protocol/architecture — routes through `docs/GOVERNANCE.md`'s RFC process |
| `research` | `#c5def5` | Investigation/hypothesis, not yet a commitment |
| `technical-debt` | `#fbca04` | A registered, disclosed gap (`docs/TECHNICAL_DEBT_AUDIT.md`) |

**Rejected as a new label:** `implementation` — redundant with the
existing `enhancement` default; **`validation`** — a Status value
(§1.1), not an intrinsic classification, would duplicate the Project
field the mission's own §12 rule warns against.

### 7.2 Risk labels

| Label | Color | Meaning |
|---|---|---|
| `protocol-sensitive` | `#b60205` | Touches a primitive, state machine, or invariant |
| `security-sensitive` | `#b60205` | Touches authority, signing, or value movement |
| `stop-gate` | `#000000` | A STOP was recorded on this Issue/PR (`ENGINEERING_GOVERNANCE.md` §6) — a legitimate outcome, not a failure marker |

**Deliberately not created as separate labels:** `privacy-sensitive`,
`economic-sensitive` — folded into `security-sensitive` for now (both
already correlate with authority/value-movement concerns in every real
case this repository has had to date); split them out the first time a
real Issue needs the distinction and doesn't fit either existing label,
not preemptively.

### 7.3 Type templates → labels applied automatically

See `.github/ISSUE_TEMPLATE/` — each template applies exactly one type
label on creation; risk labels are applied by a human triager, since
risk classification requires judgment the template's own front-matter
cannot supply.

---

## 8. Branch / merge governance — APPLIED (M9.9 Completion Delta, 2026-09-01)

> **2026-11-07 staffing update / proposed policy transition (PR #589):**
> `alan-schramm` reports being the sole active human developer and removing
> `renipinto` as collaborator. The owner explicitly approves a temporary
> solo-maintainer model with separate technical Gatekeeper, CTO evidence gate,
> and owner-only final merge authorization. See
> `docs/governance/SOLO_MAINTAINER_TRANSITION_PROPOSAL.md`.
> **This is not a live branch-protection snapshot or evidence of a changed
> ruleset.** The integration could not read protection settings (403);
> the historical `required_approving_review_count: 1`, strict status checks,
> and `enforce_admins: true` baseline below remains the last documented
> verified state. No merge is authorized until an authorized GitHub
> operator reads the current effective protection/rulesets and reconciles
> the approved temporary policy. Preserve the historical record below.


**Applied, with explicit authorization from the repository owner**, after
direct investigation found the original recommendation below needed to
change — exactly the "do not blindly reproduce the plan" instruction
this delta mission gave.

**What was actually found, checked directly, not assumed:** `gh run
list --branch main` showed the `CI` and `CI Tests` workflows failing on
essentially every recent push, going back through M9-F, M8-RF, and the
M9 freeze itself — not flaky-sometimes, structurally broken:

- `CI`'s `build` job fails on `npm ci` — `##[error]An error occurred
  trying to start process '/usr/bin/bash' with working directory
  '.../Sails-Protocol/./sails-push-ready'. No such file or directory` —
  a hardcoded working-directory path in `.github/workflows/ci.yml` that
  doesn't exist in a real CI checkout (an artifact of a local nested
  folder layout, never valid in CI).
- `CI Tests`' `test` job fails at the Postgres-service-container step —
  `FATAL: role "root" does not exist`, repeated until timeout — a
  service-container user/role misconfiguration in
  `.github/workflows/ci-tests.yml`.

**Only `CodeQL` (`Analyze (javascript-typescript)`) is reliable** —
confirmed green on every recent run checked. Per this mission's own
explicit instruction ("do not require a flaky/nonexistent status
check"), **`CI`/`CI Tests` were NOT made required checks** — doing so
would have permanently deadlocked every future merge to `main`,
independent of any PR's actual content. This is registered as a new,
distinct residual (`docs/TECHNICAL_DEBT_AUDIT.md` #44) — not fixed here,
fixing CI workflow YAML is unrelated repository hygiene, out of this
mission's scope.

**Applied configuration** (`gh api -X PUT
repos/alan-schramm/Sails-Protocol/branches/main/protection`, verified
live via an independent `GET` immediately after):

```json
{
  "required_status_checks": { "strict": true, "contexts": ["Analyze (javascript-typescript)"] },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
```

**Reasoning behind each real deviation from the original plan:**

- `enforce_admins: false` — unchanged from the original recommendation:
  with a 2-person collaborator set, forcing the sole admin through the
  same gate as everyone else, with no third reviewer to ever unblock a
  stuck PR, would create exactly the "unrecoverable governance deadlock"
  this delta mission explicitly said to avoid. This is the emergency/
  admin recovery path, preserved on purpose.
- `require_code_owner_reviews: false` — considered and **rejected**.
  `CODEOWNERS` names only `alan-schramm`. If he is ever the PR's own
  author (a real, common case — his own git identity authors most
  commits in this repository's actual history, including this one),
  GitHub does not allow an author to approve their own PR, and code-
  owner review would then require exactly the one person who can't
  supply it — a real, self-inflicted deadlock, not a hypothetical one.
  Plain `required_approving_review_count: 1` (any collaborator,
  `renipinto` included) avoids this while still requiring real review.
- `required_status_checks.strict: true` — kept: with real PR volume
  still low, requiring the branch be up to date before merge is cheap
  and catches real drift; revisit if PR volume ever makes this a
  bottleneck.
- Force pushes and deletions on `main`: both disabled, unchanged from
  the original recommendation.
- Signed commits, linear history: still **not** required — no
  justification for either was found in this repository's current
  practice, unchanged finding from the original recommendation.

**Dependabot compatibility, checked directly:** Dependabot PRs in this
repository are same-repo branches (`dependabot/npm_and_yarn/...`), not
cross-fork — `codeql.yml` triggers on `pull_request` targeting `main`
regardless of source, so the one required check (`CodeQL`) does run and
report on Dependabot PRs. They will now need one human approval before
merge (a real, intended behavior change — dependency bumps get reviewed,
not silently auto-merged — not a deadlock).

**Verified live**, immediately after applying: `gh api
repos/alan-schramm/Sails-Protocol/branches/main/protection` (a fresh
`GET`, not a reuse of the `PUT` response) returned the identical
configuration shown above.

### 8.1 Governance deviation on PR #40, and remediation (2026-09-01/02)

The `enforce_admins: false` recovery path documented above was, in
fact, exercised — not hypothetically. PR #40 (Mission 9.10 repository
security, dependency & CI hygiene) was merged by the repository
administrator (`alan-schramm`, also the PR's own author) without
satisfying the required human review and before the required status
checks had completed. `reviews: []`, `reviewDecision` remained
`REVIEW_REQUIRED` at merge time, and no `review_requested`/`reviewed`
event exists anywhere in the PR's GitHub timeline. **This is not
reclassified as a compliant, reviewed merge.**

The resulting merge commit (`8ea9b7be3dcea0177054f58d64374815f2130bec`)
was independently, technically validated post-merge — full regression,
typechecks, Core boundary check, semantic conformance, Prisma
validate/drift, zero Protocol/Core/Kernel/schema diff, protocol fee
confirmed unchanged at 0% — and frozen as **SAILS M9.10 REPOSITORY
SECURITY & CI HYGIENE BASELINE**. Technical validity and governance
compliance are separate axes; one does not imply the other.

**Remediation applied 2026-09-02**: `enforce_admins` changed
`false → true`. Read back live immediately after, confirmed as the
*only* field that changed — every other protection property (required
contexts, review count, dismiss-stale-reviews, force-push/deletion,
signatures, linear history) identical to the configuration above. The
2-person-team tradeoff this section originally weighed is now
accepted deliberately: the sole admin (`alan-schramm`) can no longer
bypass required reviews or required checks on `main`, including on his
own PRs — `renipinto` (or a future additional collaborator) is now
required to approve every PR `alan-schramm` authors, with no
admin-bypass fallback if unavailable.

---

## 9. What was deliberately NOT changed

- `docs/GOVERNANCE.md` — already is the Architecture Change Process
  (RFC/Core-RFC), referenced, not duplicated.
- `CONTRIBUTING.md`'s existing architecture-conventions content
  (naming, Four-Layer Rule, singleton discipline, dead code,
  duplication, module-addition steps) — untouched; a new section was
  added, not a rewrite.
- `docs/BACKLOG.md` — untouched; it is a historical, mostly-✅-Done
  technical backlog and remains valid as that specific record. The
  broader "Master Backlog" the mission describes lives in §2 of this
  document instead, since it covers strategic fronts `docs/BACKLOG.md`
  was never scoped to hold.
- `docs/00-INDEX.md` — two lines added only, pointing to the two new
  documents; no re-ordering, no rewrite of the existing 21-document map.
- `docs/CHANGELOG.md` — left stale exactly as found; reconciling it is
  unrelated pre-existing debt, not created or worsened by this mission.
- Branch protection, repository visibility, collaborator permissions —
  untouched (§8).
- No real repository Issues bulk-created — 7 lightweight draft items
  were added instead, only for already-scoped work (§2, Completion Delta).
- Branch protection's `CI`/`CI Tests` non-inclusion is a finding, not an
  oversight — see §8.
- The two remaining manual, UI-only steps (View grouping/sort, Project
  Workflows automations — §1.8/§1.9) were not simulated as "done" by
  writing about them; they're named as exactly what they are: real,
  small, human steps the public API cannot perform.
