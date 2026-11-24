# PROTOCOL_SPECIFICATION.md
### Sails Protocol — Engineering Handoff · Document 7 of 20 · v7.1 (9 primitives)

> This is the most important technical document in this handoff. It defines
> what the Sails Protocol actually *is*, independent of any implementation.
> If `ARCHITECTURE.md` is "how the reference implementation is organized,"
> this document is "what any implementation, in any language, must respect
> to correctly call itself Sails Protocol."

---

## 0. Normative Language

*(Added 2026-07-19, relaying a CTO-role architectural review — "documentation should evolve toward consistent normative language."
Scoped to this document only: the rest of the 20-document Engineering
Handoff series is written for engineers understanding the system, not
implementers conforming to it, and stays in its existing narrative
style — see `TODO.md`'s consolidation-pass entry for why the scope was
drawn here specifically.)*

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and
**MAY** in this document are to be interpreted as described in
[RFC 2119](https://www.ietf.org/rfc/rfc2119.txt):

- **MUST** / **MUST NOT** — an absolute requirement / prohibition. An
  implementation that violates one is not a conforming implementation
  of Sails Protocol, full stop — the same bar `PROTOCOL_INVARIANTS.md`
  applies to its own rules, expressed here per-primitive instead of as
  a standalone constitution.
- **SHOULD** / **SHOULD NOT** — a strong recommendation. There may be
  valid reasons in particular circumstances to ignore it, but the full
  implications need to be understood and weighed before doing so.
- **MAY** — genuinely optional. One implementation may include it,
  another may omit it, and both remain equally conforming.

These keywords apply only where they appear in a **Conformance**
context — inline within a primitive's own description, or in the
consolidated §6 summary. The surrounding narrative prose (rationale,
revision history, "why" explanations) is exactly as before this
section was added: informative, not normative. Where §6's summary and
a section's own inline requirement ever disagree, the inline
requirement is authoritative — §6 is a convenience index, not a second
source of truth (the same discipline this consolidation pass applied
everywhere else: one definition, everything else references it).

---

> **Terminology scope (2026-09-16):** historical references in this
> specification to **Core components**, the **Core Event Bus**,
> **Capability Registry as Core**, **Policy/Rules Engine as Core**, or the
> legacy `src/core/` topology refer to the historical/reference coordination
> architecture, not the modern **Pure Sails Core** boundary. The current
> Pure Core / Runtime / Modules / Providers boundary is owned by
> `CORE_ARCHITECTURE.md` and `CORE_IMPLEMENTATION_ARCHITECTURE.md`. This is
> a terminology clarification only: no primitive, lifecycle,
> Capability/Policy semantics, authority, module/provider responsibility,
> or accepted RFC decision changes as a result of this note.

## 1. Core Primitives — the Fundamental Vocabulary

Modules (`ARCHITECTURE.md` section 3) are service *boundaries*. Primitives
are more fundamental — they are the atomic contracts any module is built
from. A module *implements* one or more primitives; primitives themselves
have no owner and depend on nothing but each other's interfaces.

```
Identity    → WHO is participating
Intent      → WHAT someone wants to happen
Discovery   → WHO ELSE this could happen with
Negotiation → HOW terms get agreed
Settlement  → HOW value actually moves
Reputation  → WHY to trust a counterparty
Agent       → WHO (or what) acts on someone's behalf
Proof       → HOW a claim gets verified by someone else
Dispute     → HOW a disagreement gets formally resolved
```

**Revision note (v7.1):** this list grew from 7 to 9 primitives after a
formal architectural review. The two additions (Proof, Dispute) are
documented in sections 1.8-1.9, each passing the same test the original
seven were held to: irreducible, orthogonal to the others, has its own
participant-facing lifecycle, and is cross-cutting across modules. Three
other candidates proposed during that review — **Capability** and
**Policy** — turned out to be real and valuable but did *not* pass that
test (no participant-facing lifecycle of their own); they were classified
as supporting coordination components rather than protocol primitives. In
the historical/reference architecture they were named **Core components**
(Capability Registry, Policy/Rules Engine — see `ARCHITECTURE.md`). That
historical label does not refer to the modern Pure Sails Core boundary.
**Participant**, **Offer**, and **Event** were rejected outright. Section
1.10 documents the coordination-component reasoning; section 1.11 documents
the outright rejections. Nine is the number that survived a real,
consistently-applied test — not a headcount compromise.

### 1.1 Identity Primitive

**Revision note (Protocol Freeze, v8.4 — RFC-001):** the Core does not
depend on `Identity` directly. It depends on an abstract `Participant`
interface, of which `Identity` is the first and, today, only
implementation:

```typescript
// Core-level abstraction — every other primitive references THIS,
// never Identity's concrete Ed25519 shape.
interface Participant {
  participantId: string
  verificationLevel: 0 | 1 | 2
  proveControl(challenge: Challenge): Promise<IdentityProof>
}
```

`Wallet` and `Agent` are explicitly **not** `Participant` implementations
— see `rfcs/RFC-001-participant-model.md` for why: a Wallet has no
identity of its own to prove, and an Agent acts strictly under a
delegating Participant's authority (section 1.7 below) — allowing Agent to
implement `Participant` directly would risk contradicting
`PRINCIPLES.md` Principle 3 ("Self Custody Always").

**Responsibility:** represent a sovereign participant with cryptographic
proof of control, with no centralized registry.

```typescript
interface Identity extends Participant {
  publicKey: string           // Ed25519
  createdAt: Timestamp
}
interface IdentityProof {
  challenge: string
  signature: string
}
```

- **Events:** `identity.created`, `identity.verified`, `identity.challenged`
- **Relationships:** every Intent, Negotiation, Settlement action, and
  Reputation event references a **Participant** (typically an Identity
  today). An Agent acts under a delegating Participant's scope — never
  under its own independent identity.
- **Implemented by:** Sails OpenIdentity

**Growth path (v7.4 — CTO review finding: OpenIdentity looked narrower than
its real potential).** The `Identity` interface above is the minimum viable
shape — keypair plus a 3-tier verification level. This is deliberately
small (`PRINCIPLES.md` principle 1, "Protocol First" — the Core stays
minimal). OpenIdentity as a *module*, however, is not limited to that
minimum, and is expected to grow along a concrete path without ever
changing the `Identity` primitive's core contract:

```
Keys          → Ed25519 keypair (✅ today)
   ↓
DID            → W3C Decentralized Identifier wrapping the same keypair,
                  for interoperability with non-Sails identity systems
   ↓
Credentials     → Verifiable Credentials (e.g. "professionally certified
                  by issuer X"), represented using the Proof primitive
                  (section 1.8) — this protocol never issues, requires,
                  or verifies these itself; the primitive is generic
                  enough for a third party to anchor whatever credential
                  type they choose. Corrected 2026-08-09: this row used
                  KYC as its illustrative example, which read as this
                  protocol having some relationship to KYC when it has
                  none — same principle already stated explicitly in
                  vouch.service.ts/payment-account.service.ts.
   ↓
Trust Graph     → Identity-to-Identity attestations ("I vouch for this
                  counterparty"), a structure OpenReputation can query
                  as an additional signal alongside trade history
```

Each stage is additive — a Level-0 keypair-only Identity from today remains
valid forever; DID, Credentials, and Trust Graph are optional layers a
Reference Implementation can build on top, none of which require changing
what `Identity` fundamentally is.

**Portable Identity Layer, not "the DID layer" (v1 Positioning Freeze).**
"DID" in the diagram above is one illustrative interoperability format, not
a commitment of the protocol to the W3C DID specification specifically. The
Core contract only requires that whatever sits above Level-0 Keys be
*portable* — usable across wallets and applications without re-registering
identity from scratch. A Reference Implementation is free to satisfy that
with W3C DID, a Nostr keypair/NIP-05 identifier, a bare Ed25519 key plus an
attestation format, or something not yet invented — the protocol has no
opinion, the same way it has none on Postgres vs. CockroachDB (section
2B of `PROJECT_CONTEXT.md`). When describing this primitive in
positioning material, "Portable Identity Layer" is the technology-neutral
term to use; "DID" is only correct when the discussion is genuinely about
that one specific format choice.

**Current implementation boundary (Day 0):** This portability requirement
is not evidence of cross-device recovery, operator-independent identity
migration, or a cryptographic binding between economic participant keys and
Pears transport keys. The reference `PearNode` generates a separate,
server-runtime transport keypair; `User.peerId` association and handshake
checks are server-mediated (see `TRUST_BOUNDARY.md` boundary 1b and
`NODE_ARCHITECTURE.md`). Portability and recovery remain open Day-0
integration/evidence gates under ADR-001 / #105. Do not present the
technology-neutral identity contract as a shipped portability guarantee.

**Operational Profiles (RFC-007, `rfcs/RFC-007-real-world-p2p-requirements.md`).**
A further additive, OpenIdentity-module-level attribute, orthogonal to the
Keys/DID/Credentials/Trust Graph growth path above and to `Identity`'s core
contract, which is unchanged:

```typescript
type OperationalProfile =
  | 'regular_trader' | 'liquidity_provider' | 'merchant' | 'arbitrator' | 'agent'

interface OperationalProfileGrant {
  participantId: string
  profile: OperationalProfile
  grantedBy: string          // an application, via Policy Engine — not protocol-level KYC
  criteria?: Record<string, unknown>
}
```

An Operational Profile is not identity verification and grants no
protocol-level privilege by itself — it is a `CapabilityGrant` (section
1.10, RFC-005) scope that the Policy Engine reads to activate
module-specific behavior (e.g. accelerated settlement for a qualifying
`liquidity_provider`, see section 1.5's `PendingBankSettlement` note and
RFC-007 decision D8).

### 1.2 Intent Primitive

**Responsibility:** express a participant's desired outcome without
prescribing the exact execution path. This is the universal starting point
— see section 2 for the full Intent Engine specification.

- **Events:** `intent.created`, `intent.matched`, `intent.fulfilled`,
  `intent.expired`, `intent.cancelled`
- **Relationships:** created by a Participant (or an Agent acting for one — RFC-001).
  Discovered via Discovery. Agreed upon via Negotiation. Executed via
  Settlement. Its outcome feeds back into Reputation.
- **Implemented by:** the Intent Engine (cross-cutting infrastructure, not
  owned by any single module — see section 2)

### 1.3 Discovery Primitive

**Responsibility:** match Intents to potential counterparties/liquidity
without a central order-book authority.

```typescript
interface DiscoveryQuery { intent: Intent }
interface DiscoveryResult {
  candidates: Candidate[]
  rankedBy: 'price' | 'reputation' | 'composite'
}
interface Candidate {
  offerId: string
  participantId: string
  score: number
}
```

- **Events:** `discovery.query_executed`, `discovery.candidate_found`,
  `discovery.no_match`
- **Relationships:** consumes Intent + Reputation (for ranking) + Identity
  (participant info). Feeds into Negotiation once a candidate is selected.
- **Implemented by:** Sails OpenLiquidity

### 1.4 Negotiation Primitive

**Responsibility:** let two or more Identities reach mutual agreement on how
to execute an Intent, through a sequence of structured state transitions —
**not through any specific communication medium.**

**Revision note (Protocol Freeze, v8.2):** an earlier version of this
primitive modeled `NegotiationChannel` as `send(message)/onMessage(handler)`
— a chat interface. That was flagged in the Protocol Quality Review as a
10-year risk: it quietly made "negotiation" and "chat" the same thing,
which works today (human ↔ human, exactly how Bisq and HodlHodl operate)
but doesn't generalize to agent ↔ agent negotiation, where there is no
human-readable message at all. The correction, reached with the CTO
review: **the problem was never that chat exists — it's that chat was
modeled as the primitive itself, instead of as one implementation of a
more abstract negotiation.** Fixed below by making `NegotiationEvent` — a
typed state transition — the actual abstraction, and `NegotiationChannel`
a pluggable transport for those events. The channel is an implementation.
The negotiation is the abstraction.

**Revision note (Protocol Freeze, v8.7):** `status` was originally just
`'OPEN' | 'AGREED' | 'ABANDONED'` — flagged during CTO review as too
coarse for third-party implementers: "OPEN" conflated "just created" with
"actively exchanging offers," and "AGREED" conflated "terms settled" with
"nothing has happened since." Refined to `'CREATED' | 'NEGOTIATING' |
'TERMS_AGREED' | 'ABANDONED'`. **A boundary was deliberately held, not
adopted from the original proposal:** the refinement did not extend into
`AwaitingSettlement`/`Settled`/`Completed` — those describe what happens
*after* negotiation, and belong to the Settlement primitive's own state
machine (§1.5's `EscrowStatus`) and the Intent Engine's generic lifecycle
(§2.4's `SETTLING`/`FULFILLED`), already reconciled in §3.1. Extending
`Negotiation.status` that far would have recreated the exact ambiguity
§3.1 exists to prevent — two primitives independently describing the same
real-world moment.

```typescript
interface Negotiation {
  id: string
  intentId: string
  participants: string[]
  channel: NegotiationChannel
  status: 'CREATED' | 'NEGOTIATING' | 'TERMS_AGREED' | 'ABANDONED'
  terms?: AgreedTerms
  events: NegotiationEvent[]        // the actual negotiation history
}

// The abstraction: a sequence of structured events, not free-text messages.
type NegotiationEvent =
  | { type: 'OFFER_PROPOSED';    by: string; terms: ProposedTerms; at: Timestamp }
  | { type: 'COUNTER_OFFERED';   by: string; terms: ProposedTerms; at: Timestamp }
  | { type: 'TERMS_ACCEPTED';    by: string; at: Timestamp }
  | { type: 'TERMS_REJECTED';    by: string; reason?: string; at: Timestamp }
  | { type: 'MESSAGE_EXCHANGED'; by: string; content: unknown; at: Timestamp }
  // MESSAGE_EXCHANGED carries free-text/human content when a channel needs
  // it — it is one event type among five, not the whole primitive.

// The channel is a pluggable transport for NegotiationEvents — never
// known to the Core, never assumed to be chat.
interface NegotiationChannel {
  sendEvent(event: NegotiationEvent): Promise<void>
  onEvent(handler: (event: NegotiationEvent) => void): void
}
```

**Two valid implementations of the same primitive, today and later —
neither requires a Core change:**

```
Implementation 1 (today) — Human ↔ Human, via HumanChatChannel
  OFFER_PROPOSED → rendered as a chat bubble
  MESSAGE_EXCHANGED → free-text, e.g. "sending payment now"
  COUNTER_OFFERED → rendered as a chat bubble
  TERMS_ACCEPTED → user taps "Accept"
  → Settlement
  (this is exactly how Bisq and HodlHodl operate today)

Implementation 2 (future) — Agent ↔ Agent, via a StructuredChannel
  OFFER_PROPOSED → JSON, no human-readable rendering at all
  COUNTER_OFFERED → JSON
  TERMS_ACCEPTED → JSON, agreed programmatically
  → Settlement
  (no chat, no human interface — human only approves via AgentScope's
  requiresApprovalAbove threshold, PROTOCOL_SPECIFICATION.md §1.7)
```

A concrete `NegotiationChannel` implementation may internally separate
*how bytes move* (Secretstream, a WebSocket, an HTTP webhook) from *how
events are rendered* (a chat UI, a Telegram bot, raw JSON for an agent,
voice) — that separation is a quality-of-implementation concern for
whoever builds a channel, not a contract the protocol itself needs to
enforce with two more formal interfaces. The one thing the protocol does
enforce: **every channel, of any kind, carries `NegotiationEvent`s — never
an assumption that the other side is a human typing.**

- **Events (Core Event Bus, not to be confused with `NegotiationEvent`
  above):** `negotiation.opened`, `negotiation.event_received`,
  `negotiation.terms_agreed`, `negotiation.abandoned`
- **Relationships:** created after Discovery finds a candidate. Produces
  `AgreedTerms` consumed by Settlement. References the Identities of
  participants.
- **Implemented by:** Sails OpenP2P, today via a `HumanChatChannel` over
  Secretstream E2E — one valid `NegotiationChannel` implementation, not
  the definition of the primitive.
- **Why this still matters:** this is where a buyer and seller exchange
  fiat payment proof (see `SECURITY_MODEL.md`) — the protocol never
  touches fiat directly, so negotiation is the only place that
  coordination can happen. That requirement is unchanged by this revision;
  only the shape of *how* it happens is now channel-agnostic.

### 1.5 Settlement Primitive

**Responsibility:** execute the actual transfer/lock/release of value
according to agreed terms, without custody by the protocol.

```typescript
interface SettlementProvider {
  create(terms: AgreedTerms): Promise<Settlement>
  lock(settlementId: string): Promise<Settlement>
  release(settlementId: string): Promise<Settlement>
  refund(settlementId: string): Promise<Settlement>
  dispute(settlementId: string, reason: string): Promise<Settlement>
}
interface Settlement {
  id: string
  negotiationId: string
  type: SettlementType   // MOCK | MULTISIG | LIGHTNING_HODL | LIQUID_COVENANT
  status: SettlementStatus
  amount: string   // decimal string (RFC-009) — never a JS number; JSON numbers
                     // are IEEE754 by spec, only strings preserve exact decimals
}
```

- **Events:** `settlement.created`, `settlement.locked`,
  `settlement.released`, `settlement.disputed`, `settlement.refunded`
- **Relationships:** consumes `AgreedTerms` from Negotiation. Its completion
  triggers a Reputation update. Fulfills the Intent.
- **Implemented by:** Sails OpenSettlement

**`PendingBankSettlement` (RFC-007, decision D3).** `SettlementStatus`
gains a state representing payment that has left the payer (e.g. a PIX or
bank transfer initiated) but is held or still processing at the financial
institution before it actually clears — distinct from a status meaning
the payer has not yet acted:

```
PAYMENT_PENDING → PENDING_BANK_SETTLEMENT → COMPLETED
                                          ↘ DISPUTED
```

This adds one enum value and one transition edge; `Settlement`'s fields
are unchanged. A Liquidity Provider with a qualifying `OperationalProfile`
(section 1.1) may be granted a Policy Engine rule
(`trustedSettlementAcceleration`) that triggers `release()` on reaching
this state without waiting for the counterparty's manual confirmation —
policy-gated, not a protocol-level permission.

**Status note (added 2026-07-19, consolidation audit):** this decision
is designed, not yet migrated — the real `EscrowStatus` enum
(`prisma/schema.prisma`, `DATABASE.md`) does not have this value today.
Several docs (including this one) previously read as if it were already
live; `DATABASE.md` now flags it explicitly as the gap it is.

### 1.6 Reputation Primitive

**Responsibility:** aggregate historical behavior into a portable trust
signal tied to Identity, not to any module or platform.

```typescript
interface ReputationContract {
  get(participantId: string): Promise<ReputationScore>
  recordOutcome(event: SettlementOutcome): Promise<void>   // sole ReputationScore input (RFC-007)
  rate(negotiationId: string, raterId: string, score: number): Promise<void>  // informational only (RFC-007) — never alters ReputationScore
}
```

- **Events:** `reputation.score_updated`, `reputation.rating_submitted`,
  `reputation.fraud_flagged`
- **Relationships:** reads Settlement outcomes to compute score. Feeds
  Discovery's ranking. Tied to Identity, not to any application.
- **Implemented by:** Sails OpenReputation

**Outcome-based Reputation (RFC-007, decision D8).** `recordOutcome()` is
the only input to `ReputationScore`; `rate()` is retained purely as
feedback attached to the negotiation's history and never modifies the
score — closing an abuse pattern operators reported where a party who
cancels in bad faith could still leave a punitive rating. An internal
`OutcomeEngine` component of OpenReputation (not a primitive — same
relationship as `ProofRegistry` to OpenProof, section 1.8) classifies each
`SettlementOutcome` as `POSITIVE` / `NEUTRAL` / `NEGATIVE`, configurable
via Policy Engine. `CancelledByAgreement` always classifies as `NEUTRAL`
by construction — a cancellation can never automatically produce a
negative reputation impact on the counterparty.

### 1.7 Agent Primitive

**Responsibility:** allow autonomous or semi-autonomous execution of the
above primitives on behalf of a Participant (RFC-001), within explicitly defined
permission boundaries.

```typescript
interface AgentGrant {
  agentId: string
  delegatorId: string          // the Identity that delegated
  scope: AgentScope
  expiresAt?: Timestamp
}
interface AgentScope {
  canCreateIntent: boolean
  canNegotiate: boolean
  maxAutoSettleValue: number
  requiresApprovalAbove?: number
}
```

- **Events:** `agent.granted`, `agent.action_taken`,
  `agent.approval_requested`, `agent.revoked`
- **Relationships:** operates strictly within a delegating Participant's authority. Can
  create an Intent, participate in Discovery/Negotiation, and trigger
  Settlement — but is always attributed back to the delegating Participant for
  Reputation purposes.
- **Implemented by:** Sails OpenAgents (via QVAC — cross-cutting, not a
  hard dependency of any other module)

**The unified Agent action chain (v7.4 — CTO review finding: this flow
existed narratively in `LONG_TERM_VISION.md` but not as one concrete
diagram tied to the primitive itself):**

```
Agent
  ↓ createIntent()        — expresses a goal within AgentScope's budget
  ↓ negotiate()            — participates in the Negotiation primitive
  ↓ selectCounterparty()   — chooses from Discovery's ranked candidates
  ↓ sign()                 — the delegating Identity's WDK key signs, the
  │                          Agent itself never holds a signing key of its own
  ↓ coordinateSettlement()  — triggers the Settlement primitive
  ↓ learn()                — updates local, on-device weighting for future
                              ranking decisions based on this outcome
```

The **learn** step is the one addition this review surfaced that did not
already exist anywhere in the project: an Agent should locally adjust how
it weighs future Discovery candidates or negotiation strategies based on
completed-outcome history (fast settlement, dispute-free, good price) —
entirely on-device, per `PRINCIPLES.md` principle 8 ("Privacy Preserving")
and `SECURITY_MODEL.md`'s local-AI guarantee. This is 📋 Aspirational,
tracked under Sails OpenAgents (`ROADMAP.md` Meses 7-9) — no learning
mechanism exists in code today, and none should be implemented before
`AgentScope`'s spend/approval boundaries (section 1.7 above) are enforced
first.

**Social Engineering Agent (RFC-007, decision D7).** A specialized
OpenAgents behavior, not a new primitive: it evaluates each Timeline entry
(section 1.9) for known fraud-precursor patterns (off-channel migration
requests, unexpected payment-instruction changes, other configurable
patterns) and emits a `RiskSignal` for the Policy Engine to act on — the
agent detects, it never acts unilaterally. Runs on-device under the same
`AgentGrant`/`AgentScope` boundaries as every other Agent behavior.

### 1.8 Proof Primitive

**Responsibility:** represent a verifiable claim — "X asserts Y, and here
is evidence a third party can check" — as one consistent structure, instead
of every module inventing its own evidence format.

**Revision note (Protocol Freeze, v8.7 — CTO review):** the original
single `Proof` interface conflated three genuinely distinct concerns —
what's being asserted, what evidence supports it, and who checked it and
what they concluded — into one object with an ambiguous `status` field.
Decomposed into three interfaces, matching the same separation W3C
Verifiable Credentials draw between a claim, its credential, and its
verification. The primitive keeps the name **Proof** (already referenced
across `SDK_GUIDE.md`, `THREAT_MODEL.md`, and RFC-003 itself) — only its
internal model changes, the same way `Negotiation` kept its name when
`NegotiationEvent` was introduced inside it.

```typescript
// WHAT is being asserted — no evidence yet.
interface Claim {
  claimId: string
  claimedBy: string             // a Participant (§1.1, RFC-001)
  claimType: string             // open string — e.g. 'payment_sent',
                                 // 'keypair_control', 'collateral_held'
  assertion: unknown            // e.g. { amount: 500, currency: 'BRL' }
  createdAt: Timestamp
}

// The EVIDENCE attached to a Claim.
interface Proof {
  proofId: string
  claimId: string                // the Claim this proof supports
  evidence: unknown               // opaque — a signature, a receipt image, a bank ref
  submittedAt: Timestamp
}

// The VERDICT — a third party (or mechanism) checking a Proof.
interface Verification {
  verificationId: string
  proofId: string
  verifiedBy: string              // a Participant, an Arbiter, or QVAC
  verdict: 'ACCEPTED' | 'REJECTED'
  verifiedAt: Timestamp
  reason?: string
}
```

- **Events:** `claim.asserted`, `proof.submitted`, `verification.accepted`,
  `verification.rejected`
- **Relationships:** `IdentityProof` (section 1.1) is a `Claim` +
  `Proof` pair (asserting keypair control, evidenced by a signature).
  Fiat payment proof shared during Negotiation (section 1.4, via
  `MESSAGE_EXCHANGED` or a dedicated evidence event) is a `Claim`
  ("payment_sent") plus its `Proof` (the receipt). Consumed by the
  Dispute primitive (section 1.9) — a dispute's evidence is a set of
  `Proof`s, and its ruling is recorded as a `Verification`. Any future
  OpenFinance credit-underwriting flow needing proof of collateral or
  income follows the identical three-step shape.
- **Implemented by:** Sails OpenProof (RFC-006, `rfcs/RFC-006-openproof-module-and-packages.md`)
  — the 8th official module, added specifically because Proof was the one
  primitive with real cross-module usage (Dispute evidence, Negotiation
  payment proof, future OpenFinance underwriting) and no owner. `Claim`,
  `Proof`, and `Verification` are shared structures any module can
  populate, and any module (or arbiter, or QVAC agent) can evaluate.

**Proof Registry, `EvidenceProvider`, and Evidence Bundle (RFC-007,
`rfcs/RFC-007-real-world-p2p-requirements.md`, decisions D1/D2/D6).** Three
additions to OpenProof, none of which change `Claim`/`Proof`/`Verification`'s
shape above:

- **`ProofRegistry`** — an internal OpenProof component that fingerprints
  submitted evidence and detects reuse of the same proof across different
  Intents (e.g. a payment screenshot submitted against two separate
  disputes), surfaced as a `proof.duplicate_detected` event rather than a
  silent block — OpenProof flags reuse, the Dispute primitive (section 1.9)
  and Policy Engine decide what to do about it.
- **`EvidenceProvider`** — a new Adapter interface (`SettlementProvider`/
  `TransportProvider` pattern, section 4B below), because the protocol
  never stores media (`PRINCIPLES.md` principles 3 and 6). Each
  implementation (Nostr.build, S3, R2, IPFS, Arweave, or a Reference
  Implementation's own infrastructure) stores the media; OpenProof
  persists only a signed, hashed `EvidenceReference` pointer, which
  populates `Proof.evidence` for media-backed claims without changing
  `Proof`'s type (`evidence: unknown` already accommodates it).
  **RFC-008 addition:** `EvidenceReference.timestamp` is self-declared by
  the submitting Participant's own signature — it proves *assertion*, not
  *existence-at-a-time*. RFC-008 (`rfcs/RFC-008-verifiable-timestamps-and-chained-timeline.md`)
  adds an optional `anchorProof?: AnchorProof` field, populated via a new
  `TimestampAnchor` Adapter (OpenTimestamps/Bitcoin-anchored by default,
  RFC 3161 optionally), policy-gated rather than mandatory — for disputes
  where provable non-repudiation matters more than the cost of anchoring.
- **`EvidenceBundle`** — considered as a candidate 10th primitive in
  RFC-007 and explicitly rejected (see that RFC's "Primitives Used or
  Extended" section — it fails the irreducibility test the same way
  `Offer`, section 1.11, already did). Decision: an OpenProof-owned query
  aggregate — `getEvidenceBundle(intentId)` composes that Intent's
  `Claim[]`, `Proof[]`, `Verification[]`, Timeline entries (section 1.9),
  and `EvidenceReference[]` into one read model. It has no lifecycle of
  its own; it is a projection, not a new domain object participants
  transact around.

### 1.9 Dispute Primitive

**Responsibility:** formally resolve a disagreement between counterparties
when the happy path (Negotiation → Settlement) breaks down. This is
promoted to a full primitive — not merely a `DISPUTED` enum value inside
Settlement — because it introduces a genuinely new actor (the Arbiter),
has its own independent lifecycle, and is needed by more than one module
(OpenP2P trade disputes today; a future OpenFinance lending default is
structurally the same problem).

```typescript
interface Dispute {
  disputeId: string
  settlementId: string
  openedBy: string              // a Participant (§1.1, RFC-001)
  proofs: Proof[]                // evidence from both sides
  arbiterId?: string             // assigned once escalated
  status: 'OPENED' | 'EVIDENCE_SUBMITTED' | 'ARBITRATED' | 'RESOLVED'
  ruling?: 'RELEASE' | 'REFUND' | 'SPLIT'
}
```

- **Events:** `dispute.opened`, `dispute.evidence_submitted`,
  `dispute.arbitrated`, `dispute.resolved`
- **Relationships:** consumes **Proof** (section 1.8) as evidence and
  **Reputation** (section 1.6) for arbiter bonding — exactly the mechanism
  already narratively described in `SECURITY_MODEL.md` section 3, now
  given a real primitive. A resolved Dispute always resolves back into a
  **Settlement** state transition (release, refund, or split).
- **Implemented by:** Sails OpenSettlement today (community arbiters for
  OpenP2P trades); a future OpenFinance module could implement its own
  Dispute resolution (e.g., an insurance-backed resolver for loan
  defaults) without changing this primitive's contract — the same way
  different `SettlementProvider`s coexist.

**Escalation order and `ArbitrationProvider` (RFC-007, decision D4).**
`Dispute.status`'s progression is now explicit rather than jumping
straight to arbitration:

```
Evidence collected (OpenProof's EvidenceBundle, section 1.8)
  ↓
Policy Engine  — checks configured auto-resolution rules
  ↓
OpenAgents      — attempts automated resolution from policy + evidence
  ↓
Trusted Arbitrator (via ArbitrationProvider) — only if the above do not resolve it
  ↓
Settlement — release / refund / split
```

`ArbitrationProvider` is a new Adapter interface, registered per
application (not a protocol-native role) — deliberately not called
"Guardian" or any term implying the protocol itself governs or controls
arbitration outcomes, which would risk both a technical and a regulatory
misreading of a neutral coordination layer. `Dispute.arbiterId` and
`ruling` are populated via `ArbitrationProvider.assign()` /
`.rule()`; `Dispute`'s fields are unchanged — this formalizes how they get
set, not their shape.

**First implementation (dispute-flow work, post-RFC-011):** the `Dispute`
primitive is now persisted (`DATABASE.md`'s `disputes` table) and
`modules/open-settlement/dispute.service.ts` implements
`raiseDispute()`/`resolveDispute()` — freeze via the existing Escrow
`DISPUTED` transition, arbiter assignment via `ArbitrationProvider`
(`arbitration-provider.ts`, `TrustedArbitratorProvider`), notification via
`dispute.opened`/`dispute.resolved` on the Event Bus (RFC-010,
correlationId = tradeId). One interface refinement made in
implementation: RFC-007 D4's `rule(disputeId, arbiterId):
Promise<Dispute['ruling']>` implied the provider *computes* a ruling, but
a Trusted Arbitrator's ruling is a human decision — an external input.
`rule()` is dropped from the implemented interface;
`resolveDispute(disputeId, arbiterId, ruling)` takes the ruling as a
parameter instead. The Policy Engine → OpenAgents auto-resolution stages
of the escalation order above remain unimplemented (they depend on the
Evidence Bundle, section 1.8) — today every dispute goes straight to the
assigned Trusted Arbitrator, which is the escalation order's *last* stage
implemented first, not a different order.

**Timeline (RFC-007, decision D5; key corrected by RFC-017).** Also
considered as a candidate primitive in RFC-007 and rejected, on the same
grounds section 1.11 already rejected `Event`: it is the existing Event
Bus's mechanism made queryable in order, not a new domain concept
participants transact around. Decision: a Core-level, per-`correlationId`
read projection (`Timeline.getEvents()`) over events already emitted
under sections 1.2-1.9's event lists — no new write path, not owned by
any single module. Both the Evidence Bundle (section 1.8) and the Social
Engineering Agent (section 1.7) read from it. **Corrected 2026-07-19:**
this originally read "per-`intentId`," matching RFC-007 D5's first
draft — RFC-017 (`rfcs/RFC-017-timeline-and-social-engineering-agent.md`)
found the real events a Timeline consumer needs (chat, escrow,
negotiation) carry `tradeId` as their `correlationId` (RFC-010) today,
no Intent-to-Trade persistence link existing yet to make `intentId` the
right key. The shipped `core/timeline.ts` implements RFC-017's
correction; this section had not been updated to match until this
consolidation pass.

**Hash-chained Timeline (RFC-008, decision D2).** The implemented
`Timeline` projects persisted `DurableEvent` records per `correlationId`,
exposes `entryHash`/`prevHash`, and provides `verifyChain()` to check
links from `GENESIS_HASH` and recompute hashes from stored event fields.
The RFC-008 D2 amendment (2026-08-15) establishes `PostgresEventStore`
as the default; the original proposal to chain `EscrowEvent` and
`ReputationEvent` for the general Timeline was superseded by chaining
`DurableEvent` itself. Separate Intent and Escrow event chains have their
own integrity boundaries. This is a hash chain, not a blockchain or
consensus mechanism. Verification does not establish business-operation
idempotency, cross-operator ordering, completeness against truncation,
external timestamp anchoring, or production homologation.

### 1.10 Capability and Policy — Why They Are Coordination Components, Not Protocol Primitives

Two more concepts were proposed during architectural review: **Capability**
(what a Participant/Agent/Application is allowed to do) and **Policy** (a
configurable rule governing a primitive's behavior, e.g. fee rates, trust
limits). Both are real and valuable — but neither passes the primitive
test applied consistently to the nine above (irreducible, orthogonal, has
its own participant-facing lifecycle, cross-cutting):

- **Capability** doesn't have participants transacting around it the way
  Intent or Settlement do — it's a permission check performed by the
  protocol's coordination machinery on every other primitive's behalf. In
  the historical/reference architecture it lives in the **Capability
  Registry**, a named coordination component (see `ARCHITECTURE.md`), not a
  tenth primitive. This historical classification does not place the
  registry inside the modern Pure Sails Core.
  **Formalized in RFC-005** (`rfcs/RFC-005-capability-model.md`) as two
  related interfaces, not one — an earlier draft of this section described
  "Capability" in prose only, which let the word drift between meaning
  "a module's functional category" (`ARCHITECTURE.md`'s ecosystem diagram)
  and "a permission grant" without ever distinguishing them:

  ```typescript
  // The abstract functional category a module implements —
  // "OpenP2P implements the trade-coordination Capability."
  interface Capability {
    capabilityName: string
    version: string
    events: string[]
    states: string[]
    requiredGrants: string[]
    api: string[]
  }

  // The permission grant — "this Agent may invoke trade-coordination,
  // scoped to X, granted by Y." Previously undifferentiated from the
  // above; now its own interface per RFC-005.
  interface CapabilityGrant {
    grantId: string
    grantedTo: string              // a Participant or Agent (§1.1, RFC-001)
    capabilityName: string
    scope: string[]
    constraints?: Record<string, unknown>
    issuedBy: string
  }
  ```

  `AgentScope` (section 1.7) and `verificationLevel` (section 1.1) are
  both concrete uses of `CapabilityGrant`, unified under one mechanism.

  **Spec-vs-implementation drift claimed 2026-07-19 (consolidation
  audit), corrected 2026-08-01 — the claim itself was wrong.** The
  2026-07-19 note said the real API returns `id`, not `grantId`, based
  on the Prisma model column name (`prisma/schema.prisma`) and the route
  file's own `:grantId` URL parameter — but never traced as far as
  `src/core/capability-registry.ts`'s `toCapabilityGrant()`, which
  explicitly maps the Prisma row's `id` column to `grantId` before any
  `CapabilityGrant` response leaves the server. Checked directly against
  that mapper (and `src/common/types/capability.ts`'s own
  `CapabilityGrant` type, which already agreed with this interface): the
  real, live API has always returned `grantId`, exactly matching this
  section's interface. The SDK's `CapabilityGrant` type
  (`packages/sails-sdk/src/types.ts`) was never wrong and needed no
  change — the Prisma column being named `id` is an internal storage
  detail, not the public API contract.
- **Policy** is declarative configuration (fee rates, trust-limit tables,
  routing weights), not something created/negotiated/settled between
  parties. It lives in the **Policy / Rules Engine**, a named coordination
  component in the historical/reference architecture, consulted by the
  Coordination Engine — not a primitive. `FeePolicy`, `TrustPolicy`, and
  `RoutingPolicy` (referenced throughout `PROTOCOL_ECONOMY.md`) are concrete
  Policy instances this engine manages.

Both are documented in full in `ARCHITECTURE.md`'s historical/reference
coordination-components section — this document only needs to draw the
line clearly: these coordination components serve protocol primitives;
they are not protocol primitives themselves.

#### 1.10.1 Capability Reference — a Concrete CAN/CANNOT Table

*(Added 2026-07-19, relaying a CTO-role architectural review requesting
a concrete permission table, not just the abstract `Capability`/
`CapabilityGrant` interfaces above.)* This is not a new mechanism — it
operationalizes the two interfaces already defined in §1.10 with a
real, worked example, so "an Agent is granted a Capability scoped to X"
has a concrete shape instead of staying abstract. **This table is a
reference illustration, not itself normative** — the normative
definition remains the `Capability`/`CapabilityGrant` interfaces above
and RFC-005/013/014; if this table and those interfaces ever disagree,
the interfaces win and this table has gone stale.

**Worked example: the QVAC Agent, RFC-016's Crypto-Native Agent
boundary.** An Agent operates under a `CapabilityGrant` whose `scope`
enumerates exactly what it may invoke — everything outside that scope
is denied by construction (allow-listed, never deny-listed — RFC-005's
own `scope: string[]` shape):

| | CAN (within `scope`) | CANNOT (outside `scope`, always) |
|---|---|---|
| **Negotiation** | Rank offers, propose/accept/reject structured `Offer`/`CounterOffer` messages (`TRUST_BOUNDARY.md` boundary 3) | Parse free-form chat content as an instruction (prompt-injection boundary, RFC-016) |
| **Settlement** | Request `lockFunds`/`releaseFunds` via `SettlementProvider`, within `constraints` (e.g. `maxValue`) | Sign as the underlying `Identity` directly, or move funds through any path other than the escrow it's scoped to |
| **Fiat** | Nothing — no capability scope ever includes a fiat action | Touch PIX/ACH/SEPA/Wire/UPI in any form (Constitutional Invariant 3, Operational Invariant `INV-OP-3`) |
| **Reputation** | Nothing directly | Write `reputationScore` — only `recordOutcome()` can (`INV-OP-5`) |
| **Detection** *(RFC-017's `SocialEngineeringAgent` specifically)* | Emit a `RiskSignal` → human-facing `RISK_WARNING` | Block, delay, or mutate a trade/chat/escrow based on its own signal (`INV-OP-4`) |

The same table shape applies to any future Agent or Application —
`scope` and `constraints` are what change; the enforcement mechanism
(a `CapabilityGrant` checked at the Capability Registry, RFC-014) does
not. See `TRUST_BOUNDARY.md` §2 (boundary 4, "Agent → Settlement") for
where this check sits in the request flow, and
`PROTOCOL_INVARIANTS.md`'s Operational Invariants for the always-true
rules this table's CANNOT column restates concretely.

### 1.11 Why Participant, Offer, and Event Did Not Become Anything New Either

- **Participant** — **this entry is preserved for historical accuracy, and
  immediately superseded below.** An early proposal used "Participant" as a
  mere rename of Identity — same concept, different label — and was
  correctly rejected on those grounds. A **later, different** proposal
  (RFC-001, `rfcs/RFC-001-participant-model.md`) introduced `Participant`
  as a genuinely distinct Core-level abstraction that `Identity`
  *implements* — not a synonym, an interface. RFC-001 was accepted; see
  section 1.1 above. Two different proposals shared one name at different
  points in this project's history — this entry stays to make that
  history traceable, not to contradict section 1.1.
- **Offer** — proposed as a primitive. Rejected: it is *conceptually*
  OpenLiquidity's concrete database artifact representing a *published,
  discoverable* Intent (`DATABASE.md` section 3, `moduleId:
  "openliquidity"`), not an orthogonal concept. Stays a module-level
  entity. **Fidelity gap found 2026-07-19** (a CTO-directed audit
  comparing this claim against the real, shipped code — not a design
  question, an implementation one): `liquidity.service.ts`'s
  `createOffer()` never calls `intentEngine.create()`, and
  `trade.service.ts`'s `createTrade()` (the real "start a trade from an
  offer" path) never imports `core/intent-engine.ts` at all. **No real
  `Offer` or `Trade` in this codebase has an `Intent` database row behind
  it today** — `Intent`/`IntentEvent` (`core/intent.routes.ts`) is a
  fully separate, working code path
  (`src/core/intent-engine.ts`'s `create()`/`cancel()`/`transition()`
  are real, tested — see `TODO.md`) that the real OpenP2P trade flow
  simply never calls. Even the one script that exercises both
  (`examples/demo/pix-to-usdt-flow.ts`) creates an `Intent` and a `Trade` as
  two uncorrelated rows with no foreign key between them. This sentence's
  claim is the intended target architecture, not the current
  implementation — closing the gap (making offer/trade creation actually
  route through the Intent Engine) is real, scoped engineering work, not
  something a documentation pass can silently assert into existence.
  **RFC-018** (`rfcs/RFC-018-intent-as-canonical-trade-entry-point.md`)
  is the accepted, registered plan for closing it — also tracked in
  `TODO.md`.
- **Event** — proposed as a primitive. Rejected on a category distinction:
  Identity through Dispute (above) are *domain concepts* the protocol
  coordinates. Event is the *mechanism* by which any of their state
  changes gets communicated (`common/events/event-bus.ts`). Ethereum draws
  the same line — Logs live inside the "Receipt" primitive; the
  event-emission mechanism itself isn't a separate primitive.

  **RFC-010** (`rfcs/RFC-010-durable-event-store.md`) strengthens this
  mechanism's contract without promoting it to a primitive: every event
  now requires durability-capability (via a new `EventStore` Adapter —
  same category as `SettlementProvider`, never naming a specific backend)
  and a mandatory `correlationId` (`tradeId` today, `intentId` once Intent
  persistence exists — §2.6). Still a mechanism, just a stronger one.

### 1.12 How Each Module Uses the Primitives (summary table)

| Module | Primitives it implements/consumes |
|---|---|
| **Historical/reference coordination layer** (not a module) | In the historical/reference topology, hosts the Capability Registry, Policy/Rules Engine, and (RFC-007) the per-Intent Timeline read-model over the Event Bus that every primitive below relies on — see `ARCHITECTURE.md`. This row does **not** describe the modern Pure Sails Core boundary. |
| OpenIdentity | Implements: Identity, incl. Operational Profiles (RFC-007, module growth-path addition). Consumed by every other module. |
| OpenReputation | Implements: Reputation, incl. Outcome Engine (RFC-007) — `recordOutcome()` is the sole score input, `rate()` is informational only. Consumes: Settlement (outcomes), Identity, Proof (evidence of claimed history). |
| OpenSettlement | Implements: Settlement (incl. `PendingBankSettlement`, RFC-007), Dispute (incl. escalation order + `ArbitrationProvider`, RFC-007). Consumes: Negotiation (AgreedTerms), Proof (dispute evidence), Reputation (arbiter bonding). |
| OpenLiquidity | Implements: Discovery. Consumes: Intent, Reputation (ranking), Identity. |
| OpenP2P | Implements: Negotiation. Orchestrates: Intent → Discovery → Negotiation → Settlement using the modules above. Produces Proof (payment confirmation) during Negotiation. |
| OpenAgents | Implements: Agent, incl. Social Engineering Agent (RFC-007). Consumes: Intent (creates on behalf of Identity), Capability (delegation scope, via the Capability Registry), Timeline (RFC-007), all others via delegation. |
| OpenProof | Implements: Proof, incl. Proof Registry, `EvidenceProvider`, and Evidence Bundle (RFC-007, RFC-006). Consumes: Timeline (RFC-007) to compose the Evidence Bundle. |
| OpenFinance | Future application module. Reuses Discovery, Negotiation, Settlement, Reputation, Dispute, Proof (collateral/income verification) — adds new Intent types. |
| Sails SDK (MVP release: Sails P2P Trading SDK) | Implements no primitive — wraps every module's interface into `SailsClient`. |

*(OpenLiquidity's "Consumes: Intent" and OpenP2P's "Orchestrates:
Intent → Discovery → ..." above describe the target architecture, not
today's code — see section 1.11's `Offer` entry for the real, currently
disconnected state of `Intent`/`Offer`/`Trade`.)*

---

## 2. The Intent Engine — Full Specification

### 2.1 Why Intent, not Order

An Order is static: "buy exactly 0.005 BTC at R$67,500 via PIX." An Intent
is dynamic: "acquire BTC exposure, max R$2,000, fastest available method."
The difference matters most when AI agents enter the picture — a QVAC agent
does not operate on Orders, it interprets an Intent and decides the best
execution path.

### 2.2 Data Model

```typescript
interface Intent<T extends IntentPayload = IntentPayload> {
  id: string
  type: IntentType
  version: string                // schema version of the payload, e.g. "1.0"
  participantId: string          // the Identity that owns this Intent
  agentId?: string                // set if an Agent created it on the participant's behalf
  parentIntentId?: string        // supports composite Intents (see below)
  moduleId: string                // which module processes this (openp2p, openfinance, ...)
  payload: T                      // type-specific data — opaque to the Core
  status: IntentStatus
  createdAt: Timestamp
  updatedAt: Timestamp
  expiresAt?: Timestamp
  fulfilledBy?: string            // settlementId, once fulfilled
  metadata: Record<string, unknown>
}
```

**Composability via `parentIntentId`:** an `AgentIntent` can spawn multiple
`TradeIntent`s over time (e.g. a weekly DCA purchase). Each child Intent
references `parentIntentId`, giving a full audit trail of an agent's
decision tree — essential for trusting financial automation.

### 2.3 Intent Types and Payloads

```typescript
type IntentType =
  | 'TradeIntent'     // Sails OpenP2P — ✅ implemented (as `Offer` today)
  | 'PaymentIntent'    // Sails OpenFinance — 📋 future
  | 'SwapIntent'       // Sails OpenFinance — 📋 future
  | 'LoanIntent'       // Sails OpenFinance — 📋 future
  | 'EarnIntent'       // Sails OpenFinance — 📋 future
  | 'AgentIntent'      // Sails OpenAgents — 📋 future, can spawn sub-Intents

interface TradeIntentPayload {
  asset: AssetType
  side: 'BUY' | 'SELL'
  maxValue?: number
  minValue?: number
  currency?: string
  fiatMethod?: FiatMethod
  network?: Network
  slippageTolerance?: number
}

interface PaymentIntentPayload {
  recipientId?: string
  amount: number
  asset: AssetType
  network: Network
  memo?: string
}

interface SwapIntentPayload {
  fromAsset: AssetType
  toAsset: AssetType
  amount: number
  maxSlippage: number
  crossChain: boolean
}

interface LoanIntentPayload {
  collateralAsset: AssetType
  collateralAmount: number
  borrowAsset: AssetType
  borrowAmount: number
  termDays: number
  maxInterestRate?: number
}

interface EarnIntentPayload {
  asset: AssetType
  amount: number
  minAPY?: number
  lockupDays?: number
  riskTolerance: 'LOW' | 'MEDIUM' | 'HIGH'
}

interface AgentIntentPayload {
  goal: string                                // natural-language objective
  budget: { asset: AssetType, maxAmount: number, period: 'DAY' | 'WEEK' | 'MONTH' }
  approvalThreshold?: number                  // above this, requires human approval
  allowedIntentTypes: IntentType[]            // which sub-Intents this agent may create
  expiresAt: Timestamp
}
```

**Convention for future implementation (RFC-009).** The `number`-typed
amount fields above (`maxValue`/`minValue`, `amount`,
`collateralAmount`/`borrowAmount`, `maxAmount`) belong to Intent types
that are 📋 future / not yet implemented in any Reference Implementation.
They are **not** updated here retroactively — there is no live code to
fix — but RFC-009 (`rfcs/RFC-009-decimal-precision-for-financial-fields.md`)
establishes the rule any implementation of these payloads must follow:
financial amount fields are decimal strings (`string`), never `number`,
for the same reason `Settlement.amount` (§1.5) was corrected. Whoever
implements `PaymentIntent`, `SwapIntent`, `LoanIntent`, or `EarnIntent`
should apply this convention at build time rather than reintroducing the
bug RFC-009 fixed elsewhere.

### 2.4 Lifecycle (canonical states)

```
CREATED       — Intent published, not yet processed
     ↓
VALIDATED     — structural + financial sanity checks passed (RFC-012)
     ↓
COORDINATED   — routed to its owning module via the Coordination Engine (RFC-012)
     ↓
DISCOVERING   — active search for counterparty/liquidity (via OpenLiquidity)
     ↓
MATCHED       — candidate(s) found, awaiting negotiation
     ↓
NEGOTIATING   — terms being discussed (via Negotiation primitive)
     ↓
COMMITTED     — terms agreed, settlement requested
     ↓
SETTLING      — settlement in progress (locked, pending)
     ↓
FULFILLED     — settlement completed successfully ✅

Branches (from any active state):
  → EXPIRED    (timeout without completion)
  → CANCELLED  (explicitly cancelled by participant or agent)
  → FAILED     (settlement failed — unresolved dispute)
```

`VALIDATED` and `COORDINATED` (added by
`rfcs/RFC-012-intent-validation-and-coordination.md`) formalize checks the
Reference Implementation already performed before persistence — they do
not introduce new validation logic, only make an existing gate an
observable, audited state. Both are recorded through the same
hash-chained IntentEvent mechanism (§2.6) as every other transition.

Not every Intent type passes through every state — an `EarnIntent` might
skip `NEGOTIATING` if the rate is protocol-fixed. Each module declares its
own valid-transition table rather than the Core hardcoding assumptions.

### 2.5 Events

Namespace: `intent.*` (the Intent Engine is cross-cutting infrastructure,
not owned by any single module).

```
intent.created       { intentId, type, participantId, moduleId, parentIntentId? }
intent.validated     { intentId, participantId }                    — RFC-012
intent.coordinated   { intentId, targetModule }                     — RFC-012
intent.discovering   { intentId }
intent.matched       { intentId, candidateIds: string[] }
intent.negotiating   { intentId, negotiationId }
intent.committed     { intentId, settlementId, terms }
intent.settling      { intentId, settlementId }
intent.fulfilled     { intentId, settlementId, outcome }
intent.expired       { intentId, reason }
intent.cancelled     { intentId, cancelledBy }
intent.failed        { intentId, reason }
```

### 2.6 Persistence Design (first implementation — 03-implementation_plan.md MVP)

**Implemented as 2 tables, not the 3 originally sketched here** — the
`intent_payloads` split was designed to let a new Intent type ship with
"zero migration to the `intents` table," but a `payload Json` column
embedded directly on `Intent` already gives that same guarantee (a JSONB
column's shape isn't schema-enforced either way) without the extra join.
Simplified once this stopped being a paper design and became real Prisma
models — deviation noted here rather than left silent:

- **`Intent`** (legacy/reference Intent Engine implementation,
  `prisma/schema.prisma`) — `id, type, version, participantId, agentId,
  parentIntentId, moduleId, payload (Json), status, createdAt, updatedAt,
  expiresAt, fulfilledBy, metadata`
- **`IntentEvent`** (event-sourced, append-only — the legacy/reference
  Intent Engine's audit trail, the same per-module-owned-table pattern
  `EscrowEvent`/`ReputationEvent` already established) — `intentId,
  fromStatus, toStatus, triggeredBy, note, createdAt, entryHash, prevHash`.
  `entryHash`/`prevHash` are RFC-008 D2's hash-chaining design
  (`rfcs/RFC-008-verifiable-timestamps-and-chained-timeline.md`) —
  implemented here first, ahead of `EscrowEvent`/`ReputationEvent` picking
  it up (still 🔲 in `BACKLOG.md`), since `IntentEvent` was being built from
  scratch rather than retrofitted onto existing rows.

First real implementation: `core/intent-engine.ts`'s `create()`/`cancel()`/
`transition()`. `registerHandler`'s plugin pattern (§2.7 below) is
implemented and, as of RFC-018 Phase 3 (2026-07-20), has its first real
`IntentHandler`: `modules/open-p2p/intent-handler.ts`'s
`OpenP2PTradeIntentHandler`, registered at boot in `app.ts`. `TradeIntent`
field validation now lives there, not inlined in `intent-engine.ts` —
the legacy/reference Intent Engine's `validateStructure()` only dispatches
to whichever handler is registered for a given `IntentType`, which is also
why an unregistered type (every 📋 future one) is rejected as malformed by
construction.

### 2.7 Integration Pattern (plugin architecture)

```typescript
interface IntentHandler<T extends IntentPayload> {
  moduleId: string
  intentTypes: IntentType[]
  validate(payload: T): ValidationResult
  onCreated(intent: Intent<T>): Promise<void>
  discover(intent: Intent<T>): Promise<Candidate[]>   // optional
  onFulfilled(intent: Intent<T>, settlement: Settlement): Promise<void>
  onExpired(intent: Intent<T>): Promise<void>
}

// Registered at module boot:
intentEngine.registerHandler(OpenP2PTradeIntentHandler)
intentEngine.registerHandler(OpenFinanceLoanIntentHandler)   // future
intentEngine.registerHandler(OpenAgentsAgentIntentHandler)   // future
```

The Core never imports a module. Modules register themselves. This is the
mechanism that guarantees modularity is structural, not just a design
intention — adding Sails OpenFinance means writing a new `IntentHandler`,
zero changes to the Core.

### 2.8 Scalability Notes

- **Eventual consistency in Discovery** — Intent creation is high frequency;
  discovery is read-heavy with multiple peers polling. The model assumes
  eventual consistency across peers, compatible with HyperDHT/P2P — no
  distributed lock required.
- **Partitioning** — Intents can be partitioned by `moduleId +
  participantId` for horizontal scale in centralized reference-implementation
  deployments.
- **Expiration** — background TTL cleanup job, or lazy check on read —
  avoids constant scanning for expired Intents.
- **Event bus backpressure** — the reference implementation uses Redis
  pub/sub. Fully P2P deployments (future Pears Runtime) propagate Intents
  via HyperDHT topics keyed by `intentType + asset`.
- **Idempotency** — Intent creation must accept a client-supplied
  idempotency key, essential for network-partition tolerance in a P2P
  context where retries are common.

### 2.9 Intent Type → Module Mapping

| Intent Type | Module | Status |
|---|---|---|
| TradeIntent | Sails OpenP2P | ✅ Proven (implemented as `Offer` today) |
| PaymentIntent | Sails OpenFinance | 📋 Aspirational |
| SwapIntent | Sails OpenFinance | 📋 Aspirational |
| LoanIntent | Sails OpenFinance | 📋 Aspirational |
| EarnIntent | Sails OpenFinance | 📋 Aspirational |
| AgentIntent | Sails OpenAgents | 📋 Aspirational — can spawn sub-Intents |

---

## 3. Trade Lifecycle (Sails OpenP2P's concrete state machine)

The 9 canonical states a Trade moves through, sitting on top of the Intent
Engine's more generic states:

```
01 OFFER CREATED        — participant publishes a TradeIntent
02 COUNTERPARTY FOUND   — HyperDHT + Discovery finds and ranks matching peers
03 CHAT OPEN            — Secretstream E2E negotiation channel established
04 AGREEMENT CONFIRMED  — terms agreed via chat, escrow type selected
05 ESCROW LOCKED        — digital asset locked, SettlementProvider activated
06 PAYMENT INITIATED    — fiat sent peer-to-peer, proof shared via chat
07 ASSET SETTLEMENT     — WDK signature releases the asset to the buyer
08 COMPLETED            — trade closed, both parties rate each other
09 DISPUTE (branch)     — either party opens a dispute → Resolution Layer
```

This maps onto `TradeStatus` and `EscrowStatus` enums in `DATABASE.md` —
Trade is the coarse OpenP2P-owned lifecycle, Escrow is OpenSettlement's more
granular sub-machine.

### 3.1 Reconciling This With the Intent Engine's Generic Lifecycle (v7.2)

The CTO review correctly flagged that two 9-state lifecycles exist in this
document — the Intent Engine's generic one (section 2.4) and this
OpenP2P-specific one — without an explicit mapping between them. That
mapping is not a new design, it already existed implicitly; it is made
explicit here so no future reader has to reverse-engineer it:

| Intent Engine (generic, section 2.4) | Trade Lifecycle (OpenP2P-specific, above) |
|---|---|
| `CREATED` | 01 OFFER CREATED |
| `VALIDATED`, `COORDINATED` (RFC-012) | (transition — no OpenP2P-visible state yet; Core-only, ahead of HyperDHT search) |
| `DISCOVERING` | (transition — HyperDHT search happening) |
| `MATCHED` | 02 COUNTERPARTY FOUND |
| `NEGOTIATING` | 03 CHAT OPEN, 04 AGREEMENT CONFIRMED |
| `COMMITTED` | 05 ESCROW LOCKED |
| `SETTLING` | 06 PAYMENT INITIATED, 07 ASSET SETTLEMENT |
| `FULFILLED` | 08 COMPLETED |
| `FAILED` | 09 DISPUTE (branch), if unresolved |
| `EXPIRED` / `CANCELLED` | (no OpenP2P-specific equivalent shown above — applies before matching) |

**Why two lifecycles exist rather than one:** the Intent Engine's version
(section 2.4) is deliberately generic — it must also fit `LoanIntent`,
`SwapIntent`, and every future Intent type, none of which have a "chat
open" or "escrow locked" state in the same sense a trade does. The Trade
Lifecycle above is OpenP2P's own refinement of that generic shape for one
specific Intent type. Every future application module (Sails OpenFinance,
for instance) is expected to define its own refinement the same way —
always mapping back to the same seven generic states, never inventing a
parallel top-level lifecycle. This table is the pattern future modules
should follow when documenting their own refinement.

---

## 4. Fiat Settlement — Protocol Behavior (not an implementation detail)

The protocol coordinates fiat exchange without ever touching fiat funds.
This is a behavioral guarantee, not just a reference-implementation choice:

```
Alice: SELL 0.05 BTC | Method: BRL via PIX | Price: R$340,000/BTC
Bob:   BuyIntent(BTC, maxBRL: 17,000, method: PIX)

1. HyperDHT discovers Alice's offer → OpenLiquidity ranks by price + reputation
2. Secretstream chat opens E2E → Alice shares her PIX key
3. Escrow locks Alice's 0.05 BTC (Sails never holds the BTC itself)
4. Bob sends R$17,000 via PIX directly to Alice — outside the protocol
5. Alice confirms receipt via chat → signs the escrow release
6. 0.05 BTC arrives in Bob's WDK wallet
7. Reputation updated for both parties
```

Supported fiat methods are protocol-agnostic — the protocol only records
which method a participant prefers, never processes the payment itself:
PIX, SPEI, PSE, SEPA, SEPA Instant, ACH, Wire, Zelle, UPI, mobile money, and
others per region.

---

## 4B. The Adapter Pattern — Three Places the Protocol Must Never Hardcode a Specific System (v7.4 + v8.3 — CTO review findings)

Three places in this project risked reading as "hardcoded to a specific
external system" rather than "a category with pluggable implementations."
All three are corrected here, following the same pattern `SettlementProvider`
already established for Mock/Multisig/Lightning HODL/Liquid Covenant.

### Settlement Adapters — never depend on a specific blockchain

`SettlementProvider` (section 1.5) was always chain-agnostic in principle,
but the roadmap only ever named Bitcoin, Lightning, Liquid, Stacks, and
RSK. Broadened here to make the pattern explicit:

```typescript
// The interface never changes. Only the list of implementations grows.
interface SettlementAdapter extends SettlementProvider {
  chain: 'bitcoin' | 'liquid' | 'lightning' | 'evm' | 'solana' | 'ton' | string
}
```

Bitcoin, Liquid, Lightning HODL (already specified) sit alongside EVM
chains, Solana, and TON as equally valid future adapters — the protocol
commits to none of them specifically (`PRINCIPLES.md` principle 6,
"Infrastructure Neutral"). Adding a new chain is adding a new
`SettlementAdapter` implementation, never a change to `SettlementProvider`
itself or to any module that calls it.

**Clarification (2026-09-12, ADR-002, `docs/adr/ADR-002-asset-settlement-rail-adapter-provider-architecture.md`).**
The `SettlementAdapter extends SettlementProvider` wording above is
preserved verbatim, not rewritten — it is superseded in spirit, not in
text, by ADR-002's own frozen Adapter/Provider relationship: a
**Provider uses an Adapter** (composition), rather than an Adapter being
a specialized kind of Provider (the IS-A relationship this section's
own code sample expresses). The `chain`-qualification concept this
section already anticipated survives unchanged in substance — it
relocates conceptually onto the Adapter (or the `SettlementScope` key
ADR-002 defines) rather than onto `SettlementProvider` itself. **Current
runtime code, which co-locates both concerns in one class per rail
(`multisig.provider.ts`, `lightning-hodl.provider.ts`, etc.), remains
fully conformant** — this clarification does not require, and does not
by itself authorize, any runtime separation. No `AssetType`,
`EscrowType`, or provider code is changed by this note.

### OpenFinance Adapters — the module is a category, not an integration

`REFERENCE_IMPLEMENTATIONS.md` describes Morpho, Hyperliquid, and Polymarket
integrations mapped directly to Intent types. Read carelessly, this risks
looking like `OpenFinance` *is* a Morpho integration. It is not — Morpho is
one adapter among several OpenFinance can support:

```typescript
interface OpenFinanceAdapter {
  provider: string                      // 'morpho' | 'aave' | 'euler' | 'spark' | ...
  supportedIntents: IntentType[]
  execute(intent: Intent): Promise<Settlement>
}

// Morpho is ONE adapter, not the definition of the module:
const morphoAdapter: OpenFinanceAdapter = { provider: 'morpho', supportedIntents: ['LoanIntent'], execute: /* ... */ }
// Future adapters plug in the same way, with zero change to OpenFinance's core logic:
// aaveAdapter, eulerAdapter, sparkAdapter, futureProtocolAdapter
```

### Transport Adapters — the asymmetry the Protocol Quality Review found (v8.3)

**This is the most important of the three.** Settlement and OpenFinance
both had a pluggable-adapter pattern from the start. Transport did not —
`NODE_ARCHITECTURE.md`'s `PearNode`/`PearNodeRegistry` imports `HyperDHT`
and `Hyperswarm` directly, with no interface boundary. This broke the
protocol's own symmetry: three of four pluggable dimensions had an
adapter; one didn't.

**The decision, made explicitly rather than left ambiguous:** between
treating Pears as foundational (the way Bitcoin treats SHA-256 — fixed,
never swapped) and introducing a `TransportProvider` interface, this
project chose the interface. Reasoning: SHA-256 is a cryptographic
primitive with no meaningful alternative-selection question. P2P
transport is not — a genuinely better DHT-based or NAT-traversal
technology emerging in five or eight years is a realistic scenario, and
`PRINCIPLES.md` principle 6 ("Infrastructure Neutral") already commits the
protocol to exactly this stance for every other layer. Treating transport
as the one fixed exception would have been an inconsistency, not a
simplification.

```typescript
interface TransportProvider {
  name: string                          // 'pears' | 'libp2p' | future
  start(participant: Participant): Promise<PeerHandle>   // Participant, per RFC-001 — not Identity directly
  stop(peerId: string): Promise<void>
  joinTopic(topic: string): Promise<void>
  broadcast(topic: string, payload: unknown): Promise<void>
  sendToPeer(peerId: string, payload: unknown): Promise<boolean>
  // sendToPeer resolving false or queuing internally are both valid —
  // the protocol never assumes continuous connectivity (RFC-002
  // amendment, v8.7). A TransportProvider may be store-and-forward,
  // tolerate intermittent connectivity, or run over satellite/LoRa/
  // offline relays — sovereign finance must include participants who
  // don't have continuous connectivity, not treat them as an edge case.
  onMessage(handler: (peerId: string, payload: unknown) => void): void
  onPeerConnected(handler: (peerId: string) => void): void
  onPeerDisconnected(handler: (peerId: string) => void): void
}

// Today's only implementation — Pears/HyperDHT, exactly what PearNode
// already does, now behind the interface instead of hardcoded to it:
class PearsTransportProvider implements TransportProvider {
  name = 'pears'
  // ... wraps the existing PearNode/PearNodeRegistry logic
  // (NODE_ARCHITECTURE.md section 2) with zero behavioral change —
  // this is a refactor for the Implementation Freeze phase, not a
  // rewrite of working code.
}
```

`NegotiationChannel` (section 1.4) and `Discovery`'s peer-announcement
mechanism (section 1.3) both consume a `TransportProvider` rather than
importing HyperDHT/Hyperswarm directly — the same relationship
`SettlementProvider` already has with the modules that call it. See
`NODE_ARCHITECTURE.md` for how this maps onto the existing `PearNode`
code, which does not need to be rewritten — only wrapped behind this
interface during Implementation Freeze.

`REFERENCE_IMPLEMENTATIONS.md` section 3 should be read as "Sails Finance's
first adapter is Morpho" — not as OpenFinance being defined by Morpho. This
distinction is what lets `OpenFinance` outlive any single external
protocol it integrates with today, consistent with `LONG_TERM_VISION.md`'s
"permanent vs. temporary" framing: Intent, Settlement, and the Adapter
interface itself are permanent; Morpho, Aave, and every other named
provider are temporary, replaceable adapters.

## 5. Protocol Spec vs Reference Implementation (the separation that must never blur)

| The Protocol Spec defines | The Satsails Reference Implementation chooses |
|---|---|
| `IntentPrimitive` | TypeScript / Node.js |
| `ParticipantIdentity` (Ed25519 + levels) | PostgreSQL + Prisma |
| `SettlementProvider` interface | Redis |
| `ReputationContract` / anti-Sybil rules | Fastify |
| `LiquidityProvider` interface | HyperDHT + Pears |
| `EventContract` (typed, namespaced) | WDK for wallet operations |
| 9-state Trade Lifecycle | QVAC SDK (stubbed today) |
| Trust model, security model, privacy principles | Docker for deployment |

A different company could implement the exact same left column using Rust,
Go, Java, or C#, choosing MongoDB instead of PostgreSQL, and it would be an
equally valid Sails Protocol implementation. If any document or code
comment implies the protocol "uses PostgreSQL" or "is written in
TypeScript," that phrasing is wrong — fix it.

---

## 6. Conformance Requirements — Normative Summary (RFC 2119)

*(Added 2026-07-19 — see §0 for how MUST/SHOULD/MAY are to be read.)*
Every requirement below already appears, in prose, somewhere in sections
1-4B — this section adds no new rule, it collects the ones with real
teeth into one checklist an implementer can check against without
re-reading the whole document. **If this summary and its cited section
ever disagree, the cited section is authoritative — that means this
summary has gone stale and needs fixing, not that the disagreement is
intentional.**

**Identity / Participant (§1.1)**
- The Core MUST reference the abstract `Participant` interface, MUST NOT
  reference `Identity`'s concrete Ed25519 shape directly.
- An `Agent` implementation MUST NOT implement `Participant` directly.
- A Reference Implementation MUST NOT require DID, Credentials, or Trust
  Graph (the growth path above Level-0 Keys) for base-level
  participation — each MAY be added without changing `Identity`'s core
  contract.

**Intent (§1.2, §2)**
- A participant-initiated action MUST be expressed as an Intent, never as
  a direct, action-specific API call.
- Intent creation MUST accept a client-supplied idempotency key (§2.8).
- Every Intent status transition MUST be recorded through the
  hash-chained `IntentEvent` mechanism (§2.6); `entryHash`/`prevHash`
  MUST be computed and persisted at write time, MUST NOT be derived at
  read time (§1.9, RFC-008 D2).
- A module MAY skip Intent Engine states that don't apply to its Intent
  type, but MUST NOT invent a state outside the canonical set (§2.4).

**Discovery (§1.3)**
- Discovery MUST NOT depend on a central order-book authority.

**Negotiation (§1.4)**
- A `NegotiationChannel` implementation MUST carry `NegotiationEvent`s;
  it MUST NOT assume the counterparty is a human typing into a chat
  interface.
- `Negotiation.status` MUST NOT be extended to describe post-negotiation
  states — those belong to Settlement's own state machine (§3.1).

**Settlement (§1.5)**
- `Settlement.amount`, and every other financial amount field, MUST be a
  decimal string, MUST NOT be a JS `number` (RFC-009).
- A `SettlementProvider` MUST NOT grant the protocol, or any
  Sails-operated account, custody of the underlying asset.
- Auto-release behavior (`trustedSettlementAcceleration`) MAY be enabled
  per qualifying `OperationalProfile`, but MUST remain Policy Engine
  -gated — MUST NOT be a protocol-level default.

**Reputation (§1.6)**
- `ReputationScore` MUST be mutated only via `recordOutcome()`; `rate()`
  MUST NOT alter it.
- A `CancelledByAgreement` outcome MUST always classify as `NEUTRAL` — it
  MUST NOT be capable of producing a negative reputation impact.

**Agent (§1.7)**
- An Agent MUST operate strictly within its `AgentGrant.scope`.
- An Agent MUST NOT hold a signing key of its own — signing MUST be
  performed by the delegating Identity's key.
- Every Agent action MUST be attributed back to its delegating
  Participant for Reputation purposes.
- A fraud/risk-detection Agent behavior (e.g. the Social Engineering
  Agent) MUST NOT act unilaterally — it MAY only emit a signal for the
  Policy Engine or a human to act on.

**Proof (§1.8)**
- The protocol MUST NOT store evidence media directly — an
  `EvidenceProvider` implementation stores it; OpenProof persists only a
  signed, hashed `EvidenceReference`.
- A self-declared `EvidenceReference.timestamp` MUST NOT be treated as
  proof of existence-at-a-time — only a populated `anchorProof` (RFC-008)
  provides that guarantee.

**Dispute (§1.9)**
- A resolved Dispute MUST always resolve back into a Settlement state
  transition (release, refund, or split).
- `ArbitrationProvider` MUST be registered per application — MUST NOT be
  treated as a protocol-native role.

**Capability (§1.10, §1.10.1)**
- A Capability Registry MUST deny any action outside a
  `CapabilityGrant.scope` — grants MUST be allow-listed, never
  deny-listed.
- An Agent's `CapabilityGrant` MUST NOT include any fiat-rail scope,
  ever (Constitutional Invariant 3, `PROTOCOL_INVARIANTS.md`).

**Fiat Settlement (§4)**
- The protocol MUST NOT receive, process, or hold fiat funds at any
  point. Fiat settlement MUST happen directly between participants.

**Adapters (§4B)**
- Core logic MUST NOT hardcode a specific blockchain, wallet provider,
  custody scheme, or P2P transport — `SettlementAdapter` /
  `OpenFinanceAdapter` / `TransportProvider` interfaces MUST be used
  instead.
- A `TransportProvider` MAY be store-and-forward or tolerate
  intermittent connectivity; the protocol MUST NOT assume continuous
  connectivity.
