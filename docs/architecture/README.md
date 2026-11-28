# Sails Protocol — Architecture Diagrams (Archify Pass 1)

## Purpose

This directory holds the first canonical visual representation of the
Sails Protocol architecture demonstrated through the M0–M10 cycle,
generated with [Archify](https://github.com/tt-a1i/archify) — a
typed-JSON-IR diagramming tool that compiles architecture, workflow,
sequence, data-flow, and lifecycle specifications into validated,
interactive, self-contained HTML.

These diagrams exist to help experienced engineers orient quickly,
help future contributors understand authority and semantic boundaries,
help security reviewers reason about economic transitions, and help
non-coders with technical/product background follow the system without
relying only on prose.

**Archify helps represent architecture. It does not define architecture.**

## Normative source

**These artifacts represent Sails Protocol architecture. They are not
normative sources of protocol semantics.** The repository's own
architecture, specification, and evidence — `CORE_ARCHITECTURE.md`,
`SEMANTIC_KERNEL.md`, `CORE_IMPLEMENTATION_ARCHITECTURE.md`,
`DESTINATION_AUTHORITY_ARCHITECTURE.md`, `PROTOCOL_INVARIANTS.md`, the
RFCs under `docs/rfcs/`, and the shipped code itself — remain
authoritative. Where a diagram and a document ever appear to disagree,
the document governs and the diagram is wrong; report it rather than
trusting the picture.

## Status: Archify Pass 1

This is the **first** canonical diagram pass, not the final visual
architecture of the complete Sails ecosystem. It covers the high-level
layer map, the authority-axis distinctions, the economic transition
lifecycle, the dispute/attributed-authority sequence, settlement/
destination authority, the recovery model, and the M10 SDK Adapter
read-boundary — seven diagrams in total, produced under an explicit
representation-only mandate (no architecture redesign, no inferred
missing architecture, no hypotheses promoted to implemented fact).

**Baseline analyzed:** repository revision
[`de2afb8a6aa38d0a1ac783f1ef55f4767312883b`](https://github.com/alan-schramm/Sails-Protocol/commit/de2afb8a6aa38d0a1ac783f1ef55f4767312883b)
(`main`, the frozen **SAILS PROJECT BACKLOG RECONCILIATION BASELINE**,
a descendant of the **SAILS M10 SDK ADAPTER BASELINE** at `02e7fb2f`).

## Artifacts

| File | Type | Represents |
|---|---|---|
| `sails-high-level.architecture.json` | architecture | Semantic Kernel → Modules → Pure Core → Runtime → Providers → SDK Adapter → Integrator |
| `authority.architecture.json` | architecture | Economic Disposition / Destination / Execution / Information-Access authority — four independent axes |
| `economic-transition.lifecycle.json` | lifecycle | Condition evaluation → transition → durable record → execution → recovery |
| `dispute-authority.sequence.json` | sequence | Raise dispute → signed attributed ruling → Core evaluation → durable record → settlement → independent SDK read |
| `settlement-destination.architecture.json` | architecture | Authorized Outcome → Destination Authority → Settlement Provider → execution → external observation |
| `recovery.workflow.json` | workflow (schema v2) | RECOVERY = f(durable facts, external facts) — MULTISIG-only today |
| `sdk-adapter.architecture.json` | architecture | Core evaluation → durable semantic record → read-only projection → HTTP → SDK → integrator |

## Live, always-current rendered site

**[alan-schramm.github.io/Sails-Protocol](https://alan-schramm.github.io/Sails-Protocol/)**
— published automatically by
[`.github/workflows/architecture-pages.yml`](../../.github/workflows/architecture-pages.yml)
every time a push to `main` touches `docs/architecture/archify/**.json`,
using [`scripts/build-architecture-pages.mjs`](../../scripts/build-architecture-pages.mjs)
against a pinned Archify commit. Diagram type is read from each file's
own `diagram_type` field, so adding or renaming a diagram never needs
a workflow edit. This is the easiest way to view a diagram — no local
install needed — and it can never drift from what's actually committed,
since nothing else produces the published HTML.

## Regenerating and validating the HTML locally

Generated HTML is **intentionally not stored in Git** — see below. The
CI workflow above is the canonical regeneration path; to do the same
locally (e.g. before opening a PR that changes a diagram):

```bash
node scripts/build-architecture-pages.mjs <path-to-archify>/bin/archify.mjs _site
```

Or invoke Archify directly on a single file, using the current Archify
workflow:

```bash
# one-time: install Archify per its own README (npx skills add tt-a1i/archify -g),
# or clone https://github.com/tt-a1i/archify and use its bin/archify.mjs directly

# validate (architecture-typed files can pin --repo-root to re-verify
# every source citation against this repository; lifecycle/sequence/
# workflow files reject --repo-root — see "Source evidence" below)
node <path-to-archify>/bin/archify.mjs validate architecture \
  docs/architecture/archify/sails-high-level.architecture.json \
  --quality showcase --repo-root . --json

# deliver (render + validate + atomically write the HTML)
node <path-to-archify>/bin/archify.mjs deliver architecture \
  docs/architecture/archify/sails-high-level.architecture.json \
  /tmp/sails-high-level.architecture.html \
  --quality showcase --repo-root . --json
```

Substitute the diagram's real type (`architecture`, `lifecycle`,
`sequence`, or `workflow`) for the two lifecycle/sequence/workflow
files, and drop `--repo-root` for those three (unsupported for those
types — see below). All seven files validate and deliver cleanly at
`--quality showcase` (9/9 artifact checks, 0 composition errors, 0
warnings) as of this pass.

## Why generated HTML is not committed

The JSON IR (~32 KB across all seven files) is the actual source of
truth, is small enough to review meaningfully in a diff, and
deterministically regenerates the exact same validated HTML. The
generated HTML (~700 KB per diagram, ~4.9 MB total) is derived,
binary-ish output that would bloat the repository and produce
unreviewable diffs on every regeneration. Build it on demand, or
publish it separately (GitHub Pages, a release artifact) if a
clickable, hosted version is wanted.

## Source evidence

Archify supports Git-verified, revision-pinned source citations
(`meta.repository` + per-node `sources`) **only for the `architecture`
diagram type** — confirmed directly against Archify's own schema and
authoring contract. The four architecture-typed files in this
directory (`sails-high-level`, `authority`, `settlement-destination`,
`sdk-adapter`) carry citations that Archify independently verified
against this repository at the pinned revision above (commit, blobs,
and line ranges all Git-proven, not merely typed). The `lifecycle`,
`sequence`, and `workflow` diagram types do not support this mechanism
at all as of Archify v2.17.0-dev.1 — `economic-transition.lifecycle`,
`dispute-authority.sequence`, and `recovery.workflow` carry no source
pins for this reason, not because their content is less grounded.

## Known residuals and limitations (Pass 1 does not claim these are solved)

- **Correspondence Canonical Read Semantics** — not exposed through the
  SDK; multiple legitimate `CorrespondenceEvaluation` rows can exist
  per appeal round with no selection rule invented.
- **Historical Arbiter Read Access Policy** — an open question, not
  decided either way by this pass or by the M10 SDK Adapter.
- **Canonical Semantic Profile** — architecturally required, not yet
  specified (`CORE_ARCHITECTURE.md` §18); represented in the
  high-level diagram as an explicitly tagged residual, not a built
  layer. **Corrected/Implemented 2026-11-27:** a first profile, `sails-semantic-profile@1.0`, is now published (`conformance/profiles/sails-semantic-profile-1.0.json`). That does not demonstrate an independent second implementation or a certification.
- **Workflow Terminal ≠ Mathematical Irreversibility** and
  **Historical Completion ≠ Current Settlement Satisfaction** — both
  real, disclosed architectural debt (`TECHNICAL_DEBT_AUDIT.md` #40,
  #41), not resolved by drawing the lifecycle diagram.
- **Recovery's authoritative-truth primitive is MULTISIG-only** — no
  equivalent exists yet for LIGHTNING_HODL, SAFE_GUARD_EVM, or
  MOCK/WDK_USDT_EVM.
- **Mission13's K2 guarantee is Target 1 (verifiable attribution), not
  Target 2** (cryptographic impossibility of divergence) — a colluding
  server could still, in principle, produce an inconsistent
  disposition; what's guaranteed is that this is independently
  detectable, not that it cannot happen.
- Multi-language conformance, a second independent implementation,
  full multi-rail conformance, production readiness, protocol fee
  activation, fully decentralized deployment, and final privacy/agent/
  transport architecture are all out of scope for this pass and are
  not implied solved by any diagram here.

## Governing principle

> Archify helps represent architecture. It does not define architecture.
