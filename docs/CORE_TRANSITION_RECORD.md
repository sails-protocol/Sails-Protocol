# CORE_TRANSITION_RECORD.md
### Sails Protocol — Bridge Phase M3.5: Durable Semantic Transition Record

> Engineering handoff note, not a frozen architecture document. Where
> anything here appears to conflict with `docs/CORE_IMPLEMENTATION_ARCHITECTURE.md`,
> that document governs and this one is wrong.

> **Corrected/Implemented 2026-11-27 (historical delimitation):** statements here that the transition record has no production caller and that only the shadow observer runs in production describe the state at Bridge Phase M3.5. Since then, `dispute.service.ts` commits a durable Core-authoritative Outcome for MULTISIG disputes (`applyRulingCoreAuthoritative()`, see `docs/RECOVERY_RECONCILIATION_CONFORMANCE_EVIDENCE.md` section 4); the current wiring is not restated here.

## 1. Why this mission exists

`docs/CORE_IMPLEMENTATION_ARCHITECTURE.md` §12 states, without
exception: **"No semantic decision becomes Core-authoritative before a
durable Transition Record exists for that decision class."** §29's own
migration sequence originally expected the first `FUNDS_LOCKED →
EXPIRED` slice (M3) to build both the evaluator logic *and* a minimal
durable Record for that slice, together.

Operational M3, as actually executed, was deliberately scoped
shadow-only — Core observed the real sweeper without ever gaining
authority, and built no persistence at all. When M4 (First
Authoritative Semantic Slice) was attempted immediately after, it
correctly stopped before commit: the frozen precondition in §12 was
unmet, and no prior mission had built it. This is not a sequencing
mistake being hidden — it is the frozen architecture's own safety rule
doing exactly what it was designed to do. M3.5 exists to close exactly
that gap, and only that gap, before M4 is retried.

## 2. What M3.5 does NOT do

- Does not make Core authoritative for anything. `escrow.service.ts`'s
  live `sweepExpiredEscrows()` is unchanged; the M3 shadow observer
  (`expiry-shadow.ts`) remains the only live Core-adjacent code running
  in production. `src/modules/open-settlement/semantic-transition-record.ts`
  has no caller in production code — proven directly in
  `tests/semanticTransitionRecord.test.ts`.
- Does not implement M5 (generalized attribution), M6 (correspondence),
  M7 (Outcome authority), M8 (Provider dispatch), or M9 (recovery). The
  new `SemanticTransitionRecord` table carries no `attribution`/`outcome`
  columns — this slice is deterministic (no discretionary judgment, K2
  does not apply) and moves no funds (no economic Outcome, K3 does not
  apply) — both conditional fields on Core's own `TransitionRecord` type
  stay unpopulated, and `toSemanticTransitionRecordRow()` throws rather
  than silently dropping either if one is ever present.
- Does not fabricate history for any pre-existing escrow. Every escrow
  transitioned before this migration has no `SemanticTransitionRecord`
  row and needs none — a plain absence, never a synthesized one.

## 3. Semantic Record vs. Event — a deliberate, preserved distinction

`docs/CORE_IMPLEMENTATION_ARCHITECTURE.md` §9 (as read for this mission)
draws a real distinction the existing `EscrowEvent` table does not make:
a **Transition Record** explains *why* a semantic State transition was
valid (evaluator identity, profile identity, Ruleset binding, the
committed inputs, the resulting `ConditionResult`); an **Event** reports
*what* the Runtime observed happened (`EscrowEvent`'s `fromStatus`/
`toStatus`/`triggeredBy`, written alongside the operational event-bus
emission). Extending `EscrowEvent` with Core-specific columns would have
let the Event Bus's own pre-existing shape define Core semantics — the
opposite of the intended direction. `SemanticTransitionRecord` is a new,
separate table for exactly this reason; `EscrowEvent` is untouched.

## 4. EscrowEvent vs. dedicated Record — the comparison

| | Extend EscrowEvent | Dedicated table (chosen) |
|---|---|---|
| Semantic responsibility | Conflates Runtime event with Core provenance | Clean separation |
| Row volume | Every escrow event carries mostly-NULL Core columns | Only Core-authoritative decisions, once each |
| Future Interaction kinds | Escrow-specific table name/relation | `interactionId` is a plain string, no FK — kind-neutral |
| Future evaluators/Rulesets | No natural home for identity/binding columns | Purpose-built columns |
| Coupling | Couples Core provenance to the event-bus write path | Independent; can be written without touching event emission |
| Storage duplication | None avoided (would live in the same row anyway) | Minor (fromState/toState duplicated), acceptable for the integrity gained |

The smallest option that preserves the architecture correctly is the
dedicated table — not the option requiring the least typing.

## 5. Protocol model vs. Reference Implementation storage mapping

