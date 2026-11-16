# Sails Protocol — Contributor and AI Agent Entry Point

**Read before making changes, recommending a merge, or accepting a mission.** Applies to human contributors, AI-assisted developers, coding agents, reviewers, Gatekeepers, and new CTO sessions.

This file is a **navigation and onboarding contract**, not a new source of protocol truth. It deliberately contains no current PR numbers, dates, release claims, or copied invariants.

1. Read [the timeless onboarding guide](docs/engineering/AI_SESSION_ONBOARDING.md) and follow the role-specific path.
2. Use [documentation routing](docs/00-INDEX.md) and [system design](docs/SYSTEM_DESIGN.md) to locate the *governing* source for each question.
3. Follow [engineering governance](docs/ENGINEERING_GOVERNANCE.md), [contribution rules](CONTRIBUTING.md), and [code style](docs/CODE_STYLE.md).
4. For consequential changes, identify the applicable Semantic Kernel, Protocol Invariants, Core Architecture, specification, accepted RFCs/ADRs, and acceptance evidence **before** implementation.
5. Reconcile live GitHub Issues, Project, PRs, branches and exact-head CI. Historical handoffs are context, not live state.
6. **STOP** on unresolved authority, contradictory evidence, changed frozen semantics, or unverifiable consequential claims. Escalate through the existing governance process.
7. Agent access is not authority. No agent may infer permission to merge, deploy, freeze, or silently redefine architecture.

**Core rule:** OUTPUT ≠ EVIDENCE ≠ PROPERTY ≠ CLAIM. Make reality pass the test; do not make the test pass instead of reality.

If a linked file moves, repair this router and its links; do not recreate its rules here.

## Permanent CTO policy — evidence-based progressive integration

**Goal:** build the protocol incrementally on `main`; do not accumulate completed, compatible work indefinitely in Draft PRs or long-lived branches. `main` is the continuously integrated, tested reference, **not** a declaration of production readiness.

- Prefer small, cohesive, reviewable PRs. For every open PR, record owner, exact HEAD/base, risk, dependencies, required evidence, blocking condition, and next action. EPM should surface PRs ready for a decision and administrative waiting time.
- Use risk-proportionate review: **R1** documentation/non-executable changes (diff, consistency, applicable checks); **R2** isolated SDK/UI/refactors (CI, contracts, compatibility, integration/regression tests); **R3** escrow, settlement, permissions, migrations, economic/security-critical changes (full applicable CI, invariants, adversarial and migration tests, formal Gatekeeper VERIFY). Reclassify upward if a nominally small change has higher-risk effects.
- Work in parallel when safe: engineers implement and produce evidence; reviewers pre-review architecture, contracts and risks; final approval must cover the **exact HEAD** and any delta since pre-review. Green CI alone is never approval.
- Standard path: **implement → test/CI → risk-appropriate VERIFY → explicit CTO GO for identified PR/HEAD → merge → verify integrated `main`**. Revalidate dependent PRs against the updated base. No automatic merge authority is implied.
- A HOLD must identify concrete missing evidence or incompatibility, owner, and an objective release condition. Do not leave approved work in Draft for administrative inertia; do not waive critical evidence to reduce waiting time.
- Incomplete components may be merged only when isolation and non-activation are **demonstrated**, contracts remain compatible, and existing safety invariants hold. Feature flags alone are not proof of isolation.
- **Merge is not deployment.** Integration into `main` does not authorize server deployment, persistent database migration, release, or economic activation. All current institutional STOP/HOLD rules and formal Day 0 homologation requirements remain binding; only explicitly authorized, scoped merges may proceed.
- Measure time from green CI to merge decision, age of ready/Draft PRs, unowned blockers, post-merge regressions, and review wait. Never invent metrics or claim tests prove absence of all possible failures.

**CTO handoff question:** “What concrete evidence is still missing to integrate this PR safely into `main`?” If none, route it promptly for an explicit decision; if evidence is missing, assign its production and verification. Preserve the governing architecture, ADRs/RFCs, invariants, and existing authority hierarchy. This section is a workflow policy, not permission to override them.
