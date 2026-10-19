# CONTRIBUTING.md
### Sails Protocol — Contribution & Architecture Guide

> These conventions are current contribution rules derived from real architectural and implementation failures found during repository review. Historical handoff provenance may still be referenced where useful, but this document is a current contribution surface, not part of a numbered handoff package.
>
> **This document covers architecture** (where code goes, module
> boundaries, naming). **`docs/CODE_STYLE.md` (added 2026-08-03) covers
> voice** — comment style, error handling, testing conventions, the
> line-level patterns that make this codebase read as one consistent
> author's work. Read both before contributing, especially if you're a
> different AI tool joining a repo more than one is already working in —
> that's exactly the scenario `CODE_STYLE.md` exists to keep coherent.

---

## 1. Naming Conventions

### Module folders

Use the **official module names**, always prefixed `open-`:

```
modules/open-identity/
modules/open-reputation/
modules/open-settlement/
modules/open-liquidity/
modules/open-p2p/
modules/open-agents/       (future)
modules/open-finance/      (future)
```

Never name a folder after a technical concept instead of the official
module (e.g. `modules/escrow/`, `modules/routing/`, `modules/identity/` are
all **wrong** — they were the actual names found and corrected during code
review, renamed to `open-settlement/`, `open-liquidity/`, and moved out of
`modules/` entirely for identity's P2P transport piece — see below).

### Infrastructure vs Domain

If a file's primary job is moving bytes over a network or talking to a
database/cache — HyperDHT, Hyperswarm, Prisma client setup, Redis client
setup — it belongs in `infrastructure/`, never in `modules/`. A real
example: `pear.service.ts` (HyperDHT/Hyperswarm transport) used to live in
`modules/identity/` and was moved to `infrastructure/p2p/` during review,
because "how peers connect" is an Infrastructure concern, not a "what is an
identity" Domain concern.

### Events

Format: **`{module}.{entity}.{action}`** — always three parts, always
lowercase, always the official module name.

```
✅ openp2p.trade.created
✅ settlement.escrow.locked
✅ reputation.score.updated
✅ liquidity.offer.published

❌ trade.created          (missing module namespace)
❌ escrow.created          (missing module namespace)
❌ TradeCreated            (wrong case, wrong separator)
```

The unnamespaced form (`trade.created`, `escrow.created`) is legacy and was
fully removed from `common/events/event-bus.ts` during review. If you see
it anywhere, it's drift — fix it, don't extend it.

### API routes

Format: **`/v1/{module}/{resource}`**. See `API_REFERENCE.md` for the full
current mapping (including which legacy unnamespaced routes are being
migrated).

---

## 2. The Four-Layer Rule (enforced, not optional)

Every file belongs to exactly one of: **Protocol, Application, Domain,
Infrastructure** (see `ARCHITECTURE.md` section 1 for full definitions).

**Before you write a cross-module database write, stop and ask:** does this
entity belong to my module? If `EscrowService` (OpenSettlement) needs
something to happen to a `Trade` (OpenP2P) or a `User`'s reputation stats
(OpenReputation), it must **emit an event** and let the owning module's
handler perform the write — never reach into another module's tables
directly.

```typescript
// ❌ WRONG — OpenSettlement writing directly to OpenP2P's domain
await prisma.trade.update({ where: { id: tradeId }, data: { status: 'COMPLETED' } })

// ✅ RIGHT — emit an event, let OpenP2P's own handler react
eventBus.emit('settlement.escrow.released', { escrowId, tradeId, ... })
// (handled in common/events/handlers.ts, which performs the Trade write)
```

This exact violation was found in `escrow.service.ts` during review — it
was calling `prisma.trade.update()` and `prisma.user.update()` directly.
Fixed by moving those writes into `common/events/handlers.ts`, triggered by
the `settlement.escrow.*` events `EscrowService` already emitted.

**Check yourself with a grep before submitting any change:**

```bash
# Any hits here from within modules/open-settlement/ are a violation:
grep -rn "prisma\.trade\.\|prisma\.user\." src/modules/open-settlement/
```

---

## 3. Singleton Discipline

If a class needs to be a singleton (one instance per server process), make
sure that's actually true for every field it manages — not just true "most
of the time." A real bug found during review: `PearPeerManager` was a
singleton with a single `keyPair`/`dht`/`swarm`, but its `start(userId,
...)` method suggested multi-user support. Two users calling `start()`
silently clobbered each other.

**The fix pattern to follow for any similar case:** split into an instance
class (one per logical owner — e.g. one `PearNode` per user) and a registry
class (the actual singleton, holding a `Map<ownerId, InstanceClass>`). See
`NODE_ARCHITECTURE.md` section 2 for the worked example.

---

## 4. Dead Code

If a message handler, branch, or function only logs a comment saying
"future: not yet implemented" with no actual behavior, it is dead code —
delete it, don't leave it as a placeholder. A real example removed during
review: `OFFER_ANNOUNCE` and `CHAT_MESSAGE` handlers inside
`pear.service.ts` that only called `console.log(...)`. They were replaced
with a single generic `message` event that the owning domain module (not
the transport layer) decides how to handle.

If you genuinely need a placeholder for a future capability, write a
one-line TODO comment referencing the roadmap phase (`ROADMAP.md`) instead
of a dead branch with fake logic:

```typescript
// TODO(Months 1-3): real HodlHodl API integration — see ROADMAP.md
async isAvailable() { return false }
```

---

## 5. Duplication

Before writing the second occurrence of a data-mapping shape (e.g. mapping
a Prisma row to a protocol-level type), extract a shared helper. A real
example fixed during review: `getOffers()` and `matchOrder()` in
`liquidity.service.ts` both built an identical 8-field object literal
mapping a Prisma `Offer` row into a `LiquidityOffer`. Extracted into
`mapOfferToLiquidityOffer()` — one source of truth for that shape.

---

## 6. How to Add a New Module

1. Confirm the module name against the official list in `ARCHITECTURE.md`
   section 3 — don't invent a new module name without updating
   `PROJECT_CONTEXT.md` and `PROTOCOL_SPECIFICATION.md` first (this is a
   protocol-level decision, not a code-level one).
2. Create `modules/open-{name}/` with a `.service.ts` (business logic) and
   a `.routes.ts` (HTTP wiring) at minimum.
3. Define which Core Primitives (`PROTOCOL_SPECIFICATION.md` section 1)
   your module implements or consumes — most modules should implement
   exactly one primitive and consume several others via events.
4. Add any new entities to `schema.prisma` with `moduleId` defaulting to
   your module's canonical name and `protocolVersion` defaulting to the
   current spec version (see `DATABASE.md` section 1).
5. Add your module's events to `common/events/event-bus.ts`'s
   `SailsEventMap`, namespaced `{yourmodule}.{entity}.{action}`.
6. If your module needs to react to another module's events, write the
   handler in `common/events/handlers.ts` — never import the other
   module's service class directly.
7. Add your module's routes to `API_REFERENCE.md` under
   `/v1/{yourmodule}/`.
8. Update the module status table in `PROJECT_CONTEXT.md` (✅/🏗️/📋).
9. If this module ships its own SDK-facing surface, name it per the
   Named-SDK Rule (`PROJECT_CONTEXT.md` section 3) — a specific,
   concrete, use-case name (like `Sails P2P Trading SDK`), never an
   extension of generic "Sails SDK." Do this at design time, not as a
   rename after the fact.

---

## 6B. Post-Specification-Freeze Discipline (in effect from 2025-07-13)

`MASTER_COORDINATION.md`'s "Sails Protocol v1.0 Specification Frozen"
milestone changes what's expected from anyone — including Claude —
working on this project from here forward:

- **The job is now "implement exactly what's specified," not "design."**
  The 5 RFCs, `PROTOCOL_SPECIFICATION.md`, and `BACKLOG.md` are the
  source of truth for what to build — not a starting point to improve on
  unprompted.
- **An architectural doubt during implementation is never resolved
  unilaterally.** It becomes a written proposal — the problem, the
  trade-off, a recommendation — handed to the CTO for review, the same
  format every RFC already follows. Silently picking an interpretation
  and moving on is exactly the failure mode this rule exists to prevent.
- **No new foundational RFC is expected.** Five is enough for v1.0. A
  genuinely new primitive or module proposal during implementation should
  be treated as a strong signal to stop and ask whether it's actually
  required, not a normal part of the work.

## 7. Documentation Discipline

Sails does not use one universal documentation file or handoff package as the source of truth. Different questions have different governing owners. Start with `docs/00-INDEX.md` and `docs/SYSTEM_DESIGN.md`, then follow the relevant Semantic Kernel, architecture, Protocol Specification/Invariants, ADR/RFC, API/SDK, Backlog or evidence owner.

If you make an architectural or protocol-sensitive decision, **update the relevant governing document in the same change**. Do not let institutional knowledge live only in commit messages, issue comments or chat context. Historical handoffs preserve provenance; they do not override current canonical owners.

---

## 8. Day-to-Day Workflow (added Mission 9.9, 2026-08-31)

Sections 1–7 above are about **where code goes**. This section is about
**how you actually work** — added because until now nothing in this
repository said so explicitly. Full methodology (why, STOP gates,
evidence, consequence weighting) lives in `docs/ENGINEERING_GOVERNANCE.md`
— this section is the short, operational version, not a duplicate.

**Read in this order if you're new here:**

1. `README.md` — what Sails is and where to start.
2. `docs/PROJECT_CONTEXT.md` — institutional/product context.
3. `docs/SYSTEM_DESIGN.md` — current system-level technical map.
4. This file, §8–§11 — day-to-day contribution workflow.
5. `docs/GITHUB_PROJECT.md` plus live GitHub Issues/Project for current operational state.

**Finding work:** the GitHub Project's "Current Mission" and "Master
Backlog" views (`docs/GITHUB_PROJECT.md` §1.8), or `docs/GITHUB_PROJECT.md`
§2's Bucket A/B classification if the Project isn't live yet. Don't pick
up a Bucket C/D/E item (architectural front, research, or future/parked)
expecting it to be a defined unit of work — it isn't yet.

**Definition of Ready / Done:** `docs/ENGINEERING_GOVERNANCE.md` §5/§9.
Consequence-weighted — a docs fix and a settlement-authority change do
not carry the same ceremony.

**Running tests:**
```bash
npm run test:unit               # no Postgres required
SAILS_INTEGRATION_TEST_DB_CONFIRMED=yes-i-am-sure npm run test:integration:postgres
npx tsc --noEmit                # root; repeat with -p packages/<name> for each workspace package
npm run check:core-boundary
npm run check:conformance
```

**STOP:** `docs/ENGINEERING_GOVERNANCE.md` §6. If you hit one of the
listed conditions (a frozen invariant would need to change, evidence
contradicts the architecture, a required fact can't be established),
stop and write it down — in the Issue or PR — rather than push past it.
A correct STOP is a successful outcome, not a failed one.

**PR evidence:** every PR uses `.github/PULL_REQUEST_TEMPLATE.md`.
Evidence is classified per `docs/ENGINEERING_GOVERNANCE.md` §11
(Hypothesis → Designed/Implemented → Demonstrated → Validated) — state
the real level, don't round up, and never let a shared code path stand
in for independent verification of a different case.

**Challenging architecture:** anyone may — `docs/ENGINEERING_GOVERNANCE.md`
§1. A challenge needs the problem, the property gained, the property
sacrificed, and evidence; it does not need seniority. If it changes a
primitive, a module, or a Constitutional/Operational invariant, it goes
through `docs/GOVERNANCE.md` §5 (RFC process) — see
`docs/ENGINEERING_GOVERNANCE.md` §8 for the pre-flight questions to
answer before drafting one.

**What you may not change silently:** `docs/PROTOCOL_INVARIANTS.md`,
`docs/SEMANTIC_KERNEL.md`, `docs/CORE_ARCHITECTURE.md`, the database
schema, and anything a Mission Freeze report (e.g. `M9 FINAL FREEZE`,
commit `b0c581dd26281f230a3795dfdaa48412574ea5c1`) marks frozen. All of
these change only through the RFC process or an explicitly-authorized
follow-up mission — never as a side effect of an unrelated PR.

## 9. Human + AI Contributors

Applies equally — `docs/ENGINEERING_GOVERNANCE.md` §7. AI-generated code
satisfies the same Definition of Ready/Done, the same tests, the same
STOP gates, and gets the same human review before merge as anyone else's.
"An AI wrote it" is not evidence and is not authorization. Agent access
never implies agent authority — `docs/ENGINEERING_GOVERNANCE.md` §16.18.

## 10. AI-Oriented Engineering Discipline — day-to-day (added `AI-ENGINEERING-DISCIPLINE-1`, 2026-09-13)

Full methodology (why, wording, relationship to other governance) lives
in `docs/ENGINEERING_GOVERNANCE.md` §16 — this is the operational
checklist, consequence-weighted like everything else in this section.
Not every step applies to every change; the more irreversible,
financially material, or protocol-meaning-affecting the work, the more
of this actually applies (§16.20).

1. **Decision Frontier** — before answering a downstream question,
   confirm its upstream prerequisites are already resolved. Don't
   convert an unknown into a convenient assumption (§16.1). For a
   complex decision, ask only questions that would change the decision
   (§16.2, Grilling Discipline).
2. **Spec before consequential implementation** — for Shared-application-
   semantics work and above, write down Problem → Desired Property →
   Decision → Spec/Contract → Acceptance Evidence before implementing
   (§16.4). Don't silently redefine the spec because implementation got
   easier — that's a STOP (§6), not a judgment call.
3. **Harness first if reproduction is expensive** — pick the smallest
   feedback loop that can actually falsify the claim (§16.7's ladder);
   if a bug is expensive to reproduce, making reproduction cheap may be
   the first task.
4. **TDD seam** — before writing a test, name the property being proved
   and the seam that can observe it. Never mock the property you're
   trying to prove (§16.8).
5. **Vertical slice** — an Issue/Mission should be completable as an
   observable behavior ("X can do Y while preserving Z"), not just a
   layer ("add a service," "create a repository") unless that layer
   itself proves a result (§16.9).
6. **Quad Review before calling something done** — Spec Conformance,
   Engineering Standards, Product/Architecture Truth, Evidence/Claim
   (§16.10). Passing the first two does not imply the other two.
7. **Loop until stable, not until N runs** — for adversarial/attack work,
   stop when no new Critical/High or systemic contradiction is found,
   not after a fixed number of passes (§16.11).
8. **Blind-spot pass before declaring done** — ask what wasn't asked
   because the current implementation made it look irrelevant (§16.12).
9. **Required handoff** — for material work, leave baseline, current
   truth, decisions, unresolved decisions, evidence, STOPs, and next gate
   written down, so a different agent (human or AI) could pick it up
   cold (§16.16).

**Vocabulary discipline:** a term (Intent, Offer, Trade, Settlement,
Authority, Capability, Asset, SettlementRail/Scope/Adapter/Provider,
Economic/Transport/Node Identity, etc.) carries exactly one meaning. If
you find it carrying two, STOP and reconcile — don't add a third
meaning to route around the conflict (§16.13).


---

## Development contract — new networks, settlement rails and adapters

This checklist applies to humans and AI coding agents adding or materially changing a
network integration, settlement rail, adapter, or provider. It is an implementation
workflow, **not** a new protocol authority. Follow `AGENTS.md`,
`docs/engineering/AI_SESSION_ONBOARDING.md`, `docs/ENGINEERING_GOVERNANCE.md`,
the Semantic Kernel, Protocol Invariants, Core Architecture, applicable specifications,
and accepted RFCs/ADRs. If those sources disagree, **STOP** and resolve authority
through governance; do not silently select the most convenient interpretation.

1. **Define the boundary before coding.** Identify the owning module, existing
   SettlementRail/Scope/Adapter/Provider interfaces, lifecycle states, economic
   assets, custody model, trust assumptions, and external dependencies. Reuse
   shared contracts where they genuinely apply; do not force unlike networks
   into a Bitcoin-specific or EVM-specific abstraction.
2. **Map invariants explicitly.** In the Issue or design specification, list
   applicable economic and security invariants and explain how the adapter
   preserves each one. Record network-specific differences (UTXO vs account,
   finality/reorgs, fee and nonce handling, signatures, transaction identity,
   confirmation thresholds, token contracts, chain identity, and replay
   protection). Mark any non-applicable invariant with a reason, never silence.
3. **Prove authorization before irreversible effects.** Specify who can
   authorize each operation, how authorization binds to the exact trade,
   escrow, asset, chain, destination, amount and transaction, and where
   authorization is rechecked immediately before an external effect. No
   adapter may infer authority from a successful RPC response, an unsigned
   payload, or a previously observed status.
4. **Design failure and concurrency semantics.** Document durable intent,
   idempotency keys, claim/CAS transitions, restart recovery, ambiguous
   timeouts, retries, duplicate submissions, partial failures, reorgs and
   conflicting observations. Unknown external truth must remain unknown:
   never convert an explorer/RPC timeout, 404, or 5xx into proof of
   successful settlement or safe re-execution.
5. **Keep economic evidence independently verifiable.** Bind persisted
   identifiers and outputs to the actual network transaction, verify funding
   and spend surfaces against immutable commitments, and distinguish
   broadcast, observed, confirmed and finalized states as the network
   requires. An anomaly must fail closed or enter explicit manual review.
6. **Test the property, not its mock.** Supply adapter-specific unit,
   integration and adversarial tests for valid execution, invalid authority,
   wrong network/asset/destination, stale or concurrent claims, crashes,
   ambiguous responses, double broadcast, confirmation and reorg behavior,
   and recovery. Use real serialization/cryptographic validation and
   database constraints where the property depends on them; mocks may
   simulate external transport, not bypass the invariant under test.
7. **Submit evidence through the existing gates.** Link the governing spec,
   invariant mapping, test commands/results, exact commit SHA, CI runs,
   known limitations and unresolved risks in the PR. A green CI alone
   does not prove economic safety. No merge, production enablement or
   readiness claim while consequential evidence is missing, contradictory,
   or blocked by a Gatekeeper STOP.
8. **Leave an agent-readable handoff.** Update the relevant canonical
   design/specification and operational documentation, register remaining
   work in the Master Backlog, and explain which shared patterns future
   adapters may reuse versus which properties require independent proof.

**AI-agent rule:** treat this checklist as a required review path, not as
permission to change protocol semantics. If the necessary authority, network
evidence, test environment, or specification is unavailable, report the
specific blocker and STOP rather than weakening checks, skipping tests, or
claiming completion.
