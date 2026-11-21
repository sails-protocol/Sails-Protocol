# P2P Product Journey — End-to-End Economic Journey (`MISSÃO 2`, 2026-09-12)

**Status:** Product/UX Journey Model. Institutionalizes the P2P economic
journey end to end: Runtime Truth → Product State → User-facing State →
Required Action → Authority/Risk → Agent/Operator/Integrator
representation → Interruption/Recovery behavior. **Creates no new
protocol truth, invents no state the runtime does not support, changes
no architecture, and authorizes no implementation.** Every state, gap,
and boundary named below was verified against real source (`prisma/schema.prisma`,
`escrow-lifecycle.ts`, `dispute.service.ts`, `escrow.service.ts`,
`trade.service.ts`, `sails-ui`, `@satsails/p2p-schemas`) on 2026-09-12,
not deduced from documentation or from the UI alone, per this mission's
own explicit instruction. Builds on, and uses the notation of,
`docs/PRODUCT_INTERACTION_MODEL.md` (USR/AGT/OPS/INT, corrected
`ACTOR-EXPERIENCE-MODEL-R1`).

**North star, restated:** One economic reality, multiple actor-specific
experiences. `Offer ≠ Trade ≠ Settlement ≠ Payment/Funding`. Unknown
outcome ≠ failed outcome. The system may simplify presentation; it may
not simplify away material economic truth.

## Sources consulted

`docs/PRODUCT_INTERACTION_MODEL.md`, `docs/PROJECT_CONTEXT.md`,
`docs/BACKLOG.md`, `docs/SAILS_DESIGN_LANGUAGE.md`,
`docs/SAILS_MARKET_DESIGN_DIRECTION.md`, `docs/SEMANTIC_KERNEL.md`,
`docs/PRINCIPLES.md`, `docs/DAY0_COMPLETENESS_COLD_SWEEP.md`,
`docs/PROTOCOL_SPECIFICATION.md`, `docs/DATABASE.md`,
`docs/DESTINATION_AUTHORITY_ARCHITECTURE.md`,
`docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md`, `docs/adr/ADR-001-day0-multi-operator-network.md`,
`docs/adr/ADR-002-asset-settlement-rail-adapter-provider-architecture.md`,
`docs/rfcs/RFC-004-negotiation-state-machine.md`,
`docs/rfcs/RFC-007-real-world-p2p-requirements.md`,
`docs/rfcs/RFC-009-decimal-precision-for-financial-fields.md`,
`docs/rfcs/RFC-012-intent-validation-and-coordination.md`,
`docs/rfcs/RFC-015-dual-authorization-escrow-release.md`,
`docs/rfcs/RFC-018-intent-as-canonical-trade-entry-point.md`,
`docs/rfcs/RFC-019-settlement-custody-reference-vs-normative.md`,
`docs/rfcs/RFC-021-market-based-arbitration-and-payment-trust.md`,
Issues #99, #105, #125, #86, and real code: `prisma/schema.prisma`,
`src/core/state-machine.ts`, `src/core/intent-engine.ts`,
`src/modules/open-settlement/escrow-lifecycle.ts`,
`src/modules/open-settlement/escrow.service.ts`,
`src/modules/open-settlement/dispute.service.ts`,
`src/modules/open-p2p/trade.service.ts`,
`packages/sails-p2p-schemas/src/trade.ts`,
`packages/sails-ui/src/{types.ts,components/ui/StatusBadges.tsx,pages/Disputes.tsx,lib/multisigSigningIntent.ts}`.

---

## 1. Canonical P2P Journey

The canonical journey is **not a new invention** — it is
`docs/PROTOCOL_SPECIFICATION.md` §3's own 9-state Trade Lifecycle,
reconciled with the Intent Engine's generic lifecycle (§2.4/§3.1 of that
document), read against real, current code (2026-09-12) rather than the
document's own text alone — because that text is itself stale in one
material respect corrected below (§1.1).

| # | Macro-stage (mission's vocabulary) | Trade Lifecycle (`PROTOCOL_SPECIFICATION.md` §3) | Product Direction | Representable | Implemented | Real | Evidenced | Beta Eligible | Production Eligible |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Discovery | 01 OFFER CREATED, 02 COUNTERPARTY FOUND | ✅ | ✅ | ✅ | ✅ (`Offer` table, `Marketplace.tsx`) | ✅ | ✅ | ⚠️ — see §1.2 |
| 2 | Offer Evaluation | (within 02) | ✅ | ✅ | ✅ (`OfferDetail`-class screen, `FilterPanel.tsx`) | ✅ | ✅ | ✅ | ⚠️ — see §1.2 |
| 3 | Economic Commitment | 03 CHAT OPEN → 04 AGREEMENT CONFIRMED | ✅ | Partial — see §2 | Partial | Partial | Partial | ⚠️ | ⚠️ |
| 4 | Trade Lifecycle (coordination) | 04→05, `Trade`/`TradeStatus` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ (see §4 provider caveats) |
| 5 | Payment/Funding | 06 PAYMENT INITIATED | ✅ | Partial — see §9/§10 | Partial (fiat: chat+proof; crypto lock: real per-provider) | Partial | Partial | ⚠️ | ⚠️ |
| 6 | Authorization/Signing | (within 05-07) | ✅ | Partial — see §11 | Partial (RFC-015 real, opt-in; client-signature-collection real for 3 rails) | Partial | Partial | ⚠️ | ⚠️ |
| 7 | Settlement | 07 ASSET SETTLEMENT | ✅ | ✅ | ✅ (varies by `EscrowType`, see §4) | Varies | Varies | Varies | ❌ for `WDK_USDT_EVM` (`PRODUCTION-INELIGIBLE`, boot-enforced) |
| 8 | Outcome | 08 COMPLETED | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 9 | Cancel | (branch, any pre-COMMITTED state) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 10 | Dispute | 09 DISPUTE (branch) | ✅ | Partial — see §17 (SPLIT gap) | ✅ (core flow) / ⚠️ (SPLIT UX) | ✅ | ✅ | ⚠️ | ⚠️ |

Classification legend follows this mission's own scale: **Product
Direction** (named, intended) → **Representable** (a real field/state
exists to hold it) → **Implemented** (code path exists) → **Real**
(exercised against real, non-mocked infrastructure at least once) →
**Evidenced** (a document/test proves the above) → **Beta Eligible** →
**Production Eligible**. A row is never marked Production Eligible
higher than its weakest real dependency — e.g. row 7 (Settlement) is
capped by whichever `EscrowType` a given trade actually uses (`MULTISIG`/
`LIGHTNING_HODL` non-custodial and mainnet-proven for BTC per
`docs/MAINNET_MULTISIG_PROOF.md`; `WDK_USDT_EVM` boot-refused in
production per `docs/rfcs/RFC-019-settlement-custody-reference-vs-normative.md`).

### 1.1 Correction to `PROTOCOL_SPECIFICATION.md` §1.11 (stale, verified against real code 2026-09-12)

§1.11's `Offer` entry states (2026-07-19 audit) that *"No real `Offer` or
`Trade` in this codebase has an `Intent` database row behind it
today"* and names RFC-018 as the accepted, not-yet-executed plan to fix
it. **This is no longer accurate** — verified directly against
`src/modules/open-p2p/trade.service.ts` (2026-09-12): `Offer.intentId`
is a real, populated field; `trade.service.ts`'s `createTrade()` carries
`offer.intentId` onto the new `Trade` and drives real
`intentEngine.transition()` calls (`DISCOVERING` → `MATCHED` →
`NEGOTIATING`) against the Intent Engine (`src/core/intent-engine.ts`) —
exactly the target architecture §1.11 itself described as not-yet-real.
Backward compatibility is preserved for offers created before RFC-018
landed (`offer.intentId` null → skipped, not an error). **This is a
documentation-staleness finding (classification H), not a new
architectural fact** — RFC-018 is not being re-authorized or re-scoped
here; its own text already described this as the target. Flagged in
§26 (Documentation deltas) for a correction pass on
`PROTOCOL_SPECIFICATION.md` itself — not made here, since that document
is outside this mission's own edit list (§22 of the mission brief).

### 1.2 Maturity correction — Discovery / Offer Evaluation (`P2P-JOURNEY-GATE-R1`, 2026-09-13)

**Original §1 table over-claimed Production Eligible ✅ for both rows
without checking either real, applicable gate below.** Corrected here
using GitHub Issue #105's own maturity discipline (*"EXISTS ≠
IMPLEMENTED ≠ REAL ≠ EVIDENCED ≠ PRODUCTION ELIGIBLE"*, its own
2026-09-10 comment).

