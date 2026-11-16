# Sails Protocol — Timeless Contributor & AI Session Onboarding

> **Purpose:** a stable entry path for humans, AI-assisted engineers, autonomous coding agents, reviewers, Gatekeepers, and new CTO sessions. This is a **router and readiness protocol**, not a parallel constitution, architecture, backlog, harness specification, or dated handoff.
>
> **Maintenance rule:** keep this guide evergreen. No PR numbers, commit SHAs, named active owners, current CI results, current phase percentages, or promises of present production readiness belong here. Live operational state belongs to GitHub; enduring technical truth belongs to the relevant canonical document.

## 1. Read before acting

Start with [repository README](../../README.md), [documentation router](../00-INDEX.md), [project context](../PROJECT_CONTEXT.md), and [system design](../SYSTEM_DESIGN.md).

Then read the institutional [engineering philosophy](SAILS_ENGINEERING_PHILOSOPHY.md), [methodology](SATSAILS_ENGINEERING_METHODOLOGY.md), [principles](SATSAILS_ENGINEERING_PRINCIPLES.md), and [engineering governance](../ENGINEERING_GOVERNANCE.md). Follow [CONTRIBUTING](../../CONTRIBUTING.md) and [CODE_STYLE](../CODE_STYLE.md) before editing code.

Do **not** treat a summary, diagram, handoff, old issue comment, or this guide as overriding its canonical owner. Use [00-INDEX](../00-INDEX.md) to find the owner. If sources disagree, identify the conflict rather than silently reconciling it.

## 2. Understand what must remain true

For protocol-sensitive work, inspect [Semantic Kernel](../SEMANTIC_KERNEL.md) (K1 Valid Transition, K2 Attributed Discretion, K3 Semantic Settlement Independence and Assertion), [Protocol Invariants](../PROTOCOL_INVARIANTS.md), [Protocol Specification](../PROTOCOL_SPECIFICATION.md), [Pure Core Architecture](../CORE_ARCHITECTURE.md), [Core Implementation Architecture](../CORE_IMPLEMENTATION_ARCHITECTURE.md), and relevant [RFCs](../rfcs/00-INDEX.md) / [ADRs](../adr/).

Understand the difference between protocol semantics, reference implementation, runtime, modules, providers/adapters, and applications. Respect ownership boundaries and the distinction between authority, evidence, economic outcome, external execution, and recovery. No dependency, adapter, network, test double, or framework becomes protocol authority by convenience.

## 3. Establish current reality, every session

Before claiming a task is ready, completed, green, frozen, or Day-0 safe:

- Inspect the **live** GitHub Project, relevant Issues, PRs, branch heads, exact-head CI, reviews, and dependencies. [GITHUB_PROJECT](../GITHUB_PROJECT.md) describes the operating model; it is not a substitute for live state.
- Consult [BACKLOG](../BACKLOG.md) for unresolved institutional truth and dependency history. Do not confuse it with a live execution queue or a product roadmap.
- Determine whether the proposed work is Day-0 critical, a current backlog obligation, research, or explicitly deferred evolution. Do not silently promote future ideas into current implementation.
- Check for parallel missions and ownership; avoid conflicting branches, duplicate fixes, and overlapping authority.
- Treat previous session handoffs as **provenance**, then independently verify material claims.

If live access is unavailable, disclose that limitation and do not manufacture status.

## 4. Evidence, harness, and STOP

Apply the consequence-weighted workflow and Definition of Ready/Done in [ENGINEERING_GOVERNANCE](../ENGINEERING_GOVERNANCE.md), including its AI engineering discipline, STOP conditions, and evidence ladder. Use the smallest harness capable of **falsifying the actual property**; name the property and observation seam before tests. Never mock the property under proof.

For financial authority, settlement, signing, concurrency, or recovery, require appropriate adversarial and real-boundary evidence (for example, real PostgreSQL where transaction semantics are at issue). A passing mock, typecheck, or green CI cannot alone prove an external effect, exactly-once behavior, or production readiness. Preserve UNKNOWN vs FAILED and fail-closed behavior.

Use the repository's actual test scripts, [CONTRIBUTING](../../CONTRIBUTING.md), applicable test/harness documents, and workflow definitions; verify commands against the current repository rather than hardcoding a timeless list. Separate **output, evidence, demonstrated property, and authorized claim**.

**STOP and record the question** when a frozen invariant would change, evidence contradicts the design, a consequential fact cannot be established, or authority is unclear. Correct STOP > artificial PASS. Escalate architecture/spec changes via [GOVERNANCE](../GOVERNANCE.md) and the relevant RFC/ADR path.

## 5. Role-specific entry

**Human developer or AI-assisted developer:** confirm issue scope and owner; read the touched canonical contracts; implement one observable vertical slice; match repository style; provide falsifiable acceptance evidence and reviewable PR notes.

**Coding agent (including Claude):** obtain a bounded mission, explicit out-of-scope list, dependencies, acceptance tests, and permission boundaries. Do not infer authority from tool access. Return exact branch/commit/PR references, tests actually run, failures, residual uncertainty, and backlog delta.

**Reviewer or Gatekeeper:** independently check property vs evidence, adverse cases, architecture/invariants, risk, regression scope, exact HEAD and CI. Challenge the implementation without silently redefining protocol meaning. Record pass, fail, or STOP with reasons.

**New CTO session:** read this guide and canonical governance first; ingest the latest handoff, then independently reconcile it against live repository and Project state. Map critical gates, workstream owners, conflicting PRs, blocked dependencies, and decision frontier. Present a concise takeover baseline before authorizing new work. Do not treat a handoff as authorization for merge, freeze, or deploy.

## 6. Minimum takeover / mission baseline

Use this template **in the session or mission record**, not in this evergreen guide:

- **Role and scope:** what I own; what is explicitly outside my authority.
- **Verified sources:** canonical documents and live state actually inspected; access gaps.
- **Active work:** issue/PR, branch, exact HEAD, owner, dependency and CI/review status.
- **Invariant / property at risk:** expected behavior, adversarial counterexample and required harness.
- **Evidence classification:** hypothesis, implemented, demonstrated, validated, or STOP; no inflation.
- **Decision frontier:** resolved prerequisites, unresolved questions and required human decisions.
- **Next bounded action:** smallest safe batch, acceptance evidence, rollback/stop condition.
- **Handoff delta:** what changed, what did not, and where durable truth was recorded.

## 7. End every mission without losing context

Update the **correct canonical owner** when a durable decision or material finding changes. Link Issues/PRs to evidence and update backlog deltas without duplicating entire histories. Preserve rejected alternatives and unresolved risks where relevant. Never bury important institutional knowledge only in chat, a transient agent memory, or a CI log.

**Invariant of this guide:** Não duplicar. Não perder. Não inflar. Não esconder.
