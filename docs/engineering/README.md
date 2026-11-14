# Sails Engineering — Institutional Memory

This directory preserves the engineering philosophy, methodology, principles and intellectual references that emerged during the construction of Sails Protocol.

These documents exist because important engineering knowledge must survive the conversation, person or AI session that produced it.

> **Não duplicar. Não perder. Não inflar. Não esconder.**

## New contributor / AI session entry

Before taking a development mission or assuming a CTO, Gatekeeper or agent role, start with the [timeless contributor and AI session onboarding guide](AI_SESSION_ONBOARDING.md). The root [AGENTS.md](../../AGENTS.md) provides the short entry point. These are navigation and readiness aids, not new normative sources.

## Documents

1. [Sails Engineering Philosophy](SAILS_ENGINEERING_PHILOSOPHY.md) — why the engineering approach emerged, the relationship between AI, evidence, judgment, consequence and permanence.
2. [Satsails Engineering Methodology](SATSAILS_ENGINEERING_METHODOLOGY.md) — how work moves, how missions are gated, and why AI-assisted development must not optimize proxies instead of reality.
3. [Satsails Engineering Principles](SATSAILS_ENGINEERING_PRINCIPLES.md) — the standards used to judge architecture, product, authority, security, failure semantics, production reality and engineering quality.
4. [Intellectual & Engineering References](INTELLECTUAL_ENGINEERING_REFERENCES.md) — intellectual provenance and comparative systems used to generate properties and adversarial questions.

## Authority boundary

These are **institutional engineering guidance**, not a second protocol constitution.

They do not replace the canonical sources that own protocol meaning: Semantic Kernel, Core Architecture, Core Implementation Architecture, Protocol Specification, Protocol Invariants, accepted ADRs/RFCs, BACKLOG, ROADMAP or ENGINEERING_GOVERNANCE.

If a philosophical or methodological summary conflicts with a governing normative source, **the governing source wins**.

These documents may motivate a challenge. They do not silently redefine architecture.

> **Anyone may challenge the architecture. No one may silently redefine it.**

## Relationship between the four documents

Philosophy → why we think about engineering this way.

Principles → what qualities and boundaries we protect.

Methodology → how work moves and how claims earn confidence.

Engineering Governance → how those ideas become repository authority, gates and decisions.

The intellectual references are orthogonal input:

**Reference / prior art → Insight → Property → Adversarial Question → Evidence → Sails Decision**

Never: **Author / mature project → Copy implementation**.

> **We borrow properties, not personalities.**

## AI-development guardrail: Cobra Effect

The methodology explicitly records the **Cobra Effect** as a development risk.

When a metric becomes a target, humans and especially autonomous/AI agents may optimize the metric rather than the reality it was intended to represent.

Examples include making tests green by weakening tests, optimizing for a desired verdict, increasing coverage with low-value tests, fragmenting work to increase issue count, suppressing bug registration, removing inconvenient CI checks, or implementing specifically against known Red Team cases rather than the underlying property.

Therefore:

- CI green is evidence, not the objective;
- issue count is not progress;
- a gate verdict is not the property;
- test coverage is not correctness;
- agent completion is not mission success;
- finding more problems is not automatically better auditing;
- closing more findings is not automatically better engineering.

This is particularly relevant to repeated Day-0 audits: once a sufficiently broad audit owner exists, additional sweeps should be driven by new evidence, changed implementation, battle-tested failure modes or a concrete uncovered property — not by a standing incentive to manufacture more findings.

## Goodhart's Law — proxy metrics are not the property

A closely related guardrail is **Goodhart's Law**: when a measure becomes a target, it tends to stop being a good measure.

In Sails engineering, a proxy may help us observe reality, but it must not silently replace the property we actually care about.

Examples:

- CI pass rate ≠ correctness;
- test coverage ≠ meaningful behavioral coverage;
- issue throughput ≠ engineering progress;
- number of findings ≠ audit quality;
- benchmark score ≠ production fitness;
- gate verdict ≠ demonstrated property;
- agent task completion ≠ mission success;
- number of supported rails/providers ≠ interoperability or production readiness.

The practical rule is:

> **Metric → signal about a property. Metric ≠ property.**

Whenever a metric becomes operationally important, pair it with the underlying property, adversarial checks and qualitative evidence. If optimizing the metric can improve the dashboard while making the real system worse, the metric is unsafe as a standalone target.

### Cobra Effect vs Goodhart's Law

They are related but not identical:

- **Goodhart's Law** warns that a measurement loses reliability when optimized as a target.
- **Cobra Effect** warns that an incentive intended to improve an outcome can induce behavior that makes the underlying outcome worse.

Together they create a useful AI-engineering guardrail:

> **Do not reward the proxy in a way that teaches humans or agents to defeat the purpose of the proxy.**

For Sails this means gates, scores, coverage, issue counts, audit findings and AI mission-completion signals must remain diagnostic instruments — never substitute authorities for engineering reality.

## Historical character

These documents emerged during construction rather than being written retrospectively after the architecture stabilized.

Preserve that character.

Editorial cleanup, navigation and clarification are welcome. Retrospective rewriting that makes the development path appear cleaner or more inevitable than it actually was is not.

The goal is not archaeology. The goal is **durable context**: enough history and reasoning for a future human or AI contributor to understand why the engineering system looks the way it does without depending on private conversational memory.