**Gate 1 — Technical Debt #61 (public Offer privacy defect), independently
re-verified against real code, 2026-09-13 (not taken from either
document's own claim):** `src/modules/open-liquidity/liquidity.service.ts`'s
`getOffer()` (the real handler for `GET /v1/liquidity/offers/:id`,
`OfferDetail.tsx`'s data source) uses an explicit Prisma `select` that
excludes `paymentDetails` and every non-canonical `User` field, mapped
through `mapOfferToPublicDetail()` into a dedicated `PublicOfferDetail`
type — verified line-by-line, not inferred from the doc's own claim.
**This defect is fixed, not open** — `docs/TECHNICAL_DEBT_AUDIT.md`
item #61's own section **heading** still reads "— OPEN," but its body
(the "Remediation (Bounded, 2026-09-10)" subsection, two paragraphs
below the heading) already documents this exact fix with real
evidence (`tests/publicOfferDetailDisclosure.test.ts`, 11 tests;
157/157 suites green at the time). GitHub Issue #105's own item 37
text ("Close Technical Debt #61 before Partner Beta... currently
returns raw `Offer.paymentDetails`") is stale for the same reason —
neither is corrected here (out of this document's own edit list), both
are named as documentation deltas (§26). **Gate 1 does not block
Production Eligible.**

**Gate 2 — Day-0 Multi-Operator Network completion (Issue #105's own,
much larger gate), the real reason Production Eligible does not
apply:** Issue #105's own completion rule states *"this issue is not
complete because tickets are closed. It is complete only when the
named properties have evidence and the Partner Beta / Production gates
accept that evidence."* Its ordered path (items 1-25) names portable
signed Offers, persistent Transport Identity, propagation/bootstrap,
anti-entropy/partition-healing, multi-node discovery/convergence, a
self-authenticating Node Descriptor, cross-node trade-open handshake,
and eleven required adversarial network tests (Late Join, Partition
Heal, Tombstone Resurrection, Eclipse, Node-Key Rotation, ...) — **none
of which exist in this single-node reference implementation** (already
established, not re-derived here: `docs/PRODUCT_INTERACTION_MODEL.md`
§3's own frozen A/B/C/D identity taxonomy confirms Operational Sails
Node Identity, C, "does not exist yet," and `docs/DAY0_COMPLETENESS_COLD_SWEEP.md`
is the full evidence trail). Discovery today means "discover offers on
this one node's own database" — real, correct, and evidenced *for a
single node* — not yet "discover offers across a Day-0 Multi-Operator
Sails Network," which is what Issue #105's own title names as the
Production gate. **This is the real, applicable reason Discovery/Offer
Evaluation are Beta Eligible (single-node, real, evidenced) but not
Production Eligible** — independent of, and unrelated to, Technical
Debt #61.

Corrected classification: **Discovery/Offer Evaluation: Beta Eligible
✅ (single-node); Production Eligible ⚠️ gated on Day-0 Multi-Operator
Network completion (Issue #105), not on Technical Debt #61 (verified
closed).**

---

## 2. Economic Commitment Boundary

**The question this section answers:** at what point does a participant
move from exploration/negotiation into real economic commitment?

**Rule, per the mission's own instruction:** `Offer ≠ accepted Offer
revision ≠ Trade ID ≠ Economic Terms`. No cryptographic commitment is
implemented or proposed here — only what the product must make legible.

### 2.1 What actually gets bound, and where, today

| Term | Bound at | Real backing today | Gap |
|---|---|---|---|
| Accepted Offer revision/envelope | `Trade` creation (`offerId` FK) | ✅ `Trade.offerId` | `Offer` has no revision history — an `Offer` is mutable (`priceUsd`, `minAmount`/`maxAmount` can change between listing and acceptance); **no snapshot of the exact terms shown at the moment of acceptance is persisted separately from the live `Offer` row.** A `Trade`'s own `amount`/`priceUsd`/`totalUsd` ARE snapshotted (real, own columns, not FKs into the live `Offer`) — so the *trade's* terms are frozen correctly; what is not separately frozen is *which exact Offer state the participant saw and agreed to* before that snapshot was taken. This is a real, named gap (classification A), not solved here. |
| Amount / price / asset | `Trade` creation | ✅ `Trade.amount`, `Trade.priceUsd`, `Trade.totalUsd` (RFC-009 `Decimal`) | None — genuinely snapshotted. |
| SettlementScope / network / rail | `Trade.network` (nullable), `Escrow.type`/`Escrow.network` | ✅ but resolved via `recommendedEscrowType(asset)` at escrow-creation time, not chosen by the participant at commitment time | The participant commits to an *asset*, not explicitly to a *rail* — `Escrow.type` is a system decision, disclosed but not a separate consent moment. Legitimate deferral (classification G) — not every asset has more than one real rail today (`docs/DATABASE.md` §2). |
| Fiat amount / currency | `Trade.priceUsd`/`totalUsd` (USD) + `Offer.priceBrl` (nullable) | ✅ | `priceBrl` is nullable/optional — a BRL-denominated trade's fiat terms are not uniformly snapshotted the way USD is. Named, not fixed here. |
| Payment method | `Offer.paymentMethod` (single enum value per Offer) | ✅ | An `Offer` names exactly one `PaymentMethod` — the commitment is real and legible, but see Payment Destination (§16) for why "payment method" ≠ "payment destination." |
| Payment-destination commitment | Negotiation (chat) only | ❌ not a structured commitment | The actual PIX key/bank account is exchanged as free-text chat content (`Message.msgType`), never a structured, bound field. This is `PaymentAccount` territory (real model, real trust ramp) but nothing in `Trade`/`Escrow` *binds* which registered `PaymentAccount` a given trade used. Real gap (classification A) — see §16. |
| Settlement/custody mechanism | `Escrow.type` at escrow-creation | ✅ | Disclosed to the participant via UI, not a separate consent artifact. |
| Fee/policy version | `FeeCollectionEvidence.distributionPolicyVersionId`, frozen at `COLLECTED` time (`docs/DATABASE.md` §3) | ✅ for the *distribution* side; **`protocolFeeRate` itself defaults to `0`** in every environment this repo evidences | The mechanism to freeze a fee/policy version at commitment time is real and CTO-frozen (Missão 11 Fase 7.2) — but since `protocolFeeRate` has never been non-zero in evidence, this axis is real infrastructure with no live economic instance yet. Legitimate deferral (G). |
| Arbitration authority/policy | `.env`'s `TRUSTED_ARBITRATORS`, `ARBITRATION_MODE` | ✅ but **not bound per-trade** — it is a deployment-wide setting, read at dispute time, not committed at trade-creation time | A participant commits to a trade without knowing, at that moment, which specific arbiter identity would resolve a future dispute (only that *some* trusted/market arbiter exists under the deployment's current policy). Legitimate deferral (G) — binding a specific arbiter ahead of any dispute would be over-engineering for a mechanism most trades never use. |

### 2.2 Current Runtime Coordination Commitment (corrected `P2P-JOURNEY-GATE-R1`, 2026-09-13 — was mislabeled "the Economic Commitment Boundary")

**`Trade` creation is the Current Runtime Coordination Commitment — not
a complete Economic Commitment Boundary.** The moment `POST` to create
a Trade from an accepted Offer succeeds (`trade.service.ts`'s
`createTrade()`): before it, everything is `Offer` browsing, filtering,
and chat-based negotiation — fully reversible, no economic exposure.
At this moment: `Trade.amount`, `priceUsd`, `totalUsd`, `asset`,
`offerId`, `buyerId`, `sellerId` are durably persisted and, where
`offer.intentId` exists (§1.1), the Intent Engine transitions into
`NEGOTIATING`. **This is a coordination commitment, not yet a funds
commitment** — no asset has moved and no escrow has locked anything at
`Trade` creation; that is `Escrow.status: FUNDS_LOCKED`, a later,
separately-observable moment (Trade Lifecycle state 05):

```
Coordination commitment  →  Trade row created (reversible via CANCELLED
                              until an escrow exists; irreversible in
                              the sense that a Trade ID + snapshot now
                              exists and is visible to both parties)
Funds commitment          →  Escrow.status: FUNDS_LOCKED (an asset is
                              now genuinely locked; refund still
                              possible per VALID_TRANSITIONS, but this
                              is the first moment real economic value is
                              at stake for whichever party funded it)
```

**Neither of the above is the *complete* Economic Commitment Boundary
this mission's own §2 question asked about.** §2.1's own table already
found several of the terms Issue #105 requires bound are *not* yet
durably bound at `Trade` creation (the accepted Offer revision/envelope
itself; the payment-destination commitment; arbitration policy). §2.3
names the real, target boundary these gaps are measured against.

**Issue #105's own institutional truth, reapplied:** `Economic
Disposition Authority ≠ Destination Authority ≠ Execution Authority`
(F1 closure) governs *after* commitment, not the commitment moment
itself — reconfirmed, not re-litigated, in §16.

### 2.3 Target Economic Commitment Boundary (Issue #105, Cold Sweep Loops 2-3 — restated, not redesigned)

**Definition:** the Target Economic Commitment Boundary is the point at
which every material economic term Issue #105 requires is durably
bound — not merely `Trade.amount`/`priceUsd`/`totalUsd` (already real,
§2.1) but the full set below, verbatim from Issue #105's own Cold Sweep
Loop 2 (item 27) and Loop 3 (items 30-36):

> *"Trade-open anchor must bind exact accepted Offer revision/envelope
> hash + amount + price + asset + network/rail + required payment
> semantics + tradeId"* (item 27); *"Exact fiat amount/currency/
> payment-method commitment before fiat payment becomes binding"* (30);
> *"Privacy-preserving payment-destination commitment"* (31);
> *"Authenticated amendment required for any post-commit
> payment-instruction change"* (32); *"Selected settlement mechanism /
> EscrowType / custody semantics bound before economic commitment"*
> (33); *"Participant-facing fee/policy version frozen before
> commitment"* (34); *"Cross-node arbitration authority/policy/appeal
> semantics fixed by the trade/settlement agreement"* (35).

**Preserved, verbatim:** *Offer Identity ≠ Accepted Offer Revision*;
*Trade ID ≠ Economic Terms* (Issue #105, Cold Sweep Loop 2).

**Current reality against this target (§2.1's table, restated as a
gap list, nothing new):**

| Issue #105 item | Bound today? |
|---|---|
| 27 — exact accepted Offer revision/envelope hash | **No** — `Trade.offerId` is a live FK, not a snapshotted hash of the exact revision shown at acceptance |
| 27 — amount, price, asset, tradeId | **Yes** — `Trade.amount`/`priceUsd`/`totalUsd`/`asset`/`id` |
| 27 — network/rail | **Partial** — `Trade.network` nullable; `Escrow.type` resolved system-side, not participant-chosen |
| 30 — fiat amount/currency/payment-method | **Partial** — USD leg real; BRL (`priceBrl`) nullable |
| 31 — payment-destination commitment | **No** — exchanged as free-text chat, not a structured, bound field |
| 32 — authenticated amendment for post-commit payment-instruction change | **No** mechanism exists to bind or amend one at all yet (31 is a precondition) |
| 33 — settlement mechanism/`EscrowType` bound before commitment | **Yes** — resolved and persisted at escrow-creation, immediately after `Trade` creation |
| 34 — fee/policy version frozen | **Yes, mechanically** (`FeeCollectionEvidence.distributionPolicyVersionId`) — but never yet economically live (`protocolFeeRate` always `0`) |
| 35 — arbitration authority/policy fixed per-trade | **No** — deployment-wide setting, read at dispute time |

**No cryptographic anchor is implemented, designed, or proposed by this
section** — per the mission's own explicit instruction, this maps only
what the product must make legible; hashing/signing a trade-open anchor
(item 27's own "hash") remains Issue #105's own future evidence
obligation, not something this document builds toward a mechanism for.

---

## 3. Runtime State Inventory (audited against real code, 2026-09-12)

Real, current enums (`prisma/schema.prisma`):

```
OfferStatus     ACTIVE | PAUSED | COMPLETED | CANCELLED
TradeStatus     PENDING | ACTIVE | COMPLETED | DISPUTED | CANCELLED
EscrowType      MULTISIG | LIGHTNING_HODL | LIQUID_COVENANT (reserved,
                unimplemented) | WDK_USDT_EVM | SAFE_GUARD_EVM | MOCK
EscrowStatus    CREATED | FUNDS_LOCKED | PAYMENT_PENDING | COMPLETED |
                DISPUTED | REFUNDED | SPLIT | EXPIRED
DisputeStatus   OPENED | EVIDENCE_SUBMITTED | ARBITRATED | RESOLVED |
                APPEALED | AUTO_PROPOSED
DisputeRuling   RELEASE | REFUND | SPLIT
```

**Correction to `docs/DATABASE.md` (classification H, stale doc, verified
against `prisma/schema.prisma` 2026-09-12):** that document's own §2
copy of the `EscrowType` enum omits `SAFE_GUARD_EVM` (a real, wired,
tested provider per `docs/BACKLOG.md`'s own "Fifth real provider"
entry) and its `EscrowStatus` enum + ASCII transition diagram omit
`EXPIRED` entirely (real since Missão 11 Fase 7.3.3) and never show
`DISPUTED → SPLIT` as a transition edge (real since RFC-021 D9,
2026-08-02) even though the same document's own prose, two paragraphs
later, correctly describes `SPLIT` as "only reachable from DISPUTED."
Not corrected in `DATABASE.md` itself by this mission (out of this
document's own edit list) — named here as a documentation delta (§26).

Real escrow transition graph (`escrow-lifecycle.ts`'s own
`VALID_TRANSITIONS`, verified line-by-line, 2026-09-12):

```
CREATED         → FUNDS_LOCKED, REFUNDED
FUNDS_LOCKED    → PAYMENT_PENDING, DISPUTED, REFUNDED, EXPIRED
PAYMENT_PENDING → COMPLETED, DISPUTED
COMPLETED       → (terminal)
DISPUTED        → COMPLETED, REFUNDED, SPLIT
REFUNDED        → (terminal)
SPLIT           → (terminal)
EXPIRED         → DISPUTED, REFUNDED   (never directly COMPLETED/SPLIT —
                                          those still require a real
                                          dispute ruling first)
```

Intent Engine generic states (`core/state-machine.ts`, matches
`PROTOCOL_SPECIFICATION.md` §2.4 exactly, real and implemented):
`CREATED → VALIDATED → COORDINATED → DISCOVERING → MATCHED →
NEGOTIATING → COMMITTED → SETTLING → FULFILLED`, branching to
`EXPIRED`/`CANCELLED`/`FAILED`.

**Classification, per the mission's §5 instruction:**

| State group | runtime-only | product-worthy | user-visible | operator-only | agent-relevant | integrator-facing | deprecated/ambiguous |
|---|---|---|---|---|---|---|---|
| `OfferStatus.*` | | ✅ | ✅ | | ✅ | ✅ | |
| `TradeStatus.*` | | ✅ | ✅ | | ✅ | ✅ | |
| `EscrowStatus.CREATED/FUNDS_LOCKED/PAYMENT_PENDING/COMPLETED/DISPUTED/REFUNDED` | | ✅ | ✅ | | ✅ | ✅ | |
| `EscrowStatus.SPLIT` | | ✅ (material) | ⚠️ **ambiguous — see §7** | | ✅ | ✅ | ⚠️ |
| `EscrowStatus.EXPIRED` | | ✅ | ✅ (real, "trade still open" framing) | ✅ (recovery detail) | | ✅ | |
| `DisputeStatus.*` / `DisputeRuling.*` | | ✅ | ✅ | ✅ (arbiter-scoped detail) | | ✅ | |
| Intent Engine generic states (`VALIDATED`/`COORDINATED`/`DISCOVERING`) | ✅ | | | | ✅ (machine-readable) | ✅ (SDK-level) | |
| WDK funding-outcome states (§10, analytical, not persisted) | ✅ today | ✅ target | ✅ target | ✅ | ✅ | ✅ | not yet product-worthy — no persisted representation exists |

---

## 4. Product State Inventory & 5. User-facing State Grammar

The canonical **Product State** vocabulary is `@satsails/p2p-schemas`'
`TradeState` (`packages/sails-p2p-schemas/src/trade.ts`) — a real,
shipped, derived (not separately stored) read-model over
`Trade.status`/`Escrow.status`/`Dispute.status`+`ruling`:

```
open | payment_sent | payment_confirmed | escrow_released |
dispute_opened | dispute_resolved_buyer | dispute_resolved_seller |
cancelled
```

`sails-ui`'s own user-facing grammar (`StatusBadges.tsx`,
`lib/labels.ts`) renders `TradeStatus`/`EscrowStatus`/`OfferStatus`
directly (not `TradeState`) via `Record<Enum, label/color/icon>` maps —
Portuguese labels (e.g. `FUNDS_LOCKED` → "Fundos travados",
`DISPUTED` → "Em disputa"), semantic colors per
`docs/SAILS_DESIGN_LANGUAGE.md` §1/§2 (orange reserved for `EXPIRED`
only, disclosed as a separate role from brand orange — `UI-GATE-CLOSE-1-R1`).

| Runtime/Protocol Truth | Product State (`TradeState`) | User Copy (`sails-ui`, PT-BR) |
|---|---|---|
| `Escrow.status = FUNDS_LOCKED` | `open` | "Fundos travados" |
| `Escrow.status = PAYMENT_PENDING` | `payment_sent` | "Aguardando pagamento" |
| `Escrow.status = COMPLETED` | `escrow_released` | "Concluído" |
| `Escrow.status = REFUNDED` | `cancelled` | "Reembolsado" |
| `Escrow.status = EXPIRED` | `open` (explicit decision, §7) | "Expirado" (own badge exists, distinct orange) |
| `Dispute.status = RESOLVED`, `ruling = RELEASE` | `dispute_resolved_buyer` | "Em disputa" (Trade-level; `Disputes.tsx` shows the ruling directly) |
| `Dispute.status = RESOLVED`, `ruling = SPLIT` | `dispute_opened` (mismapped — §7); **fixed 2026-09-13, see §6 correction: now `dispute_resolved_split`** | no dedicated Escrow-status copy (`SPLIT` absent from `StatusBadges.tsx`'s `Record<EscrowStatus,...>`); **fixed 2026-09-13, see §6 correction** |

---

## 6. SPLIT Analysis (mandatory, §6 of the mission brief)

**Correction (P3-F05, Pre-M3 Reality Gate, 2026-09-13):** everything
below in this section describes the gap **as it stood when this
document was written**. It has since been fixed — `COHERENCE-CORRECTIVE-1`
(PR #141, merged) closed it precisely along the lines this section
itself recommended: `packages/sails-p2p-schemas/src/trade.ts`'s
`deriveTradeState()` now returns a dedicated `'dispute_resolved_split'`
`TradeState` (both via the `Dispute`-row path and the `Escrow.status`-only
fallback switch), and `sails-ui`'s `EscrowStatus` type/`StatusBadges.tsx`
now carry a real `SPLIT` entry (label, color, icon). The analysis is
preserved below, unedited, as the historical record of the defect and
its reasoning — it is no longer current runtime truth. See
`docs/SYSTEM_COHERENCE_INTEGRATION_AUDIT.md` §21A for the closure
record.

**Is `SPLIT` economically material?** Yes, unambiguously — it represents
a real, on-chain-or-ledger partial payout to *both* parties (buyer and
seller each receive a share; `RFC-021` D9), a materially different
economic outcome from `COMPLETED` (buyer receives 100%) or `REFUNDED`
(seller receives 100%). Conflating any of the three would misstate how
much value a real participant actually received.

**Does it exist as a Product State today?** No — and the gap is worse
than a missing badge:

1. **`sails-ui`'s own `EscrowStatus` type
   (`packages/sails-ui/src/types.ts:159`) omits `SPLIT` entirely**,
   self-disclosed in the file's own comment ("SPLIT (RFC-021 D9) is a
   separate, pre-existing gap in this same type... disclosed, not fixed
   here"). `StatusBadges.tsx`'s `Record<EscrowStatus, ...>` maps
   (label/color/icon) inherit the same omission for the identical,
   disclosed reason. **Runtime effect:** since JavaScript does not
   enforce the TypeScript union at runtime, a real `SPLIT` value
   returned by `GET /v1/settlement/escrow/:id` would produce
   `undefined` label/color/icon lookups — an empty or malformed status
   pill, not a wrong-but-legible one.
2. **`deriveTradeState()`'s own logic mishandles `SPLIT` in two
   distinct, independently-verified ways** (`packages/sails-p2p-schemas/src/trade.ts`):
   - Via the `Dispute` row path (the normal path — a resolved dispute is
     looked up directly): `status: 'RESOLVED', ruling: 'SPLIT'` **falls
     through to `dispute_opened`** — the file's own comment: *"SPLIT has
     no buyer/seller-exclusive equivalent in this vocabulary — falls
     through to dispute_opened rather than fabricating a winner."* This
     reports an **already-resolved** dispute as **still open**.
   - Via the `Escrow.status`-only fallback switch (reached only if the
     `Dispute` row lookup is unavailable to the caller): `SPLIT` is not
     one of the switch's cases at all (`EscrowStatusInput`'s own type
     doesn't include it either) — it falls to `default: return 'open'`,
     reporting a trade that has **already concluded with a partial
     payout** as **not yet started**.
3. **`Disputes.tsx` (the arbiter-facing UI) *does* fully support issuing
   a `SPLIT` ruling** — `SPLIT_SUPPORTED` correctly gates it to
   `MOCK`/`WDK_USDT_EVM`/`MULTISIG` (the only types RFC-021 D9 gives a
   real settlement action to), and the resulting toast/label are
   correct. **The gap is entirely on the read/status side, after the
   ruling has already been applied** — not on the arbiter's ability to
   issue it.

**Should it be abstracted, or exist as its own state?** It should exist
as its own, explicit, distinguishable Product State (or at minimum a
correct, non-misleading `TradeState` mapping — e.g. a
`dispute_resolved_split` value, or an explicit "partial" branch) — not
silently coerced into `open`/`dispute_opened`/`COMPLETED`/`REFUNDED`, any
of which would misstate either *whether* the trade concluded or *how
much* a party received. This is not a decision made here (§9 non-goals);
it is named as a real gap requiring a Product Decision (§23).

**Which actor needs to see it?** USR (both parties — to know they
received a partial amount, not the full negotiated amount), OPS-2
(Arbiter — to confirm the ruling executed as intended), INT (an
integrator reconciling balances needs the real terminal state, not a
value indistinguishable from "still negotiating").

**Risk if it simply disappears:** a real participant who received 50%
of an escrowed asset would see either a blank/malformed status pill, or
a status implying the trade is still unresolved, or (via the derived
`TradeState`) a status that could read as "in dispute" indefinitely —
none of which communicates the real, final, partial-payout outcome that
already occurred. This is the exact "backend state disappearing without
an explicit product mapping" scenario the mission's own principle
names.

**Does the runtime have enough information to map this correctly?**
Yes, fully — `Escrow.status = SPLIT`, `Dispute.ruling = SPLIT`,
`EscrowPendingTransaction.toAddress`/`toAddressSecondary` (buyer/seller
payout legs), and `DisputeAppealFee`/`ArbiterProfile` context are all
real, persisted, and already correctly used by `Disputes.tsx` on the
write side. This is a pure UX/type-mirror gap, not an information gap —
consistent with the mission's own instruction that a backend state "may
be intentionally abstracted... but cannot disappear without an explicit
product mapping": today it has disappeared, not been deliberately
abstracted.

**Not corrected here**, per the mission's explicit instruction (§6/§21)
— named, classified (**A** — Product truth omitted), registered as a
Backlog delta (§24).

---

## 7. Derived-State / False-Certainty Analysis (mandatory, §7)

Audited `deriveTradeState()` and the `TradeState` vocabulary directly
(not assumed from naming) for cases where distinct runtime facts are
collapsed without disclosure, and for cases where the collapse is
honestly disclosed:

| Pair collapsed | Backing distinction exists? | Handling |
|---|---|---|
| `payment_sent` vs `payment_confirmed` | **No** — `EscrowStatus` has only one `PAYMENT_PENDING` value for both "buyer marked sent" and "seller acknowledged received" | **Honestly aliased**, disclosed in the schema's own comment: *"a real gap worth stating plainly rather than papering over... `payment_confirmed` is aliased to `payment_sent` below until a real intermediate confirmation step exists."* This is the mission's rule applied correctly: the runtime cannot distinguish the two, and the code does not pretend it can — it exposes the coarser, honest state. |
| `EscrowStatus.EXPIRED` → `TradeState: open` | Distinction exists (`EXPIRED` is its own enum value) but is deliberately **not** surfaced as its own `TradeState` | **Honestly, explicitly collapsed** — the code's own comment: *"'open' is the honest closest fit... but this is an EXPLICIT decision, not a value silently caught by the generic default."* A real, disclosed simplification, not a false-certainty gap. Contrast with `SPLIT` below. |
| `EscrowStatus.SPLIT` → `TradeState: dispute_opened` / `open` | Distinction exists and IS material (§6) | **Was not honestly collapsed** — reached via a generic fallback (`default:` or an unhandled dispute-ruling branch), not a named, deliberate decision; this was the negative case the mission's rule warns against. **Fixed 2026-09-13** (see §6 correction) — `deriveTradeState()` now returns a dedicated `dispute_resolved_split` value on both paths, no longer a fallback. |
| `funded` / `detected` / `completed` / `settled` / `failed` (mission's own listed terms) | Not uniform vocabulary in this codebase — `Escrow.status` values (`FUNDS_LOCKED`, `COMPLETED`) are the real backing states; "detected"/"settled"/"failed" as such do not exist as persisted values anywhere in this schema | No live collapse to audit — these terms appear only in the mission brief's own vocabulary and in the *analytical, not-implemented* funding-state model (§10), where they are kept intentionally distinct rather than aliased. |

**Rule applied:** product-state granularity must not exceed observable
runtime truth. `payment_sent`/`payment_confirmed` and `EXPIRED`→`open`
both correctly follow this rule (the code discloses exactly what it
cannot distinguish). `SPLIT`'s mapping violates the inverse of the
rule — the runtime *can* distinguish a state the product layer then
fails to preserve, which is a different and arguably worse defect than
under-distinguishing: it is not false certainty about something unknown,
it is a false statement about something the system already knows for
certain.

---

## 8. `FundingInstruction` Model (conceptual, not implemented — §8)

**Confirmed:** no `FundingInstruction` type, model, or table exists
anywhere in `src/` (verified by direct search, 2026-09-12) — this
section is entirely product-conceptual, per the mission's own
instruction, corresponding to the 📋-future `PaymentIntent` in
`PROTOCOL_SPECIFICATION.md` §2.3.

**Conceptual shape** (rail-agnostic product semantics, never a provider
UI):

```
FundingInstruction {
  asset, rail                      // e.g. BTC/MULTISIG, USDT_ERC20/WDK_USDT_EVM
  amount                            // decimal string, RFC-009
  instruction                       // on-chain address | Lightning/Ark invoice |
                                     // payment request | QR | external-wallet
                                     // action | provider-specific | fiat instruction
  expiry?                           // where the rail has one (invoices; not
                                     // addresses)
  confirmationExpectation           // e.g. "N confirmations" | "provider callback" |
                                     // "manual counterparty confirmation" (fiat)
  detectedState                     // see §10 — NOT_ATTEMPTED | ... | UNKNOWN
  completionState                   // see §10
  failureOrUnknownState             // see §10 — never silently coerced to failure
  retryGuidance                     // "safe to retry" | "check before retrying" |
                                     // "do not retry, contact support/arbiter"
  nextStep                          // the one action, if any, the actor should take
}
```

**Rail mapping today (real, per `EscrowType`):**

| Rail | Instruction shape today | Real backing |
|---|---|---|
| `MULTISIG` | On-chain BTC address (`Escrow.multisigAddr`), buyer/seller self-fund | Real, mainnet-proven (`docs/MAINNET_MULTISIG_PROOF.md`) |
| `LIGHTNING_HODL` | Ark/Arkade VTXO address, not a plain Lightning invoice (`docs/DATABASE.md`'s own 2026-09-10 correction) | Real, testnet-evidenced |
| `WDK_USDT_EVM` | Deterministic EVM sub-account address, server-custodial | Real, but `PRODUCTION-INELIGIBLE` (§10) |
| `SAFE_GUARD_EVM` | Predicted Safe/Guard CREATE2 address | Real, Sepolia-verified, never live-funded |
| Fiat leg (PIX/bank/etc.) | Free-text chat content (`Message.msgType`), no structured instruction object | Real but unstructured — the negotiation channel, not a `FundingInstruction`, carries this today |

No implementation is proposed by this section (§21 non-goals).

---

## 9. `FundingState` Model (conceptual for a general rail; real/analytical for `WDK_USDT_EVM` — §9)

**Target model (per the mission's own minimum list), classified against
current reality:**

| Target state | Current reality |
|---|---|
| instruction ready | Real — an escrow address/instruction is generated at escrow-creation time for every rail |
| awaiting user action | Real, implicit (UI copy, not a persisted state) |
| submitted externally | **Not persisted as its own state for any rail** — the closest real signal is a provider-specific tx id (`txLockId`), written only on full success |
| detection pending | Not persisted — no rail's provider integration polls or reports a "detected, not yet confirmed" state today |
| detected | Not persisted |
| confirming | Not persisted — `WdkSettlementProvider` in particular never checks a receipt at all (§10 below) |
| confirmed | For `MULTISIG`, real via reorg-sweep evidence (`multisig-funding-reorg-sweep.ts`, `escrowFundingEvidenceRepository`); for `WDK_USDT_EVM`, **not checked at all** (a returned tx hash is treated as final success — no receipt/confirmation wait, `docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` §7 window G) |
| expired | Real — `EscrowStatus.EXPIRED` (timelock-based, `FUNDS_LOCKED` only) |
| rejected | Real, coarse — any provider throw before `FUNDS_LOCKED` reverts to `CREATED` |
| cancelled | Real — `Trade.status: CANCELLED` |
| unknown external outcome | **Not represented in `Escrow.status` at all** — every provider failure, regardless of whether the external side effect actually occurred, is collapsed to the same revert-to-`CREATED` treatment (see §10, §20) |
| retry-safe | Real for pre-side-effect failures (config errors, gas-quote failures) — genuinely safe |
| retry-unsafe | **Real but unrepresented** — `docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` demonstrates (against real, unmocked Sails orchestration, simulated provider side effect) that a caught-and-reverted `WDK_USDT_EVM` `lockFunds()` failure can permit a second provider invocation for the same logical operation, with no distinction from a genuinely-safe retry |

**Verdict, restated from that document's own §18 (Claude's
recommendation, CTO decides disposition):** a genuine `UNKNOWN_OUTCOME`
class exists (distinct from `DEFINITELY_FAILED` and from a stuck
non-retryable state) for at least the `WDK_USDT_EVM` rail, and today's
`Escrow.status` model has no representation for it — every provider
failure is treated identically. This is not re-litigated or re-solved
here; it is the direct evidentiary basis for §19-§20 below.

---

## 10. `SigningRequest` / Authorization Model (conceptual — §10)

**Confirmed:** no `SigningRequest` type exists in this codebase. Real,
adjacent mechanisms map onto each of the mission's required
distinctions:

| Mission's category | Real backing today |
|---|---|
| Explicit human signature | `EscrowPendingTransaction`/`EscrowTransactionSignature` (real, `MULTISIG`/`LIGHTNING_HODL`/`SAFE_GUARD_EVM`) — each required signer submits an independently-signed copy of an unsigned PSBT/UserOp; the server never holds a single key able to unilaterally sign these three types |
| Delegated signature | **Not implemented, not authorized** — this is exactly `AGT-2` (Delegated-Authority Agent) from `docs/PRODUCT_INTERACTION_MODEL.md` §2, restated, not redefined here |
| Automatic execution under prior authority | Real, narrow, off by default: `config.features.autoSettleOnMatch` (`AUTO_SETTLE_ON_MATCH`, default `false`) triggers `executeSettlement()` from `openp2p.trade.created` with no synchronous human click — this is existing, scoped, disclosed automatic execution *under a deployment-level policy the human operator already configured*, not agent-invented authority. Distinct from `AGT-2`: no new actor gains discretion, an existing deployment flag does. |
| Batched approval | Real: RFC-015's two-person control (`EscrowReleaseApproval`, `REQUIRE_DUAL_APPROVAL_RELEASE`, default `false`) — both counterparties must independently record approval before a normal (non-disputed) release proceeds |
| External wallet approval | Real: the client-signature-collection flow above IS this — `MULTISIG`/`LIGHTNING_HODL`/`SAFE_GUARD_EVM` never hold a server-side key able to sign alone; buyer/seller sign with their own client-held keys via `@satsails/p2p-trading-sdk`'s `signEscrowPsbt()`/`signEscrowArkTx()`/`signEscrowSafeUserOp()` |

**Preserved, verified, not re-litigated:** *SigningRequest does not
create authority; authorization must already exist before execution.*
Concretely true today: RFC-015's approval rows record *intent to
approve*, not new authority (both parties already had authority over
their own trade, K1/K2); the client-signature-collection flow only
lets an already-entitled beneficiary exercise authority they already
had, via their own key, rather than a server-held one. Signing can be
silent in the UX (e.g. `MOCK`/`WDK_USDT_EVM`'s single synchronous
`releaseFunds()` call, no separate human "sign" step visible) but is
observable when material — real, shipped: `Trade.tsx`'s
`handleReleaseFunds()` and `useEscrowKey.ts`'s verify-then-sign flow for
the three client-signing rails make the signing step a visible,
distinct UI moment precisely where a real second key is required.

Not implemented here (§21 non-goals): no `SigningRequest` primitive,
no new authorization mechanism.

---

## 11. Interruption / Recovery Model (§11)

For each interruption class, what survives and what does not — audited
against real, persisted state, not assumed:

| Interruption | What is restored on return | What continues to be valid | What must not be repeated | What is "unknown" | Retry-safe? |
|---|---|---|---|---|---|
| App close/reopen, backgrounding | Full `Trade`/`Escrow`/`Dispute` state (all Postgres-durable) | Every read; any action gated only by current `status` | An action already durably completed (blocked by `assertEscrowTransition`) | Nothing — this class has no ambiguity, state is durable | Yes |
| Session expiry | Re-auth required; underlying trade state unaffected | Same as above once re-authenticated | N/A | Nothing | Yes |
| Network drop mid-request | Depends entirely on whether the server-side call completed before the drop (`docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` §7, window F) | A safe `GET` to re-check current status (`settlement.routes.ts`'s `GET /v1/settlement/escrow/:id`, real, non-mutating) | A mutating retry issued blindly, for `WDK_USDT_EVM`'s `lockFunds()` specifically (demonstrated unsafe, §9/§20) | Whether the mutating call landed | **No, not uniformly** — safe for read-only rails' verification-only `lockFunds()` (`MULTISIG`), not demonstrated safe for `WDK_USDT_EVM`'s custodial `lockFunds()` |
| Provider delay | Escrow remains at its pre-call status until the provider call resolves or throws | Waiting; a status check | A second mutating call while the first is genuinely still in flight (not caught by any lock beyond the atomic status claim, which only protects true concurrency) | Whether "delay" will resolve to success or failure | Depends on rail (see above) |
| Ambiguous external outcome | Nothing — `revertEscrowStatus()` is unconditional, reverting to the pre-claim status regardless of whether the external side effect occurred | A manual, external, human-driven chain query (correlation material only — `docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` §12) | A blind retry for `WDK_USDT_EVM` | Whether funds actually moved | No, for `WDK_USDT_EVM` (demonstrated) |
| Duplicate callback | No callback/webhook mechanism exists in this codebase for any settlement provider today (all providers are polled/awaited synchronously) — not applicable to current real code | — | — | — | N/A (real gap for any *future* callback-based provider, not evaluated here) |
| Retry (operator/client re-issuing a request) | Same as "ambiguous external outcome" row | A `CREATED`-status escrow is genuinely retryable | A `FUNDS_LOCKED`-status escrow's `lockFunds()` (blocked by `assertEscrowTransition`, real, tested) | Whether a prior reverted attempt's side effect already landed | Rail-dependent |
| Counterparty disappearance | Trade remains at its current status indefinitely — no automatic timeout forces `PAYMENT_PENDING`/`FUNDS_LOCKED` forward | Either party may still raise a dispute; `FUNDS_LOCKED`'s own `timelockHours` (default 24) governs `EXPIRED` eligibility for signature-collection types | Nothing — no automatic action fires | Whether the counterparty will return | N/A |
| Node switch / device change | `User.publicKey` (identity) is what everything is keyed to, not a device/session — a new device that re-authenticates as the same identity sees identical state | Everything | N/A (no per-device state exists to lose) | N/A | Yes |
| Recovery/migration | Out of this mission's scope (`docs/IDENTITY_ARCHITECTURE_DISCOVERY.md` — fully open, not touched here) | — | — | — | Not evaluated |
| Partial settlement (`SPLIT`) | Real Escrow/Dispute state; **the derived `TradeState` the user sees is wrong on return** (§6/§7) | The real settlement itself (funds already moved correctly) | N/A — this is a display gap, not a state-corruption gap | N/A — the runtime knows the outcome; the derivation layer discards it | N/A |
| Delayed confirmation | See `FundingState` (§9) — no `confirming` state exists to restore into; the escrow simply appears at its pre-confirmation status until/unless a later step observes success | Waiting | A second funding attempt | Whether the delayed transaction will confirm, revert, or never land | Rail-dependent |
| Dispute opened mid-flow | `Escrow.status: DISPUTED` is durable and freezes the escrow (`raiseDispute()`) | Evidence submission, arbiter assignment/ruling | The pre-dispute cooperative-release path (correctly blocked once `DISPUTED`) | The eventual ruling | N/A (not a retry question) |

**Principle applied:** journey continuity is product behavior. Every row
above is answered from real, persisted state or a real, demonstrated
gap — never from an assumption about what infrastructure "probably"
does.

---

## 12. Counterparty Experience Model (§12)

Conceptual component, grounded in real, existing signals — no private
data exposed, no reputation-as-identity confusion (`docs/PRODUCT_INTERACTION_MODEL.md`
§5's Privacy Matrix, reapplied, not redefined):

| Signal | Real backing | Visible to |
|---|---|---|
| Economic identity representation | `User.publicKey`/`displayName` — never raw key shown as "identity" in the User Surface sense (Product State ≠ Technical State, `PROJECT_CONTEXT.md` §2E item 6) | Counterparty (own trade), self |
| Reputation | `User.reputationScore` (RFC-007 D8: outcome-based only, `recordOutcome()` the sole input; `rate()` informational, never affects score) | Public signal (aggregate), self (detail) |
| Volume / trades | `User.totalTrades`, `totalVolumeBtc` | Public/counterparty (aggregate), self |
| Limits | `PaymentAccount`'s real trust ramp (`getTradeLimit()`: unsigned floor → signed → established → unlimited-at-zero-chargebacks) | Self; not counterparty-visible as a number, only as the offer limits it produces |
| Payment methods | `Offer.paymentMethod`, `PaymentAccount.paymentMethod` | Counterparty (for the specific trade) |
| Timing / reliability | Not a first-class persisted metric today — `completedTrades`/`chargebacks` on `PaymentAccount` are the closest real proxies | Self; not directly counterparty-visible as "reliability" |
| Dispute signal, where legitimate | `User.disputeCount` (aggregate count only — never per-dispute detail to a non-party) | Public/counterparty (aggregate only, per the Privacy Matrix's existing frozen boundary) |
| Previous interaction | Not a first-class query today (no "trade history with this specific counterparty" endpoint found) — a real, named gap, not fabricated as existing | — |
| Portable reputation, future direction | `PROTOCOL_SPECIFICATION.md` §1.1's Trust Graph growth stage (aspirational, not built) | — |

`ArbiterProfile.arbiterReputation` and `PaymentAccount`'s chargeback
history are deliberately **separate** risk dimensions from
`User.reputationScore` (real, distinct fields, per `docs/DATABASE.md`'s
own documented reasoning) — a trader's general reputation, a specific
payment rail's chargeback history, and an arbiter's professional ruling
record are three different signals about (possibly) the same person,
never collapsed into one number.

**Binance P2P benchmark, applied conceptually (§13):** the familiar
interaction shape (browse offers ranked by price/reputation, see
payment methods and limits before committing, open a trade into a
structured room with a clear status stepper, message the counterparty,
mark payment sent, release/dispute) already exists in this codebase's
UI (`Marketplace.tsx`'s filter/sort, `FilterPanel.tsx`'s payment-method
categorization, `Trade.tsx`'s trade room, `StatusBadges.tsx`'s status
stepper, `Disputes.tsx`) — this mission does not propose adopting any
centralized assumption Binance's own architecture makes (no order book
matching engine, no custodial balance, no platform-operator visibility
tier — the last explicitly and permanently rejected per this project's
own standing "no platform-operator visibility" rule). The benchmark is
cited here as confirmation that the *already-built* interaction shape
is the right one to keep refining, not as a new design direction.

---

## 13. Dispute Journey Model (§17)

```
raiseDispute()                          — Escrow.status: * → DISPUTED (freeze)
  ↓ Dispute.status: OPENED
Evidence submission                     — submitEvidence(), Claim/Proof/Verification (RFC-003/006/007)
  ↓ Dispute.status: EVIDENCE_SUBMITTED
Arbiter assignment                      — ArbitrationProvider.assign() (TRUSTED_ARBITRATORS or ARBITRATION_MODE=market)
  ↓ Dispute.status: ARBITRATED  (or AUTO_PROPOSED — RFC-021 D8, QVAC-assisted, off by default)
Ruling                                   — resolveDispute(ruling: RELEASE | REFUND | SPLIT)
  ↓ Dispute.status: RESOLVED
    ├── RELEASE  → Escrow.status: COMPLETED   (buyer receives full amount)
    ├── REFUND   → Escrow.status: REFUNDED    (seller receives full amount)
    └── SPLIT    → Escrow.status: SPLIT       (both receive a share — §6's gap)
Appeal (optional, RFC-021 D6)            — Dispute.status: RESOLVED → APPEALED → RESOLVED (new arbiter)
```

**Authority, restated (not redefined):** the arbiter has Economic
Disposition Authority only (who is entitled, how much) — never
Destination Authority (§16). `TRUSTED_ARBITRATORS`/`ARBITRATION_MODE`
scope who may rule; `applyRuling()`'s real implementation (verified
2026-09-12, `dispute.service.ts`) resolves every beneficiary's payout
address from their own registered `PayoutAddress`, passing `undefined`
for every destination parameter regardless of ruling type — the M8-R2
fix (`docs/DESTINATION_AUTHORITY_ARCHITECTURE.md`) is genuinely applied
in this code path today.

**"Disputed" is not one sufficient state**, confirmed: `DisputeStatus`
has six real values plus `Escrow.status: DISPUTED` as a separate,
coarser freeze signal — a user-facing "Em disputa" badge (`TradeStatusBadge`)
correctly exists at the coarse level, while `Disputes.tsx` itself
surfaces the finer `DisputeStatus`/`ruling` detail to the arbiter and
trade parties.

**User-facing status for unknown/intermediate states:** `AUTO_PROPOSED`
(RFC-021 D8, QVAC-assisted first-pass ruling, contestable) is the one
real intermediate state with no dedicated `TradeState` mapping — it
currently falls under the same `dispute_opened` bucket as `OPENED`/
`EVIDENCE_SUBMITTED`/`ARBITRATED`, which is honest (it genuinely is
still open, pending contest or expiry) but does not surface that an
automated recommendation already exists. Named, not fixed (classification
F — a real, not-yet-surfaced capability, not an overclaim).

**Resolution / split / refund / partial outcome:** covered above; the
`SPLIT` outcome's own UX representation gap is the finding registered in
§6, not re-derived here.

---

## 14. Happy Path & 15. Interrupted Path (§18)

### Happy Path

```
Discovery (browse/filter Offers)
  → Offer Evaluation (price/limits/payment method/counterparty signal)
  → Economic Commitment (Trade created, §2)
  → Chat / Agreement Confirmed
  → Escrow created + funded (rail-specific FundingInstruction, §8)
  → Buyer marks payment sent (PAYMENT_PENDING)
  → Seller confirms receipt → releaseFunds() (direct or signature-collection, §10)
  → Escrow COMPLETED, Trade COMPLETED, Reputation updated (POSITIVE)
```

Every step above is Real/Evidenced for at least `MULTISIG` (mainnet-proven)
and `MOCK` (fully exercised in tests); `WDK_USDT_EVM`/`SAFE_GUARD_EVM`
follow the identical orchestration path with rail-specific caveats
(§9, §10).

### Interrupted Path (per macro-stage)

| Macro-stage | Interruption | What breaks | What survives |
|---|---|---|---|
| Discovery | Network drop | Nothing economic — pure read | Filter/sort state (client-local only) |
| Economic Commitment | App close right after Trade creation | Nothing — `Trade` row is durable | Full resumability |
| Payment/Funding | Provider call ambiguous outcome (`WDK_USDT_EVM`) | Retry-safety (§9/§20) | Escrow row itself; correlation material only |
| Authorization/Signing | One required signer goes offline mid-collection | The other signers' already-submitted signatures remain persisted (`EscrowTransactionSignature`, real) | Nothing is lost; the round simply waits |
| Settlement | Timelock expires before cooperative resolution | Cooperative path (blocked); | `EXPIRED` state, seller's expiry-recovery path (real, `initiateExpiryRecovery()`) |
| Dispute | Arbiter delay | Nothing structural | Evidence, assignment, all durable; no auto-timeout forces a ruling |

No flow above is considered complete on the strength of its happy path
alone, per the mission's own §18 instruction — every macro-stage's
interrupted-path row is a real, evidenced answer, not "not applicable."

---

## 16. Same State / Different Actor (§14, using the frozen USR/AGT/OPS/INT notation)

| Economic truth | USR | AGT-1 (Assistive Agent) | OPS-1 (Node) | OPS-2 (Arbiter) | INT |
|---|---|---|---|---|---|
| Settlement delayed, not failed (provider call pending/ambiguous) | "Aguardando confirmação" / "Aguardando liquidação" | wait / recheck only if authorized; never retry a mutating call on its own initiative | rail/provider/timestamps/evidence status (own node only) | N/A unless escalated to dispute | canonical `TradeState` + explicit retry guidance (never "just retry") |
| `EscrowStatus.SPLIT` reached | Should see "Recebeu parte do valor" (target — not built, §6) | Reads the real `Escrow.status`/`Dispute.ruling`; never fabricates a winner (mirrors `deriveTradeState()`'s own honest refusal to guess) | N/A (not its own node's diagnostic) | Confirms its own ruling executed | Needs the real terminal state, not a value indistinguishable from "still negotiating" |
| `EscrowStatus.EXPIRED` reached | "Expirado" (real, shipped, distinct orange) | N/A | Diagnostic: which rail, which escrow, timelock config | If escalated: real dispute, own scope | Real state, real badge — no gap here |
| `WDK_USDT_EVM` `lockFunds()` unknown outcome | Should never see "failed" when the real state is unknown (target — today it does, §20) | Must not retry on its own initiative — no automated retry is wired today, correctly | Full failure-window classification (§9's table) | N/A | Needs the real `UNKNOWN_OUTCOME` distinction, not a generic error |

---

## 17. Privacy-by-Stage Matrix (§15)

Reapplies, does not redefine, `docs/PRODUCT_INTERACTION_MODEL.md` §5's
already-frozen Privacy Matrix, keyed to journey stage instead of
information type:

| Stage | Public | Counterparty | Participant-only | OPS-2 (Arbiter) | OPS-1 (Node) | AGT | INT |
|---|---|---|---|---|---|---|---|
| Discovery/Offer Evaluation | Offer terms, aggregate reputation | — | — | — | — | as needed for matching (own mandate only) | integration-relevant aggregate |
| Economic Commitment | — | Trade terms (shared) | — | — | — | current state + allowed actions | own integration's own users only |
| Payment/Funding | — | Payment method (what the trade requires) | Full payment account detail (`PaymentAccount`, never raw identifier — only `accountHash`) | If disputed, that dispute only | Own node's operational diagnostics | ○ | canonical state |
| Authorization/Signing | — | — | Own signature/key material | Assigned dispute's evidence only | Own node's signing/broadcast diagnostics | ○ | ○ |
| Settlement | — | Shared trade state | Payout/destination address (own) | Disputed case only | Own node's handled trades (operational) | current state only | its own integration's users |
| Dispute | — | Own dispute, other side | Full evidence (own dispute) | Assigned dispute only | ○ | ○ | ○ |

**Rule confirmed, not weakened:** privacy survives simplification — no
stage's user-facing copy exposes a payout address, payment destination,
or dispute evidence beyond what `docs/PRODUCT_INTERACTION_MODEL.md` §5
already froze.

---

## 18. Payment Destination (§16)

**Preserved distinction, verified against real code (not asserted from
memory):**

| Concept | Real backing | Model |
|---|---|---|
| Payment method | `Offer.paymentMethod`, `PaymentMethod` enum (PIX/TED/BANK_TRANSFER/...) | The *category* of fiat rail |
| Payment destination (fiat) | Exchanged as free-text chat content today (§2.1's gap); `PaymentAccount.accountHash` is the real, hashed, trust-ramped model for a *registered* account, not yet bound per-trade | Not yet structurally bound to a specific `Trade` |
| Payout destination (crypto, cooperative) | `PayoutAddress` (real, one row per participant+asset), resolved via `escrow.service.ts`'s `resolvePayoutAddress()` | Real, participant-registered, snapshotted at release |
| Funding destination | The escrow's own deterministically-derived address (`escrowIndexFor(tradeId)`, `Escrow.multisigAddr`) | Real, provider-specific |
| Settlement destination (post-dispute) | Same `PayoutAddress` mechanism, now Core-authoritative for arbitrated rulings (`applyRuling()`, verified 2026-09-12 — every destination parameter passed as `undefined`, the beneficiary's own registered address always resolved instead) | Real, fixed by the M8-R2 remediation described in `docs/DESTINATION_AUTHORITY_ARCHITECTURE.md` |

**F1 revalidated, not re-litigated:** *Economic Disposition Authority ≠
Destination Authority ≠ Execution Authority* — confirmed still true and,
as of the M8-R2 fix (2026-09-11), **actually enforced** in the real
dispute-resolution code path: an arbiter's `AuthorityDecisionPayload`
carries only `ruling`/`buyerBps`, never a destination; `applyRuling()`'s
real body (verified line-by-line) resolves every beneficiary's payout
independently from their own `PayoutAddress`.

**Residual, disclosed gap found during this mission's own verification
(classification H — stale internal comment, not a live vulnerability):**
`escrow.service.ts`'s own `releaseFunds()` doc comment (line ~613)
still describes `dispute.service.ts`'s `applyRuling()` as passing "the
arbiter's own `releaseToAddress`... a disclosed residual gap, not fixed
by M8-R2" — **this is stale**; `applyRuling()`'s real, current body
(verified 2026-09-12) passes `undefined` for every destination
parameter across `RELEASE`/`REFUND`/`SPLIT` and every rail it handles.
Separately, `settlement.routes.ts`'s public `resolveDispute()` HTTP
schema still *accepts* `releaseToAddress`/`refundToAddress` as optional
body fields (kept for API-stability, per that method's own comment
about avoiding "a large mechanical rename") even though the
Core-authoritative internal path now ignores them entirely — a minor
API-surface honesty gap (a caller can still supply a value that is
silently discarded, which could confuse an integrator, but grants no
actual destination authority) rather than the security gap the
architecture document originally identified. Neither correction is made
here (out of this document's own edit list) — both are registered as
Documentation deltas (§26).

**Is anything in the current UI mixing these concepts?** No —
`Disputes.tsx`'s own removal of its former destination-supplying map
(cited directly in its own header comment, dated 2026-09-11, citing
`docs/DESTINATION_AUTHORITY_ARCHITECTURE.md`) confirms the UI side was
already corrected in step with the backend fix.

---

## 19. Retry Safety Model (§19) & 20. Unknown Outcome Model (§20)

Both models are the direct, restated conclusion of
`docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` — not re-derived, not
extended to other providers without evidence (that document's own
`MULTISIG` contrast — a read-only verification, not a funding action —
is preserved, not generalized).

**Retry Safety, by class:**

| Failure class | Retry-safe? | Evidence |
|---|---|---|
| Pre-side-effect failure (config error, gas-quote failure) | **Yes** | Demonstrated, real orchestration (`docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` §11 Test 3) |
| Post-side-effect-unknown, caught and reverted | **No** | Demonstrated, real orchestration / simulated side effect (§11 Tests 1-2) — a second provider invocation for the same logical operation is permitted |
| Escrow durably stuck at `FUNDS_LOCKED` with no lock evidence | Not retryable via the normal route (correctly blocked) | Demonstrated (§11 Test 4) — but the stuck state itself is not reconciled automatically |
| Concurrent duplicate requests (true concurrency) | **Yes**, pre-existing, unrelated to this mission | `claimEscrowTransition`'s atomic claim |

**Unknown Outcome, target vs. current:**

| Target class | Current representation |
|---|---|
| `DEFINITELY_FAILED` | Real — pre-side-effect failures correctly revert and are safe to retry |
| `UNKNOWN_OUTCOME` | **Does not exist** — collapsed into the same revert-to-`CREATED` treatment as `DEFINITELY_FAILED` |
| Stuck / non-retryable | Real as a *symptom* (`FUNDS_LOCKED` with no evidence blocks further `lockFunds()` calls) but not recognized or reconciled as its own state |
| `CONFIRMED_SUCCESS` / `CONFIRMED_REVERT` | **Neither is checked** — `WdkSettlementProvider` never inspects a transaction receipt; a returned hash is treated as final success unconditionally (window G) |

**Principle reconfirmed:** *unknown outcome ≠ failed outcome.* Today's
real code violates this principle for exactly one provider
(`WDK_USDT_EVM`), for exactly the reason that document already
demonstrated — `revertEscrowStatus()` is unconditional and treats every
failure identically regardless of whether an external side effect
occurred. `WDK_USDT_EVM` is `PRODUCTION-INELIGIBLE` today (boot-enforced,
`src/config/index.ts`), which contains the operational blast radius of
this gap without closing the underlying property. **No mechanism is
chosen or authorized here** — the same posture that document's own §19
already took, reapplied rather than re-litigated.

---

## 21. Classification of Findings (A–J)

| Finding | Classification |
|---|---|
| `PROTOCOL_SPECIFICATION.md` §1.11's Offer/Trade/Intent disconnect is now stale (RFC-018 substantially implemented) | **H** — legitimate implementation detail, documentation not yet updated |
| `DATABASE.md`'s `EscrowType`/`EscrowStatus` enum + transition diagram missing `SAFE_GUARD_EVM`/`EXPIRED`/`DISPUTED→SPLIT` | **H** — stale doc, not a runtime gap |
| `EscrowStatus.SPLIT` absent from `sails-ui`'s type mirror and `StatusBadges.tsx` | **A** — Product truth omitted |
| `deriveTradeState()`'s mishandling of `SPLIT` (two distinct wrong mappings) | **A** — Product truth omitted (compounds the above) |
| `EscrowStatus.EXPIRED` → `TradeState: open` | **H** — legitimate, explicit, disclosed implementation detail (not a gap) |
| `payment_sent`/`payment_confirmed` alias | **G** — legitimate deferral, already correctly disclosed |
| No structured `FundingInstruction`/payment-destination binding per trade | **A** — Product truth omitted (real gap, not yet named as a product state) |
| `WDK_USDT_EVM` unknown-outcome/retry-safety gap | **J** — Architecture Decision required (already so classified by its own source document; restated, not re-decided) |
| Stale `escrow.service.ts` comment claiming M8-R2 destination fix is incomplete | **H** — legitimate implementation detail, comment drift |
| Public `resolveDispute()` API still accepting now-ignored destination params | **F** — maturity/API-honesty nuance, not a live vulnerability |
| No "trade history with this specific counterparty" surface | **A** — Product truth omitted |
| `AUTO_PROPOSED` dispute state has no dedicated `TradeState` distinction from other open states | **F** — hidden capability, not surfaced |
| Fee/policy-version freeze mechanism real but never economically live (`protocolFeeRate` always `0`) | **G** — legitimate deferral |
| Arbitration policy not bound per-trade at commitment time | **G** — legitimate deferral |
| Offer revision/envelope not separately snapshotted from the live `Offer` at acceptance time | **A** — Product truth omitted |

No finding above was auto-corrected, per the mission's explicit §19/§21
instruction.

---

## 22. Current Reality vs. Product Direction (summary)

The canonical journey (§1) is **substantially real** end to end for at
least one fully-evidenced rail (`MULTISIG`, mainnet-proven) and for
`MOCK` (fully test-covered). The **Economic Commitment Boundary is real
and legible** (Trade creation, §2), though the exact accepted-Offer
snapshot is not separately preserved. The **largest, most material gap
found by this mission is the `SPLIT` outcome's disappearance** across
three independent layers (type mirror, badge map, derived `TradeState`)
— a real economic outcome the runtime already knows with certainty,
silently misrepresented at the product layer. The **second-largest is
the `WDK_USDT_EVM` unknown-outcome/retry-safety gap**, already fully
diagnosed and correctly contained (boot-refused in production) by prior
work, restated here as the concrete grounding for this mission's
Retry-Safety/Unknown-Outcome sections. **Payment Destination is
correctly modeled and, as of a very recent (2026-09-11) fix, correctly
enforced** in the real dispute-resolution path — better than this
mission initially expected to find, given the architecture document's
own framing as "not yet authorized for implementation."

---

## 23. Product Decision Candidates

- Whether/how `EscrowStatus.SPLIT` gets a dedicated, non-misleading
  `TradeState`/UI representation (a new value, e.g.
  `dispute_resolved_split`, vs. an explicit "partial" qualifier on an
  existing state) — not decided, only named as needing one (§6).
- Whether a structured, per-trade payment-destination commitment
  (binding a specific `PaymentAccount` to a `Trade`) should be built —
  not decided, only named (§2.1, §16).
- Whether the accepted-Offer revision/envelope needs its own snapshot,
  independent of the live, mutable `Offer` row (§2.1).
- Whether `AUTO_PROPOSED` deserves its own `TradeState` distinction from
  ordinary open disputes (§13).

## 24. Architecture Decision Candidates

- The `WDK_USDT_EVM` unknown-outcome/retry-safety mechanism itself
  (persisted pre-broadcast intent, an explicit `UNKNOWN` intermediate
  status, a receipt/confirmation check, or an equivalent) — already
  named as a **J** classification by its own source document; restated,
  not re-decided here (§20).
- Whether the public `resolveDispute()` API/route signature should
  formally drop `releaseToAddress`/`refundToAddress` now that the
  Core-authoritative path ignores them (a scoped, low-risk cleanup, not
  a security fix) — named, not decided (§18).

## 25. Backlog Deltas

Registered in `docs/BACKLOG.md` (pointer only, not duplicated):
1. `EscrowStatus.SPLIT` missing from `sails-ui`'s type/badge mirror and
   mishandled by `deriveTradeState()` (§6/§7) — the highest-priority
   finding of this mission.
2. No structured, per-trade payment-destination/`FundingInstruction`
   binding exists yet (§8, §16).
3. `docs/DATABASE.md`'s `EscrowType`/`EscrowStatus` sections need a
   refresh pass (`SAFE_GUARD_EVM`, `EXPIRED`, `DISPUTED→SPLIT`) (§3).
4. `docs/PROTOCOL_SPECIFICATION.md` §1.11's Offer/Intent/Trade
   disconnect finding needs a refresh pass reflecting RFC-018's real
   implementation (§1.1).
5. `escrow.service.ts`'s stale `releaseFunds()` comment about M8-R2
   needs a one-line correction (§18).
6. No "trade history with this specific counterparty" surface exists
   (§12).

## 26. Documentation Deltas

- **New:** this document, `docs/P2P_PRODUCT_JOURNEY.md`.
- **`docs/PROJECT_CONTEXT.md`:** one short cross-link (§2H, below) — no
  existing frozen content altered.
- **`docs/BACKLOG.md`:** one new item registering §25's deltas — no
  existing item closed or altered in meaning.
- **Not touched, correction noted but not applied (out of this
  document's own edit list, §22 of the mission brief):**
  `docs/DATABASE.md`, `docs/PROTOCOL_SPECIFICATION.md`,
  `src/modules/open-settlement/escrow.service.ts`'s comment. Each is
  named precisely enough (file, and where applicable line) for a future
  Tier-1/Tier-2 pass to apply without re-deriving this mission's own
  research.

## 27. Maturity Impact

No maturity classification is upgraded or downgraded by this document.
`WDK_USDT_EVM` remains `PRODUCTION-INELIGIBLE` (unchanged, restated).
`MULTISIG` remains the most mainnet-evidenced rail (unchanged,
restated). This mission's own contribution is entirely at the
product/UX-journey layer — it names gaps in how already-real runtime
truth is (or is not) surfaced, and does not change any provider's own
production-readiness classification.

## 28. Recommended Impact on Mission 3 (Wallet Partner Journey)

Not started, per the mission's own explicit "STOP. DO NOT START WALLET
PARTNER JOURNEY" instruction. For whenever it is authorized: the
Integrator Surface (`INT`, `docs/PRODUCT_INTERACTION_MODEL.md` §4) and
the Wallet vs. Service/Backend Integrator split (§7 of that document)
are the direct starting point — this mission's `FundingInstruction`/
`FundingState`/`SigningRequest` conceptual models (§8-§10 above) are
written rail-agnostically specifically so a Wallet Partner Journey
mission can reuse them rather than re-deriving a parallel vocabulary.
The `SPLIT` and unknown-outcome findings (§6, §19-§20) are directly
relevant to any Wallet Partner's own settlement-status reconciliation
and should be surfaced to that mission rather than re-discovered.

---

## Closing confirmations

No protocol, SDK, Core, or Semantic Kernel change. No Settlement
architecture change. No cryptographic economic commitment implemented.
No new authority role, delegated agent authority, provider, Private
Markets, or Node discovery implemented. No UI refactor for aesthetics.
No state invented without backing runtime truth. No gap auto-corrected.
This document is Product/UX Journey institutionalization only, built
from real, directly-verified 2026-09-12 source-code evidence plus
already-frozen institutional sources — not from documentation or UI
assumptions alone, per the mission's own explicit audit-runtime-first
instruction.
