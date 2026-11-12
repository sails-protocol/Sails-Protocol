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


## Gatekeeper: AUDIT / REMEDIATE / VERIFY

Gatekeepers may **investigate and help fix** the defects they find; they are not restricted to writing reports. Apply the same consequence-weighted gates and authority model in [engineering governance](docs/ENGINEERING_GOVERNANCE.md), and check live ownership before touching code.

- **AUDIT:** independently reproduce an issue, challenge the claimed property, preserve evidence, and record a reasoned GO/HOLD/STOP against an exact HEAD.
- **REMEDIATE:** after a bounded mission/CTO authorization (especially for economic paths), implement a minimal correction on an **owned branch/worktree**, add falsifiable regression tests, and open a **Draft PR** with exact SHA, diff, tests, CI, and residual risks. A Gatekeeper may propose a fix immediately, but must not silently take over another agent's assigned work, edit another agent's branch, or bypass the existing Issue/Project ownership.
- **VERIFY:** independently re-audit a correction written by **someone else**, including adverse cases and real-boundary evidence where needed. **An author must never be the sole independent verifier or issue the final independent GO for their own fix.** Arrange cross-review by a separate Gatekeeper/reviewer; the CTO's decision is distinct from independent verification.

**No implicit promotion:** finding a defect does not grant authority to change protocol invariants, ADRs, migrations, economic semantics, scheduler/deploy wiring, or activation policy. Escalate scope and architecture changes; preserve fund safety, UNKNOWN vs FAILED, chain truth, and provenance. No agent may merge, deploy, freeze, or activate economics without the applicable explicit approvals. Green CI and self-authored tests are not independent sign-off.

For role-specific onboarding use [AI session onboarding](docs/engineering/AI_SESSION_ONBOARDING.md); for binding authority, gates and solo-maintainer merge procedure use [engineering governance](docs/ENGINEERING_GOVERNANCE.md). This section defines the Gatekeeper workflow only; it does not replace either canonical owner.

**Core rule:** OUTPUT ≠ EVIDENCE ≠ PROPERTY ≠ CLAIM. Make reality pass the test; do not make the test pass instead of reality.

If a linked file moves, repair this router and its links; do not recreate its rules here.