Core's `TransitionRecord` (`packages/sails-core/src/transition.ts`, M1)
is the protocol-level, storage-neutral type — it was already fully
defined before this mission began; M3.5 did not invent it. This
document's job was mapping that ALREADY-FROZEN type onto this Reference
Implementation's Postgres/Prisma storage, never redefining it.
PostgreSQL/Prisma is how *this* Reference Implementation happens to
persist the Record; nothing about the mapping is assumed by Core
itself, which never imports Prisma, never opens a transaction, and
never generates a database id (`scripts/check-core-boundary.ts` still
reports `packages/sails-core/src` clean after this mission).

| Core type field | Persisted column(s) |
|---|---|
| `interaction: InteractionId` | `interactionId: String` (no FK — kind-neutral) |
| `transition.type: TransitionTypeId` | `transitionType: String` |
| `transition.payload: {fromState, toState, deadlineMs, evaluationTimeMs}` | `fromState`, `toState`, `deadlineMs: BigInt`, `evaluationTimeMs: BigInt` |
| `priorPosition: SemanticHistoryPosition \| LegacyUnverified` | `priorPositionKind` enum + nullable `priorPositionReference` |
| `rulesetRef: RulesetRef` | `rulesetName`/`rulesetIdentity`/`rulesetVersion`/`rulesetCommitment`/`rulesetExpected{Evaluator,Profile}{Name,Version}` |
| `evaluatorIdentity` (actual, not expected) | `evaluatorIdentityName`/`evaluatorIdentityVersion` |
| `profileIdentity` (actual, not expected) | `profileIdentityName`/`profileIdentityVersion` |
| `conditionResult: ConditionResult` | `conditionResult` enum (all 4 values representable; this slice only ever writes `SATISFIED`) |
| `attribution` (K2) | absent — never populated by this slice |
| `outcome` (K3) | absent — never populated by this slice |

`deadlineMs`/`evaluationTimeMs` travel inside `CandidateTransition.payload`
(Core's own "opaque, Runtime-defined" extension point), not as a bolted-on
parameter — `conformance/profiles/sails-semantic-profile-1.0.json`'s own
`integerRepresentation` rule (integer milliseconds since epoch, ≥53-bit
precision) already fully specifies this representation; no profile
extension was needed.

## 6. Atomicity

`commitAuthoritativeEscrowTimelockExpiry()` wraps the existing atomic
State claim (`escrowRepository.claimTransition`, unchanged, already
supported an optional `Prisma.TransactionClient` parameter from Missão
11 Fase 9.3) and the new `SemanticTransitionRecord` insert inside one
`prisma.$transaction(...)` — the same pattern this codebase already
uses elsewhere (`custody-attestation-repository.ts`). If the claim loses
the race (0 rows affected), the Record is never created and the
transaction is a safe no-op. If the Record insert then fails for any
reason, Postgres rolls back the whole transaction, undoing the claim
too. Event emission (`emitEscrowTransition`) remains a separate step
after this atomic unit succeeds, unchanged from how the two already
compose today.

## 7. Replay resistance and its documented limit

`@@unique([interactionId, transitionType])` is correct under the
CURRENT frozen `VALID_TRANSITIONS` graph (`escrow-lifecycle.ts`):
`EXPIRED` is reachable from `FUNDS_LOCKED` at most once per escrow. This
is deliberately narrower than a maximally general
`(interaction, transition, semantic history position)` key. **Disclosed
technical debt**: if a future transition type is ever legitimately
repeatable on the same Interaction, this key must widen — not before.

## 8. Ruleset commitment — disclosed minimality

`conformance/rulesets/sails-escrow-timelock-expiry-ruleset-1.0.json` is
the first Ruleset definition this codebase has ever published (M2 only
published Evaluator and Profile identities). Its `commitment` field is
a plain, stable, versioned string, not a cryptographic content digest —
there is no Ruleset registry or structured Ruleset content object
anywhere in this codebase yet to hash (`src/core/policy-engine.ts`
remains a documented stub). **Disclosed technical debt**: a real
content-addressed commitment scheme is deferred to whichever future
mission builds real Ruleset Admission tooling
(`docs/CORE_IMPLEMENTATION_ARCHITECTURE.md` §23) — out of scope here.

## 9. Migration

`prisma/migrations/20260830041220_add_semantic_transition_record/` is
purely additive: two `CREATE TYPE` (new enums), one `CREATE TABLE`, two
`CREATE INDEX`. No `DROP`, no `ALTER` on any existing table, no new
`NOT NULL` column on historical data, no default that fabricates
provenance. Every existing `Escrow`/`EscrowEvent` row is untouched and
remains fully valid with no `SemanticTransitionRecord` — proven in
`tests/integration/semanticTransitionRecordAtomicity.test.ts`'s legacy
compatibility test.

## 10. M4 remains blocked until this validates

Only after this mission's own validation (M0–M3 reverification, the new
persistence mechanism's own test matrix, full non-Postgres suite) is a
future M4 retry authorized — and even then, M4 must re-review the
preserved experimental patch (local branch
`preserve/m4-authority-transfer-experiment`) against this new
architecture rather than assume it is still correct as written.
