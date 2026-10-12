# DATABASE.md
### Sails Protocol — Reference Runtime Persistence Model

> **Authority / status:** detailed persistence reference for the TypeScript Reference Implementation. `prisma/schema.prisma` is the implementation source of truth for current models/enums. PostgreSQL/Prisma are reference-runtime choices, not protocol requirements.

---

## 1. The `moduleId` / `protocolVersion` Pattern (read this before touching the schema)

Every entity that belongs to a specific protocol module carries two fields:

```prisma
moduleId        String  @default("openp2p")     // which module owns this row
protocolVersion String  @default("0.1")          // which spec version created it
```

**Why:** without `moduleId`, when Sails OpenFinance ships in the future and
needs its own trades/offers/escrows, you'd either need new tables (duplicate
schema) or ambiguous shared tables. With `moduleId`, `OpenFinance` rows and
`OpenP2P` rows can coexist in the same `trades` table, cleanly distinguished
by a `WHERE moduleId = 'openfinance'` filter.

`protocolVersion` exists so that, as the Sails Protocol Spec evolves (e.g.
`0.1` → `0.2` changes the shape of an event payload), you can tell which
version's rules applied when a given row was created — critical for
long-lived data and for debugging disputes.

**Rule:** any new entity you add to this schema must include both fields, set
to the correct module's canonical name (see the module list in
`ARCHITECTURE.md` section 3) and the current spec version.

---

## 2. Enums

```prisma
enum AssetType {
  BTC
  USDT_ERC20
  USDT_TRC20
  USDT_LIQUID
  USDT_LIGHTNING
  LN_BTC
  LIQUID_BTC
  SPARK
  STACKS
  RSK_BTC
}
```

**Consciously unsupported for real escrow, 2026-08-01 (multisig-coverage-per-asset
audit)** — a real product decision, not an oversight: of the 10 values above,
only `BTC` (`MULTISIG`) and `LN_BTC` (`LIGHTNING_HODL`) have a genuinely
non-custodial provider today; `USDT_ERC20` has real on-chain execution but
single-seed custody (`WDK_USDT_EVM`). `USDT_TRC20`, `USDT_LIQUID`,
`USDT_LIGHTNING`, `LIQUID_BTC`, `SPARK`, `STACKS`, `RSK_BTC` have no real
`SettlementProvider` wired at all — `recommendedEscrowType()`
(`escrow.service.ts`) throws a clear error for any of them rather than
guessing or silently falling back to `MOCK`. Deliberately left in the enum
(not removed) — the values themselves are real and correct, only escrow
custody for them is unbuilt. Revisit when a real provider exists for one
of them (`LIQUID_COVENANT` below is the natural candidate for
`LIQUID_BTC`/`USDT_LIQUID` specifically).

**Correction (2026-09-10, Product Truth Sweep, F6/F7).** `LN_BTC`'s
provider, `LIGHTNING_HODL`, settles via the Ark/Arkade protocol
(VTXO/Taproot, Mutinynet), not plain Lightning HTLCs — its own header
comment discloses plain Lightning has no genuine multi-party escrow
primitive, which is why it uses Ark instead. Stated precisely: **Arkade**
is IMPLEMENTED/TESTNET-EVIDENCED; **Lightning**, as its own distinct
product capability, is NOT IMPLEMENTED/NOT EVIDENCED — no genuine
Lightning-specific settlement path exists in this repository (see
`docs/BACKLOG.md` item 20). This does not change the 2026-08-01 decision
above, which remains valid engineering-prioritization scoped to this
repository's own P2P-escrow rail — it is not a Product Direction
exclusion of Liquid; Liquid is Day-0-required for the Reference Wallet
via non-Sails-Protocol infra already in production
(`docs/REFERENCE_IMPLEMENTATIONS.md`).

```prisma
enum TradeSide {
  BUY
  SELL
}

enum OfferStatus {
  ACTIVE
  PAUSED
  COMPLETED
  CANCELLED
}

enum TradeStatus {
  PENDING
  ACTIVE
  COMPLETED
  DISPUTED
  CANCELLED
}

enum EscrowType {
  MULTISIG
  LIGHTNING_HODL
  LIQUID_COVENANT  // reserved, zero implementation since this value was first added — a real product decision (2026-08-01 multisig-coverage-per-asset audit), not an oversight. No LiquidCovenantProvider exists; getProvider() (escrow.service.ts) refuses to silently fall back to MOCK for it, same as any other unregistered real type. Natural candidate for LIQUID_BTC/USDT_LIQUID once someone builds it — not currently planned or scheduled.
  WDK_USDT_EVM  // real @tetherto/wdk-wallet-evm USDT (ERC-20) settlement — see wdk-settlement.provider.ts. Missing here until a 2026-07-19 consolidation audit caught this file drifting from the real schema.
  MOCK
}

enum EscrowStatus {
  CREATED
  FUNDS_LOCKED
  PAYMENT_PENDING
  COMPLETED
  DISPUTED
  REFUNDED
  SPLIT  // RFC-021 D9 (2026-08-02) — only reachable from DISPUTED; a real settlement action now exists for MOCK/WDK_USDT_EVM/MULTISIG (see that RFC's own D9 section for why SAFE_GUARD_EVM/LIGHTNING_HODL can't support it)
}
```

**`PENDING_BANK_SETTLEMENT` (RFC-007 D3) is designed, not implemented.**
A 2026-07-19 consolidation audit found this file — along with
`PROTOCOL_SPECIFICATION.md`, `API_REFERENCE.md`, and `SDK_GUIDE.md` —
documenting `PENDING_BANK_SETTLEMENT` as a real `EscrowStatus` value,
attributed to RFC-007 D3. It is not: the actual `prisma/schema.prisma`
enum (above, corrected) never gained this value — the RFC decided it,
nothing ever migrated it in. The only place it survives in real code is
a stale comment in `packages/sails-sdk/src/modules/settlement.ts:48`.
Whoever picks up RFC-007 D3 for real needs a migration adding this enum
value plus the `PAYMENT_PENDING → PENDING_BANK_SETTLEMENT → COMPLETED`/
`DISPUTED` transition edges — not just a doc update.

```prisma

enum PaymentMethod {
  PIX
  TED
  BANK_TRANSFER
  CRYPTO_DIRECT
  LIGHTNING_DIRECT
  CASH
  OTHER
}
```

Note: `TradeStatus` and `EscrowStatus` are intentionally separate enums —
Trade is a coarser-grained lifecycle owned by OpenP2P, Escrow is the more
granular state machine owned by OpenSettlement. See
`PROTOCOL_SPECIFICATION.md` for how the 9-state canonical Trade Lifecycle
maps onto these two enums plus the Intent Engine's own lifecycle states.

---

## 3. Models

### `User` — owned by `openidentity`

```prisma
model User {
  id              String   @id @default(uuid())
  publicKey       String   @unique              // Ed25519, the sovereign identity
  displayName     String?
  peerId          String?  @unique              // HyperDHT peer id, set once P2P node starts
  reputationScore Float    @default(0)
  totalTrades     Int      @default(0)
  disputeCount    Int      @default(0)
  totalVolumeBtc  Decimal  @default(0) @db.Decimal(24, 8)  // RFC-009 — was Float
  verified        Boolean  @default(false)
  moduleId        String   @default("openidentity")
  protocolVersion String   @default("0.1")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  offers             Offer[]
  buyerTrades        Trade[]           @relation("BuyerTrades")
  sellerTrades       Trade[]           @relation("SellerTrades")
  sentMessages       Message[]
  reputationGiven    ReputationEvent[] @relation("RaterEvents")
  reputationReceived ReputationEvent[] @relation("RatedEvents")

  @@map("users")
}
```

**Important:** `reputationScore`, `totalTrades`, `disputeCount`, and
`totalVolumeBtc` are written by the OpenReputation module's event handlers
(reacting to `settlement.escrow.released` and `openp2p.trade.disputed`), not
by OpenSettlement or OpenP2P directly. See `handlers.ts` in
`ARCHITECTURE.md` section 5 for the exact reactive flow. This was a real
coupling bug found and fixed during code review — do not reintroduce direct
writes to these fields from other modules.

### `Offer` — owned by `openliquidity` (NOT `openp2p` — this is deliberate)

```prisma
model Offer {
  id              String        @id @default(uuid())
  userId          String
  user            User          @relation(fields: [userId], references: [id])
  asset           AssetType
  side            TradeSide
  priceUsd        Decimal       @db.Decimal(24, 8)  // RFC-009 — was Float
  priceBrl        Decimal?      @db.Decimal(24, 8)  // RFC-009 — was Float?
  minAmount       Decimal       @db.Decimal(24, 8)  // RFC-009 — was Float
  maxAmount       Decimal       @db.Decimal(24, 8)  // RFC-009 — was Float
  paymentMethod   PaymentMethod
  paymentDetails  String?
  status          OfferStatus   @default(ACTIVE)
  network         String?
  description     String?
  moduleId        String        @default("openliquidity")
  protocolVersion String        @default("0.1")
  intentType      String?                          // e.g. "TradeIntent"
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt

  trades Trade[]

  @@index([asset, side, status])
  @@index([userId])
  @@map("offers")
}
```

### `Trade` — owned by `openp2p`

```prisma
model Trade {
  id              String      @id @default(uuid())
  offerId         String
  offer           Offer       @relation(fields: [offerId], references: [id])
  buyerId         String
  buyer           User        @relation("BuyerTrades", fields: [buyerId], references: [id])
  sellerId        String
  seller          User        @relation("SellerTrades", fields: [sellerId], references: [id])
  asset           AssetType
  amount          Decimal     @db.Decimal(24, 8)  // RFC-009 — was Float
  priceUsd        Decimal     @db.Decimal(24, 8)  // RFC-009 — was Float
  totalUsd        Decimal     @db.Decimal(24, 8)  // RFC-009 — was Float
  status          TradeStatus @default(PENDING)
  escrowId        String?     @unique
  escrow          Escrow?
  network         String?
  moduleId        String      @default("openp2p")
  protocolVersion String      @default("0.1")
  intentType      String      @default("TradeIntent")
  completedAt     DateTime?
  cancelledAt     DateTime?
  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt

  messages         Message[]
  reputationEvents ReputationEvent[]

  @@index([buyerId])
  @@index([sellerId])
  @@index([status])
  @@map("trades")
}
```

### `Escrow` — owned by `opensettlement`

```prisma
model Escrow {
  id              String       @id @default(uuid())
  tradeId         String       @unique
  trade           Trade        @relation(fields: [tradeId], references: [id])
  type            EscrowType   @default(MOCK)
  status          EscrowStatus @default(CREATED)
  lockedAmount    Decimal      @db.Decimal(24, 8)  // RFC-009 — was Float
  asset           AssetType
  network         String?
  multisigAddr    String?
  redeemScript    String?
  txLockId        String?
  txReleaseId     String?
  timelockHours   Int          @default(24)
  // RFC-021 Phase 0 — real fee collection (PROTOCOL_ECONOMY.md §6.2).
  // Nullable, not defaulted to 0: null means "no fee was computed for
  // this escrow" (protocolFeeRate was 0 at release time, or this escrow
  // predates Phase 0), vs. 0 meaning "a fee was computed and it rounded
  // to zero" — worth telling apart later. Only ever set on release
  // (PROTOCOL_ECONOMY.md §3: the Protocol Fee only ever attaches to a
  // completed Settlement) — never on refund.
  feeCharged      Decimal?     @db.Decimal(24, 8)
  moduleId        String       @default("opensettlement")
  protocolVersion String       @default("0.1")
  lockedAt        DateTime?
  expiresAt       DateTime?
  releasedAt      DateTime?
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt

  events EscrowEvent[]

  @@map("escrows")
}
```

**Corrected 2026-08-02** (the same `docs/BACKLOG.md` gap-consolidation
item that also flagged `FeeDistribution` missing entirely, closed below,
and `ArbiterProfile`/`PaymentAccount`, closed further down this file):
`feeCharged` above was missing from this listing since Phase 0 shipped —
now matches `prisma/schema.prisma` exactly.

**`status` — audited for a DB-native transition-graph trigger, deliberately NOT added (Missão 11 Fase 9.1 §12, 2026-08-24).**
This model's own `EscrowStatus` transitions are already gated in-app by
`escrow-lifecycle.ts`'s `VALID_TRANSITIONS` map plus an atomic
compare-and-swap (`claimTransition()`: `UPDATE ... WHERE id=? AND
status=<expectedFrom> SET status=<to>`) — the same "Postgres itself is
the arbiter of the race" pattern this repo uses everywhere a concurrent
double-claim must be prevented. This audit considered mirroring that
same graph as a DB-native `BEFORE UPDATE` trigger (the same real pattern
already used for `escrow_participant_keys`' arbiter-immutability guard
and `fee_distributions`' write-freeze guard, both in this same file) —
**and found it is NOT safe to add as a strict forward-only graph
check.** `escrow-lifecycle.ts`'s `revertEscrowStatus()` is a real,
currently-shipped compensating write (5 call sites across
`escrow.service.ts`/`escrow-pending-tx.ts`) that intentionally moves
`status` *backward* — e.g. `FUNDS_LOCKED → CREATED` — to undo a claimed
transition when the real provider call that was supposed to follow it
then fails (a stuck escrow otherwise permanently blocks every future
attempt via `assertEscrowTransition`). A trigger enforcing only
`VALID_TRANSITIONS`'s forward edges would reject every one of those
legitimate reverts. Widening the trigger to also allow the matching
reverse edge for every existing forward edge was considered and
rejected too: since every forward edge in this graph is already used by
some `revert*` call site, a bidirectional trigger would end up allowing
essentially the same movement the graph already permits in either
direction — materially weaker protection than it appears to offer, not
a genuine independent safety net. A session-variable escape hatch (the
app sets a GUC before calling `revertStatus()` to bypass the check) was
also considered and rejected: it would make the guarantee depend on the
application layer correctly flagging its own exception, which is
exactly the trust assumption DB-native enforcement exists to remove.
**Conclusion: the existing atomic-claim + in-app graph check remains
the correct enforcement layer for this specific state machine** — unlike
the arbiter-key/fee-distribution guards above (which protect fields with
no legitimate "undo" path), `Escrow.status` genuinely needs bidirectional
movement for real recovery, which a deterministic DB trigger cannot
safely distinguish from an illegitimate one using only the row's own
before/after values.

### `FeeDistribution` — HISTORICAL / SUPERSEDED / WRITE-FROZEN (RFC-021 Phase 0's retired Protocol Fee split)

```prisma
model FeeDistribution {
  id                     String   @id @default(uuid())
  escrowId               String   @unique
  escrow                 Escrow   @relation(fields: [escrowId], references: [id])
  totalFee               Decimal  @db.Decimal(24, 8)
  asset                  AssetType
  nodeOperatorShare      Decimal  @db.Decimal(24, 8) // 30%
  treasuryShare          Decimal  @db.Decimal(24, 8) // 25%
  walletRebateShare      Decimal  @db.Decimal(24, 8) // 35%
  arbitratorReserveShare Decimal  @db.Decimal(24, 8) // 10%
  moduleId               String   @default("opensettlement")
  protocolVersion        String   @default("0.1")
  createdAt              DateTime @default(now())

  @@map("fee_distributions")
}
```

**Missão 11 Fase 6.5.2 — single-economic-authority cutover.** This table
is **not a normative source of any future economic entitlement.**
`FeeCollectionEvidence(CONFIRMED) → FeeObligation → a frozen
DistributionPolicyVersion → EntitlementLedgerEntry`
(`src/modules/open-settlement/entitlement-allocation.service.ts`, Missão
11 Fase 6.3A — not yet given its own full entry in this document, a
known documentation gap, not an omission of this correction) is the sole
future economic allocation authority. This table is retained purely for
historical/audit purposes: every row that
exists was written before the cutover by `escrow.service.ts`'s (now
removed) `chargeProtocolFee()`, called from `releaseFunds()` only,
whenever `config.settlement.protocolFeeRate` was non-zero — which it
never was in any environment this repository evidences (the config
default has always been `0`). The 35/30/25/10 split (Wallet Rebate/Node
Operator/Treasury/Arbitrator Reserve — revised 2026-08-11 from the
original 40/30/20/10) was `PROTOCOL_ECONOMY.md` §6.2's proposed, never
formally activated, economics — see that document's own historical
marking. A DB-native trigger (`fee_distributions_write_freeze_guard`,
`prisma/migrations/20260823020000_legacy_fee_distribution_write_freeze`)
now rejects every `INSERT`/`UPDATE`/`DELETE` against this table
unconditionally, including raw SQL bypassing the application entirely —
existing rows remain fully readable and are never modified by that
guard. `Escrow.feeCharged` (above) is the same `totalFee` value,
denormalized onto the escrow itself; it is never set again by any live
code path and stays `null` for every future release.

### `FeeDistributionBatch` / `FeeDistributionBatchItem` — HISTORICAL / SUPERSEDED / WRITE-FROZEN (Missão 11 Fase 2.2's accounting foundation)

Introduced (commit `af8de81`, "add protocol fee accounting foundation")
as a policy-versioned, multi-recipient-aware evolution of `FeeDistribution`
above — but, per that commit's own message, "structural foundation only,"
never wired into any real settlement flow. Fase 6.5.1's audit confirmed
zero production call sites for `addObligationToBatch()` anywhere in this
repository; only its own test ever called it. Same disposition as
`FeeDistribution`: **not a normative source of any future economic
entitlement**, retained for historical/audit purposes only, and
DB-natively write-frozen (`fee_distribution_batches_write_freeze_guard`,
`fee_distribution_batch_items_write_freeze_guard`, same migration as
above) — every `INSERT`/`UPDATE`/`DELETE` is rejected unconditionally,
including raw SQL, while existing rows (if any) remain fully readable.

### `FeeCollectionEvidence.distributionPolicyVersionId` — COLLECTED-time economic freeze (Missão 11 Fase 7.2)

**CTO-frozen decision:** `DistributionPolicyVersion` becomes economically
binding at the moment a `FeeCollectionEvidence(CONFIRMED)` row is recorded
(`FeeObligation` transitioning to `COLLECTED`) — never at whenever an
allocation worker happens to run. `distributionPolicyVersionId` (nullable
FK to `DistributionPolicyVersion`, `onDelete: Restrict`) is meaningful
only for `kind = 'CONFIRMED'` rows; it is resolved once, by
`fee-collection-recognition.service.ts`'s `recognizeConfirmation()`, in
the SAME insert that creates the row (never a separate write step). `null`
is a real, permanent, legitimate outcome when zero `DistributionPolicyVersion`
was PUBLISHED at that moment — `EntitlementAllocationService.allocate()`
treats this as a hard error, never adopting a policy published later.

A real Postgres trigger
(`fee_collection_evidence_distribution_policy_immutability_guard`,
migration `20260823182951_collected_time_distribution_freeze_and_policy_exclusivity`)
rejects ANY change to this column once a row exists — including
`null` -> non-null (no backfill), a different policy id, or clearing it
back to `null` — enforced independently of this application, including
against raw SQL. A reorg followed by a genuine reconfirmation creates a
brand-new CONFIRMED row (a new generation, its own id) that independently
freezes whatever policy is live at THAT moment; the original generation's
own frozen reference is never rewritten.

`EntitlementAllocationService.allocate()` reads this frozen reference
directly — it never queries live `PUBLISHED` `DistributionPolicyVersion`
state itself (no `findLivePolicy()`, no `orderBy publishedAt`, no
`take: 1`, no "latest wins"). Distribution-policy selection belongs
exclusively to recognition/`COLLECTED` time; `allocate()` only
materializes the already-decided economic ownership.

### `FeePolicyVersion` / `DistributionPolicyVersion` — DB-native exclusivity (Missão 11 Fase 7.1/7.2)

Two real Postgres unique indexes, neither representable in
`schema.prisma`'s DSL (partial/expression indexes have no Prisma model
syntax) and therefore invisible to `prisma migrate diff`/
`db:completeness-check` — verified permanently by
`tests/integration/dbNativeInvariants.test.ts`'s own index-catalog gate.

- `fee_policy_versions_single_published_per_rail_key` — `UNIQUE
  (railScope) WHERE status = 'PUBLISHED'`. At most one PUBLISHED
  `FeePolicyVersion` per rail.
- `distribution_policy_versions_single_published_key` — `UNIQUE ((true))
  WHERE status = 'PUBLISHED'`. `DistributionPolicyVersion` has no
  rail/scope column at all (Phase 6.2 D4 — allocation economics are
  protocol-level, not per-rail), so this is a true global singleton: at
  most one PUBLISHED row, period.

Both `FeePolicyService.findLivePolicyForRail()` and
`DistributionPolicyService.findLivePolicy()` fail closed
(`EconomicAuthorityAmbiguityError`) if more than one PUBLISHED row is
somehow found — structurally impossible under the indexes above; this is
defense-in-depth for a legacy/corrupt/raw-SQL-bypass state, not an
expected runtime path. The same migration also makes `FeePolicyVersion`'s
four legacy bucket-percentage columns (`nodeOperatorPct`/`treasuryPct`/
`walletRebatePct`/`arbitratorReservePct`) nullable — no longer normative
inputs for a new publication; existing historical rows keep their
original values unchanged.

**Escrow state machine — valid transitions (enforced in application code,
not the database):**

```
CREATED                  → FUNDS_LOCKED, REFUNDED
FUNDS_LOCKED             → PAYMENT_PENDING, DISPUTED, REFUNDED
PAYMENT_PENDING          → COMPLETED, DISPUTED
COMPLETED                → (terminal)
DISPUTED                 → COMPLETED, REFUNDED
REFUNDED                 → (terminal)
```

*(`PAYMENT_PENDING → PENDING_BANK_SETTLEMENT → COMPLETED`/`DISPUTED` is
RFC-007 D3's designed-but-not-migrated extra state — see the note above
`EscrowStatus`'s definition. Once that migration lands, this table gains
the two edges back.)*

### `EscrowEvent` — audit log, owned by `opensettlement`

```prisma
model EscrowEvent {
  id          String       @id @default(uuid())
  escrowId    String
  escrow      Escrow       @relation(fields: [escrowId], references: [id])
  fromStatus  EscrowStatus
  toStatus    EscrowStatus
  triggeredBy String
  note        String?
  createdAt   DateTime     @default(now())
  entryHash   String?      // RFC-008 D2 — sha256(fields + prevHash), null on pre-RFC-008 rows
  prevHash    String?      // RFC-008 D2 — prior EscrowEvent.entryHash for this tradeId/intentId; 'genesis' for the first chained entry

  @@map("escrow_events")
}
```

Every escrow state transition writes a row here — this is the append-only
audit trail used for dispute resolution (see `SECURITY_MODEL.md`).
`entryHash`/`prevHash` (RFC-008 D2, `rfcs/RFC-008-verifiable-timestamps-and-chained-timeline.md`)
are computed once, at write time, by the same code path that writes this
row — never recomputed at read time, or they prove nothing. Nullable so
existing rows are unaffected; `Timeline.verifyChain()` treats a `null`
`entryHash` as a chain-start boundary, not a break, so the tamper-evidence
guarantee only covers entries written after this RFC ships.

### `EscrowReleaseApproval` — owned by `opensettlement` (RFC-015)

```prisma
model EscrowReleaseApproval {
  id         String   @id @default(uuid())
  escrowId   String
  approverId String   // must equal Trade.buyerId or Trade.sellerId
  approvedAt DateTime @default(now())

  @@unique([escrowId, approverId])
  @@map("escrow_release_approvals")
}
```

RFC-015's two-person control — application-layer, not on-chain multisig
(`@tetherto/wdk-wallet-evm-erc-4337` is single-owner-only, checked
against its real compiled types before choosing this design; the
underlying blockchain transaction is still signed by one key regardless
of how many approvals this table has). Only meaningful when
`REQUIRE_DUAL_APPROVAL_RELEASE=true` (default `false`) — `escrow.service.ts`'s
`releaseFunds()` refuses to proceed on a normal (`PAYMENT_PENDING`)
release until both `Trade.buyerId` and `Trade.sellerId` have a row here
for that `escrowId`. Arbitrated releases (`Escrow.status === 'DISPUTED'`)
always bypass this table entirely, regardless of the flag — see that
RFC's Decision §3 for why re-requiring the two counterparties' agreement
after a dispute has already been raised would defeat arbitration's
purpose.

### `EscrowPendingTransaction` — owned by `opensettlement` (Phase 2 client-signature collection, documented here 2026-08-02)

```prisma
model EscrowPendingTransaction {
  id                 String   @id @default(uuid())
  escrowId           String   @unique
  kind               String   // 'release' | 'refund' | 'split'
  toAddress          String
  toAddressSecondary String?  // RFC-021 D9 — only set for kind: 'split' (the seller's payout, alongside toAddress's buyer's)
  unsignedPsbtBase64 String
  requiredSigners    String[]
  triggeredBy        String
  createdAt          DateTime @default(now())

  signatures EscrowTransactionSignature[]

  @@map("escrow_pending_transactions")
}

model EscrowTransactionSignature {
  id                 String                   @id @default(uuid())
  pendingTxId        String
  pendingTx          EscrowPendingTransaction @relation(fields: [pendingTxId], references: [id], onDelete: Cascade)
  participantId      String
  signedPsbtBase64   String
  createdAt          DateTime                 @default(now())

  @@unique([pendingTxId, participantId])
  @@map("escrow_transaction_signatures")
}
```

`MULTISIG`/`LIGHTNING_HODL`/`SAFE_GUARD_EVM` never hold a private key
that alone can sign a release/refund/split — buyer and seller keys are
client-held (`multisig.provider.ts`'s own header comment). This is the
async signature-collection round those three types need instead of a
single synchronous `SettlementProvider.releaseFunds()` call:
`escrow.service.ts`'s `initiateRelease()`/`initiateRefund()`/
`initiateSplit()` build and persist an unsigned PSBT here (`kind` says
which); each id in `requiredSigners` calls
`POST /v1/settlement/escrow/:id/submit-transaction-signature` with
their own independently-signed copy, upserted into
`EscrowTransactionSignature`; once every required signer has submitted,
`submitTransactionSignature()` combines them and finalizes for real
(`provider.finalizeRelease()`/`finalizeRefund()`/`finalizeSplit()`),
then deletes this row (`onDelete: Cascade` clears its signatures too) —
a completed round leaves no pending row behind, only `Escrow.txReleaseId`
as the durable record. On a `DISPUTED` release/refund, `requiredSigners`
has only one entry (the arbiter's own signature is pre-embedded in
`unsignedPsbtBase64` at build time, since the arbiter's key is still
server-derived); a `DISPUTED` split (RFC-021 D9) is the same shape, one
entry, for a real cryptographic reason, not a stylistic mirror — see
that RFC's own D9 section for why a 2-of-3 script can't take a third
independent signature on top of the arbiter's.

### `Dispute` — owned by `opensettlement`, first implementation of §1.9's primitive

```prisma
enum DisputeStatus {
  OPENED
  EVIDENCE_SUBMITTED
  ARBITRATED
  RESOLVED
  APPEALED       // RFC-021 D6 — a RESOLVED dispute reopened for a new arbiter's ruling
  AUTO_PROPOSED  // RFC-021 D8 — QVAC proposed an automated ruling, open for contest
}

enum DisputeRuling {
  RELEASE // buyer wins — "dispute_resolved_buyer" in @satsails/p2p-schemas' TradeState vocabulary
  REFUND  // seller wins — "dispute_resolved_seller"
  SPLIT   // §1.9's third option — RFC-021 D9 (2026-08-02): a real settlement action now exists for MOCK/WDK_USDT_EVM/MULTISIG (escrowService.splitFunds()/initiateSplit()); SAFE_GUARD_EVM/LIGHTNING_HODL each reject it with a specific, real, provider-level reason (see that RFC's own D9 section)
}

model Dispute {
  id         String         @id @default(uuid())
  tradeId    String
  trade      Trade          @relation(fields: [tradeId], references: [id])
  escrowId   String
  escrow     Escrow         @relation(fields: [escrowId], references: [id])
  openedBy   String         // participantId — must be the trade's buyer or seller, enforced in dispute.service.ts
  reason     String
  evidence   Json           @default("[]") // EvidenceDescriptor[] (@satsails/p2p-schemas)
  arbiterId  String?        // populated by ArbitrationProvider.assign() (RFC-007 D4)
  status     DisputeStatus  @default(OPENED)
  ruling     DisputeRuling?
  resolvedAt DateTime?
  // RFC-021 D6 — appeal state. appealRound is 0 until the first appeal;
  // previousRuling/previousArbiterId snapshot the ruling being appealed
  // so resolveDispute() can slash the original arbiter on an overturn.
  appealRound       Int                @default(0)
  previousRuling    DisputeRuling?
  previousArbiterId String?
  appealFees        DisputeAppealFee[]
  // RFC-021 D8 — QVAC-assisted automated first-pass resolution (see that
  // model's own section below). Populated only while status is
  // AUTO_PROPOSED (or after, for audit — see autoResolved).
  autoResolutionRecommendation DisputeRuling?
  autoResolutionConfidence     Float?
  autoResolutionReasoning      String?
  autoResolutionDeadline       DateTime?
  autoResolved                 Boolean         @default(false)
  moduleId   String         @default("opensettlement")
  protocolVersion String    @default("0.1")
  createdAt  DateTime       @default(now())
  updatedAt  DateTime       @updatedAt

  @@unique([tradeId]) // one Dispute per Trade for its entire lifetime — see dispute.service.ts's own comment
  @@index([escrowId])
  @@index([status])
  @@map("disputes")
}
```

The Dispute *primitive* (`PROTOCOL_SPECIFICATION.md` §1.9) predates this
table — this is its first persistence, added by the dispute-flow work
(`modules/open-settlement/dispute.service.ts`: `raiseDispute()` freezes
the escrow via the existing `escrowService.openDispute()` transition,
assigns an arbiter via `ArbitrationProvider` (RFC-007 D4's first real
implementation, `arbitration-provider.ts`), and notifies via
`dispute.opened` on the Event Bus; `resolveDispute()` maps
`RELEASE`/`REFUND` onto the existing escrow release/refund paths).

**Corrected 2026-08-02** (closing a gap first found 2026-08-01, widened
the same day RFC-021 D8 landed, both times left "not fixed here" until
now): the model above now matches `prisma/schema.prisma` exactly,
including D6's appeal fields and D8's auto-resolution fields.

### `ArbiterProfile` — owned by `opensettlement`, RFC-021 D2/D3's real permissionless-registration (opt-in per deployment via `ARBITRATION_MODE=market`; `'trusted-list'` remains the default) + reputation-as-collateral state

```prisma
model ArbiterProfile {
  id                     String     @id @default(uuid())
  participantId          String     @unique
  participant            User       @relation(fields: [participantId], references: [id])
  monetaryCollateral     Decimal    @default(0) @db.Decimal(24, 8)
  collateralAsset        AssetType? // null when monetaryCollateral is 0
  arbiterReputation      Float      @default(0)
  rulingsTotal           Int        @default(0)
  rulingsOverturned      Int        @default(0) // RFC-021 D6 appeal outcomes
  cumulativeFeesObserved Decimal    @default(0) @db.Decimal(24, 8) // RFC-021 D4, Phase 3
  registeredAt           DateTime   @default(now())
  slashedAt              DateTime?
  moduleId               String     @default("opensettlement")
  protocolVersion        String     @default("0.1")
  updatedAt              DateTime   @updatedAt

  @@map("arbiter_profiles")
}
```

One row per self-registered arbiter candidate (`MarketArbitrationProvider.register()`,
only meaningful under `ARBITRATION_MODE=market` — the default
`'trusted-list'` mode never creates or reads this table at all).
`effectiveStake = monetaryCollateral + arbiterReputation × REPUTATION_STAKE_FACTOR`
(RFC-021 D3, computed on read, not stored) determines eligibility for a
given dispute's value; `slash()` (D6, an overturned appeal) forfeits
`SLASH_COLLATERAL_FRACTION` of `monetaryCollateral` and applies
`OVERTURNED_PENALTY` to `arbiterReputation` — a separate field from
`User.reputationScore`, since an arbiter's professional track record and
a trader's own reputation are different things about the same person.
`slashedAt` is set on the first slash and never cleared — a slashed
arbiter's history stays visible, it isn't a one-time penalty that resets.

### `PaymentAccount` — owned by `opensettlement`, RFC-021 D5's real payment-account trust ramp

```prisma
model PaymentAccount {
  id              String        @id @default(uuid())
  ownerId         String
  owner           User          @relation(fields: [ownerId], references: [id])
  accountHash     String        @unique // sha256(paymentMethod:rawIdentifier) — never the raw account identifier
  paymentMethod   PaymentMethod
  signed          Boolean       @default(false)
  signedBy        String?       // the counterparty/arbiter (or RFC-021 D7 voucher) who attested this account
  signedAt        DateTime?
  attestationSource PaymentAccountAttestationSource? // #235 R7C — PEER | VOUCHER | LEGACY; null while unsigned
  attestedTradeId   String?                          // #235 R7C — the trade that authorized a PEER attestation
  firstUsedAt     DateTime      @default(now())
  completedTrades Int           @default(0)
  chargebacks     Int           @default(0)
  moduleId        String        @default("opensettlement")
  protocolVersion String        @default("0.1")
  updatedAt       DateTime      @updatedAt

  @@index([ownerId])
  @@map("payment_accounts")
}
```

**#235 R7C — binding and attestation authority.** A PaymentAccount is the
fiat receiver's (seller's) rail. The seller binds it to a trade when the
trade is created — `Offer.paymentAccountId` on a SELL offer (copied to the
Trade), the taker's selection on a BUY offer — and it is stored on
`Trade.sellerPaymentAccountId`, checked for ownership and payment method,
fixed at insert (`trades_seller_payment_account_write_once_guard`). Only
the buyer of a clean COMPLETED trade (escrow released, no dispute ever)
may attest that trade's bound account (`attestationSource = PEER`,
`attestedTradeId`); the write is conditional on `signed = false` and
write-once (`payment_accounts_attestation_write_once_guard`,
`payment_accounts_attestation_check`). RFC-021 D7 vouching is recorded as
`VOUCHER`; rows signed before R7C were backfilled `LEGACY` (their origin is
not recorded). The server cannot prove a client-computed hash matches the
free-text payment details actually paid to: the buyer's attestation, made
with the hash of what they paid, is that witness. An unbound trade (none
declared, or created before R7C) can never attest.

**#235 R7D (N2) — `completedTrades` is production truth.** Its only writer
is `paymentAccountService.recordCleanBoundCompletion()`, called by the
`settlement.escrow.released` handler: the trade's bound account gains one
completed trade when the escrow is COMPLETED and no dispute ever existed,
exactly once per (COMPLETED transition, trade) through an
`event_projection_claims` claim committed with the increment; PASS 3
re-drives it after a crash. Unbound trades, refunds, cancellations,
SPLITs and post-dispute releases count nothing. Existing counter values
are untouched (no backfill).

**Chargebacks — fail-closed by CTO policy (Day-0).**
`PaymentAccount.chargebacks` remains an input recognized by the trust ramp
(`computeTradeLimit()`: any `chargebacks > 0` caps the account at
`SIGNED_TRADE_LIMIT`, and existing values are honoured as they are), but
Day-0 has no canonical fiat-reversal authority able to produce new values.
Escrow refund, cancellation, dispute, ruling, SPLIT, MOOT and fee reversal
do not constitute a chargeback: a chargeback is a fact of the fiat rail,
and an unknown fiat outcome is not a chargeback. Until a specific
authorized primitive/source exists, the protocol stays fail-closed and
never increments this counter (no production writer exists; a structural
test fails if one is added).

Future chargeback support requires a separate canonical fiat-reversal
authority with provenance, immutable trade/account binding, authorization,
idempotency, exactly-once semantics and restart/replay safety. Such a
primitive would at least bind each reversal to its `tradeId` and to that
trade's `sellerPaymentAccountId`, record its provenance and the defined
source/authority that asserted it, be idempotent and exactly-once, survive
replay/restart, and be contestable where applicable. It is outside #235
R7D and is not implemented.

Modeled directly on Bisq's real "Payment account age witness"/account
signing — a SEPARATE risk dimension from `User.reputationScore`: this
measures whether a specific payment rail (a PIX key, a bank account) has
survived a completed trade without a chargeback, which trader reputation
alone doesn't cover (an otherwise reputable trader's account can still be
stolen/compromised — the "conta laranja"/mule-account risk). `accountHash`
is the privacy-preserving hash both `payment-account.service.ts` (server)
and `@satsails/p2p-trading-sdk`'s `hashPaymentAccount()` (client) compute
byte-identically — the raw account identifier is never stored anywhere.
`getTradeLimit()`'s real ramp reads directly off this row:
`!signed` → `UNSIGNED_TRADE_LIMIT` (the floor, including a brand-new
account with no history at all) → `SIGNED_TRADE_LIMIT` once `signed` →
`ESTABLISHED_TRADE_LIMIT` at `ESTABLISHED_TRADE_COUNT` completed trades →
`'unlimited'` at `TRUSTED_TRADE_COUNT` completed trades with zero
`chargebacks` — a single real chargeback permanently caps the account at
`SIGNED_TRADE_LIMIT` regardless of `completedTrades`, by design (D5's own
stated rule: one reversal is a real, disqualifying signal, not averaged
away by later good trades). RFC-021 D7 (2026-08-02) added a second way
`signed` can become `true` at creation time: `getOrCreate()` pre-signs a
genuinely-new owner's first account when an active `Vouch` exists for
them (see `Vouch`'s own section below).

### `PayoutAddress` — owned by `opensettlement`, closed 2026-08-04 (BACKLOG.md's "Participant payout address" gap)

```prisma
model PayoutAddress {
  id            String    @id @default(uuid())
  participantId String
  participant   User      @relation(fields: [participantId], references: [id])
  asset         AssetType
  address       String
  moduleId      String    @default("opensettlement")
  protocolVersion String  @default("0.1")
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  @@unique([participantId, asset])
  @@map("payout_addresses")
}
```

A real, recurring gap surfaced by the dispute work: `resolveDispute()`'s
RELEASE/SPLIT rulings and `escrow.service.ts`'s `releaseFunds()`/
`splitFunds()`/`initiateRelease()`/`initiateSplit()` all needed a real
crypto address to pay a participant out to, and this schema modeled none
for any asset — callers had to pass one explicitly every single time.
Separate from `PaymentAccount` above (that's the FIAT rail a trader
*receives PIX/bank transfers on*, with a trust ramp and chargeback
tracking; this is the crypto address a trader *receives released escrow
funds at* — different asset class, no trust ramp needed, a wrong address
just fails to receive funds rather than enabling a chargeback) and
one row per (participant, asset) — `@@unique` enforces this — since a
BTC address and an EVM address for the same participant are unrelated
values, never one field covering both.

`payout-address.service.ts`'s `setPayoutAddress()`/`getPayoutAddress()`
are the read/write surface (`POST`/`GET /v1/settlement/payout-addresses`).
`escrow.service.ts`'s private `resolvePayoutAddress()` is the actual
fallback consumer: an explicit address passed to any of the four methods
above always wins; absent that, it looks up the participant's own
registered row for the escrow's asset; absent both, it throws a specific
error naming exactly what's missing (`CODE_STYLE.md` §2) rather than
guessing one.

### `DisputeAppealFee` — owned by `opensettlement`, RFC-021 D6's real appeal-fee charge (closed 2026-08-01)

```prisma
model DisputeAppealFee {
  id          String    @id @default(uuid())
  disputeId   String
  dispute     Dispute   @relation(fields: [disputeId], references: [id])
  appealRound Int       // which appeal round this charge is for — a Dispute can be appealed more than once
  requestedBy String    // the appellant (participantId) — dispute.service.ts's appeal() caller
  amount      Decimal   @db.Decimal(24, 8)
  asset       AssetType
  outcome     String?   // 'FORFEITED' | 'REFUNDED', set by resolveDispute(); null while pending
  settledAt   DateTime?
  moduleId    String    @default("opensettlement")
  protocolVersion String @default("0.1")
  createdAt   DateTime  @default(now())

  @@unique([disputeId, appealRound])
  @@map("dispute_appeal_fees")
}
```

Same "computed and persisted, not actually routed on-chain" realness the
Protocol Fee itself already has (`FeeDistribution` below/`escrow.service.ts`'s
`chargeProtocolFee()`) — no `SettlementProvider` in this codebase has a
real configured treasury/arbitrator-reserve address to send anything to.
`appeal()` creates one row per round; `resolveDispute()` sets `outcome`
once the appeal panel rules (`FORFEITED` on a denied/frivolous appeal,
`REFUNDED` on an overturn). `outcome` is a plain `String`, not a new
Prisma enum, for a 2-value field this narrow — the same "free-form
string, enforced in code" choice `Claim.claimType`/`Message.msgType`
already make elsewhere in this schema.

### `Vouch` — owned by `openreputation`, RFC-021 D7's real peer-vouching bootstrap (2026-08-02)

```prisma
model Vouch {
  id          String    @id @default(uuid())
  voucherId   String
  voucher     User      @relation("VouchesGiven", fields: [voucherId], references: [id])
  voucheeId   String
  vouchee     User      @relation("VouchesReceived", fields: [voucheeId], references: [id])
  createdAt   DateTime  @default(now())
  burnedAt    DateTime? // set once, real skin in the game — see vouch.service.ts's burnVouchesFor()
  moduleId    String    @default("openreputation")
  protocolVersion String @default("0.1")

  @@unique([voucherId, voucheeId])
  @@index([voucheeId])
  @@map("vouches")
}
```

Not a KYC/identity-linking primitive — corrected directly by the project
owner after an earlier RFC-021 draft used that framing (RFC-021's own D7
section has the full correction). A real protocol-native attestation:
`vouch.service.ts`'s `vouchFor()` requires the voucher to have real trade
history (`MIN_VOUCHER_TRADES = 3`) and positive `reputationScore` before
the vouch is even created; `@@unique([voucherId, voucheeId])` is the
actual one-vouch-per-pair-ever enforcement, not just application logic.
`payment-account.service.ts`'s `getOrCreate()` checks for an active
(`burnedAt: null`) vouch on a genuinely new owner's first `PaymentAccount`
and pre-signs it if one exists. `burnedAt` is set by
`burnVouchesFor()` (called from `common/events/handlers.ts`'s
`settlement.escrow.released`/`refunded` reactions) when the vouchee's
first lost dispute happens while the vouch is still active — the
voucher's own `User.reputationScore` takes a real penalty via
`reputation.service.ts`'s `penalizeForBurnedVouch()` at the same moment.

### `Intent`, `IntentEvent` — Core, first implementation (03-implementation_plan.md MVP)

```prisma
model Intent {
  id             String    @id @default(uuid())
  type           String
  version        String    @default("1.0")
  participantId  String
  agentId        String?
  parentIntentId String?
  moduleId       String
  payload        Json
  status         String
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  expiresAt      DateTime?
  fulfilledBy    String?
  metadata       Json      @default("{}")

  events IntentEvent[]

  @@index([participantId])
  @@index([status])
  @@map("intents")
}

model IntentEvent {
  id          String   @id @default(uuid())
  intentId    String
  intent      Intent   @relation(fields: [intentId], references: [id])
  fromStatus  String?
  toStatus    String
  triggeredBy String
  note        String?
  createdAt   DateTime @default(now())
  entryHash   String?
  prevHash    String?

  @@index([intentId])
  @@map("intent_events")
}
```

Real implementation, unlike `EscrowEvent`'s `entryHash`/`prevHash` above
(documented per RFC-008 D2 but still 🔲 in `BACKLOG.md`) —
`core/intent-engine.ts`'s `transition()` actually computes and writes them
on every `IntentEvent` row, `sha256(fromStatus|toStatus|triggeredBy|prevHash)`,
`'genesis'` for an Intent's first event. `payload` is intentionally opaque
`Json` — a new `IntentType` (e.g. `LoanIntent`) needs zero migration here,
only application-level TypeScript/Zod validation for its shape.
Deliberately 2 tables, not the 3 `PROTOCOL_SPECIFICATION.md` §2.6
originally sketched — see that section for why the `intent_payloads` split
turned out to add a join without adding any real flexibility once this
became a real Prisma model instead of a paper design.

### `Message` — owned by `openp2p` (Negotiation primitive / Secretstream chat)

```prisma
model Message {
  id        String    @id @default(uuid())
  tradeId   String
  trade     Trade     @relation(fields: [tradeId], references: [id])
  senderId  String
  sender    User      @relation(fields: [senderId], references: [id])
  content   String
  msgType   String    @default("TEXT")   // TEXT | IMAGE | PAYMENT_PROOF | SYSTEM
  readAt    DateTime?
  createdAt DateTime  @default(now())

  @@index([tradeId])
  @@map("messages")
}
```

This table exists precisely because the messaging/negotiation module is
still necessary — see `PROJECT_CONTEXT.md` for why. `msgType =
PAYMENT_PROOF` is how the buyer proves to the seller that fiat was sent,
without the protocol ever touching the fiat itself.

### `ReputationEvent` — owned by `openreputation`

```prisma
model ReputationEvent {
  id              String   @id @default(uuid())
  tradeId         String
  trade           Trade    @relation(fields: [tradeId], references: [id])
  raterId         String
  rater           User     @relation("RaterEvents", fields: [raterId], references: [id])
  ratedId         String
  rated           User     @relation("RatedEvents", fields: [ratedId], references: [id])
  score           Int
  comment         String?
  moduleId        String   @default("openreputation")
  protocolVersion String   @default("0.1")
  createdAt       DateTime @default(now())
  entryHash       String?  // RFC-008 D2 — same chaining rule as EscrowEvent above
  prevHash        String?  // RFC-008 D2

  @@unique([tradeId, raterId])
  @@map("reputation_events")
}
```

`@@unique([tradeId, raterId])` is a deliberate anti-abuse constraint — one
participant can only rate a given trade once.

**RFC-007 D8 note:** `ReputationEvent` rows remain the persisted record of
`rate()` calls, but as of RFC-007 they are informational feedback only —
no aggregate reputation-score computation reads `ReputationEvent.score`
directly. `ReputationScore` is computed exclusively from `SettlementOutcome`
events (via the `EscrowEvent` trail above and an internal `OutcomeEngine`,
not a new table — it's a computation over existing rows, not new state).
A `CancelledByAgreement` trade outcome always classifies `NEUTRAL` and can
never reduce the counterparty's score.

---

### `Claim`, `Proof`, `Verification` — owned by no single module (RFC-003)

**Corrected 2026-08-04 to match the real schema** — this section
previously described `EvidenceVerification` as the model name (to "avoid
a reserved-word collision"); the real, shipped model is named
`Verification`, no collision issue ever materialized. `Proof.evidence`
also gained a real `evidenceHash` — this whole shape has been real code
(`proof.service.ts`) since Fase 1, this doc simply hadn't been reconciled
with it until the RFC-007/008 pass below.

```prisma
model Claim {
  id        String   @id @default(uuid())
  claimedBy String   // a participantId (User.id) — see RFC-001
  claimType String   // open string: 'payment_sent', 'invoice_paid',
                      // 'oracle_verified', 'collateral_held', ...
  assertion Json
  // RFC-007 D6, added 2026-08-04 — scopes a Claim into a trade's real
  // EvidenceBundle (see EvidenceReference section below). Nullable: not
  // every Claim is trade-related.
  tradeId   String?
  createdAt DateTime @default(now())

  proofs Proof[]
  @@index([claimedBy])
  @@index([tradeId])
  @@map("claims")
}

model Proof {
  id           String   @id @default(uuid())
  claimId      String
  claim        Claim    @relation(fields: [claimId], references: [id])
  evidence     Json     // opaque — signature, receipt image ref, oracle payload
  evidenceHash String   // sha256 hex of the canonicalized evidence, always server-recomputed — never client-supplied
  submittedBy  String
  submittedAt  DateTime @default(now())

  verifications      Verification[]
  evidenceReferences EvidenceReference[]   // RFC-007 D2 — back-relation for EvidenceReference below
  @@index([claimId])
  @@index([evidenceHash])   // RFC-007 D1 — ProofRegistry.findDuplicates() queries by this
  @@map("proofs")
}

model Verification {
  id         String              @id @default(uuid())
  proofId    String
  proof      Proof               @relation(fields: [proofId], references: [id])
  verifiedBy String              // a participantId, an arbiter, or a QVAC agent identifier
  verdict    VerificationVerdict
  reason     String?
  verifiedAt DateTime            @default(now())

  @@index([proofId])
  @@map("verifications")
}
```

### `EvidenceReference` — owned by `openproof` (RFC-007 D2, RFC-008 D1)

**Corrected 2026-08-04 to match the real, shipped implementation** — this
section previously described a design (`ProofFingerprint` as a separate
table, `anchorType`/`anchorData`/`anchoredAt` as three separate columns,
`EvidenceVerification` as the model name) written before any of RFC-007
D1/D2/D6 or RFC-008 D1 existed in code. Real deviations, each disclosed
in the relevant source file's own header comment:

```prisma
model EvidenceReference {
  id          String   @id @default(uuid())
  proofId     String
  proof       Proof    @relation(fields: [proofId], references: [id])
  provider    String   // 'local-fs' | 's3' | 'r2' | 'ipfs' | 'arweave' | 'nostr.build' | ...
  uri         String
  sha256      String   // real hash of the stored media bytes — recomputed server-side
  mimeType    String   // 'image' | 'video' | 'document' | 'ocr' | 'external_reference'
  signature   String   // Ed25519, verified server-side against the submitter's own User.publicKey
  anchorProof Json?    // RFC-008 D1 — { anchorType, anchorId, submittedAt, upgraded }; null until anchored
  createdAt   DateTime @default(now())

  @@map("evidence_references")
}
```

**No `ProofFingerprint` table.** `Proof.evidenceHash` (already real,
persisted by `submitProof()` since Fase 1, now `@@index`ed) already *is*
the fingerprint `ProofRegistry.findDuplicates()` (RFC-007 D1) queries by
— a separate table would duplicate data that already exists for a
different reason (`proof-registry.ts`'s own header comment has the full
reasoning). `findDuplicates()` scopes "a different intentId" as "a
different `Claim.tradeId`" — the model still doesn't have a real
`intentId` column, same situation `Timeline` below was already in.

**`anchorProof` is one `Json?` field, not three columns** — `AnchorProof`
(`timestamp-anchor.ts`) is a small, self-contained shape
(`{anchorType, anchorId, submittedAt, upgraded}`); a JSON column avoids
three mostly-null columns for a feature that, per RFC-008 D1's own
Policy-gating, most `EvidenceReference` rows will never use.

The protocol never stores the media itself — `EvidenceReference` is a
signed pointer into whichever `EvidenceProvider` the submitting Reference
Implementation configured (`LocalFilesystemEvidenceProvider` by default —
real, content-addressed, zero external credentials; a real S3/R2/IPFS
provider is a separate, still-unbuilt implementation of the same
interface).

**`EvidenceBundle` (RFC-007 D6) is not a table.** It is a query —
`ProofService.getEvidenceBundleForTrade(tradeId)`, real as of 2026-08-04
— that joins `Claim`, `Proof`, `Verification`, `EvidenceReference`, and
the Timeline projection (below) by `tradeId`, not this section's
originally-planned `intentId` (`Claim` gained a real, nullable `tradeId`
column for this) — the same real-world correction Timeline itself
already needed, consistent with RFC-007 rejecting `EvidenceBundle` as a
primitive with its own persisted lifecycle. Kept separate from the
already-shipped, per-Claim `getEvidenceBundle(claimId)` (its own real
SDK/React-hook surface) rather than renaming that method.

### `Timeline` — not its own table; a projection over `durable_events` (RFC-007 D5, corrected by RFC-017 and RFC-008 D2)

**Corrected 2026-07-19** (a consolidation-audit catch): RFC-007 D5
originally keyed this by `intentId`. RFC-017
(`rfcs/RFC-017-timeline-and-social-engineering-agent.md`) found that the
real events a Timeline consumer actually needs (chat, escrow,
negotiation) carry `tradeId` as their `correlationId` (RFC-010) today,
not `intentId` — no Intent-to-Trade persistence link exists yet to make
`intentId` the right key. `core/timeline.ts`'s real, shipped
`getTimeline(correlationId)` reflects RFC-017's correction; this section
previously still described RFC-007's original, superseded shape.

**Corrected again, 2026-08-15 (found stale while working on Missão 05.7,
fixed as part of it per this repo's own "fix a confirmed-stale doc found
in a file already being touched" convention — not scope creep, the
convention itself):** the paragraph below, as it read before this pass,
said Timeline is "a read projection over events already persisted by
each module's own audit trail (`EscrowEvent`, `ReputationEvent`...)" and
that RFC-008 D2 "adds `entryHash`/`prevHash` columns directly to those
same per-module tables." Both claims were already false by the time
RFC-017 shipped (2026-08-04) — `core/timeline.ts`'s real
`getTimeline(correlationId)` has only ever read from
`EventStore.getEvents(correlationId)` (`common/events/event-store.ts`),
never from `EscrowEvent`/`ReputationEvent` directly; RFC-008's own D2
section already documents this correction and says so explicitly. This
file's own copy of that claim was simply never updated to match — see
RFC-008's D2 section for the full history, and its Missão 05.5 and
Missão 05.7 amendments below it for what actually did (and didn't)
change on `EscrowEvent` and the `EventStore` backend since.

`Timeline.getEvents(correlationId)` is a read projection over
`EventStore.getEvents(correlationId)` — the Event Bus's own
`DurableEvent` stream (RFC-010), ordered by `publishedAt` and filtered to
one `correlationId` (`tradeId` today; `intentId` once Intent persistence
exists). As of Missão 05.7 (2026-08-15), that stream is durable by
default: `PostgresEventStore` persists it to a real table,
`durable_events` (Prisma model `DurableEventRecord`, documented below) —
before this, the default `InMemoryEventStore` held it only in-process,
gone on restart. `EscrowEvent`/`ReputationEvent` remain each module's own
separate audit trail (real, Postgres-backed, and — for `EscrowEvent` —
independently hash-chained since Missão 05.5), but `Timeline` does not
read them; it is not a projection over them and never has been since
RFC-017 shipped.

### `DurableEventRecord` — `EventStore`'s durable backing table, owned by Core (RFC-010, RFC-008 D2 amendment — Missão 05.7)

```prisma
model DurableEventRecord {
  id            String @id @default(uuid())
  eventName     String
  correlationId String
  payload       Json
  publishedAt   String  // exact ISO-8601 string hashed by computeEntryHash() — never a native DateTime, see this model's own schema.prisma comment for why
  entryHash     String  // RFC-008 D2 — sha256(eventName:publishedAt:JSON(payload):prevHash), computed at write time by EventStore.publish()
  prevHash      String  // prior DurableEventRecord.entryHash for this correlationId; GENESIS_HASH ('genesis') for the first

  @@index([correlationId, publishedAt])
  @@map("durable_events")
}
```

One shared table for every module's events — not a per-module table like
`EscrowEvent`/`IntentEvent` above. This is the storage behind `EventStore`
itself (`common/events/event-store.ts`'s `PostgresEventStore`, now
`SailsEventBus`'s default), not a second, competing copy of any one
module's own audit trail. No historical-rows question applies: this
table is new, created directly with `entryHash`/`prevHash` as `NOT NULL`
columns (unlike `EscrowEvent`/`IntentEvent`'s nullable ones, which had to
account for pre-hash-chain rows).

### `OperationalProfileGrant` — owned by `openidentity` (RFC-007 D8/D11)

```prisma
model OperationalProfileGrant {
  id              String    @id @default(uuid())
  participantId   String    // a User.id — see RFC-001
  profile         String    // 'regular_trader' | 'liquidity_provider' | 'merchant' | 'arbitrator' | 'agent'
  grantedBy       String    // an application identifier, via Policy Engine — not protocol-level KYC
  criteria        Json?     // e.g. { minScore: 95, minTrades: 1000, noRecentDisputes: true }
  createdAt       DateTime  @default(now())
  revokedAt       DateTime?

  @@map("operational_profile_grants")
}
```

Mirrors `CapabilityGrant` below in shape and intent — `OperationalProfile`
is a scope a `CapabilityGrant` can reference (RFC-005), not a separate
permission mechanism. A `liquidity_provider` profile unlocks
Policy-Engine-gated behavior (e.g. `trustedSettlementAcceleration` on
`PENDING_BANK_SETTLEMENT`, section above) — never a fixed protocol
privilege.

### `Capability`, `CapabilityGrant` — Core components, not module-owned (RFC-005)

**Corrected 2026-07-19** (a consolidation-audit catch): this section
previously showed `Capability` as a persisted Prisma model alongside
`CapabilityGrant`. It was never that — RFC-013
(`rfcs/RFC-013-capability-registry-and-wallet-adapter.md`) explicitly
considered and rejected a `Capability`/`CapabilityImplementation` table
("a table with zero real write path") in favor of a static in-code map
(`capability-registry.ts`'s `CAPABILITY_IMPLEMENTATIONS`). `Capability`
is the abstract TypeScript interface (`PROTOCOL_SPECIFICATION.md`
§1.10) any module implements — never a database row. Only
`CapabilityGrant`, the actual permission record, is persisted:

```prisma
model CapabilityGrant {
  id             String    @id @default(uuid())
  grantedTo      String    // a participantId or an Agent identifier
  capabilityName String    // references the in-code Capability map, not a foreign key
  scope          String[]
  constraints    Json?
  issuedBy       String
  createdAt      DateTime  @default(now())
  revokedAt      DateTime?

  @@map("capability_grants")
}
```

### A note on `Participant` (RFC-001) and this schema

`User` (above) remains the concrete table — it already has the right
shape (`publicKey`, `verificationLevel` via a level field, etc.) to satisfy
the `Participant` interface `Identity` implements. No new `Participant`
table is needed at the reference-implementation level; `Participant` is a
Core-level TypeScript abstraction (`PROTOCOL_SPECIFICATION.md` §1.1), not
a distinct persisted entity — `User.id` already serves as `participantId`
everywhere `Claim.claimedBy`, `CapabilityGrant.grantedTo`, etc. reference
one.



**Corrected 2026-08-17 (Missão 08B)** — this table previously described
`trade:room:<tradeId>` / `users:online` as real Redis-cached chat
state, and named `InMemoryEventStore` as still the active `EventStore`.
Both were stale: `InMemoryEventStore` stopped being the default at
Missão 05.7 (2026-08-15, `PostgresEventStore` since); the two chat keys
below were never actually implemented this way — `chat-room-registry.ts`
has only ever been a plain in-process `Map<tradeId, Set<socket>>`, one
instance's own view of who's currently WS-connected, holding no chat
history at all (that's `Message`, Postgres, above). Removed rather than
"corrected in place" — they described a design that was never built.

Missão 08B (multi-instance runtime safety) added the one real, new
Redis usage below: a Pub/Sub channel carrying a fan-out *signal*, never
the data of record.

| Key / channel | Purpose |
|---|---|
| `sails:cross-instance-events` | Pub/Sub channel (not a Stream/list — no persistence, no replay) `PostgresEventStore.publish()` also broadcasts every event to, so every other app instance's own local `EventStore.subscribe()` handlers fire too (`event-store.ts`'s `enableCrossInstanceFanout()`). Purely a real-time signal: the event itself is already durably committed to `durable_events` (Postgres, above) before this fires, and a message lost to this channel (e.g. a subscriber briefly disconnected) never loses data — only the live push, not the record. A local chat-room-registry `Map` (per-instance, in-process, not Redis) still decides which of *that instance's own* WS sockets actually receive the resulting push. |
| `auth:challenge:<publicKeyHex>` | Ed25519 login challenge nonce, short TTL (`common/middleware/auth.ts`) |
| `auth:session:<token>` | Active session → participantId, TTL `AUTH_SESSION_TTL` |
| `auth:ws-ticket:<ticket>` | Single-use WS-upgrade ticket, burned on first use (`common/middleware/ws-auth.ts`) |
| `ratelimit:auth:<route>:<ip>`, `ratelimit:critical:<route>:<ip>` | Missão 08B — shared counters for the two rate-limit tiers moved off `@fastify/rate-limit`'s local store (`common/middleware/redis-rate-limit.ts`), so the limit is enforced across every instance, not per-instance. Global and WS-message tiers stay local/in-memory, unchanged. |
| `sails:events:<eventName>` | RFC-010's `RedisStreamsEventStore` — a real, working, tested alternative `EventStore` implementation (Redis Streams, `XADD`/consumer-group `XREADGROUP`/`XACK`). Never instantiated outside its own tests; Missão 08A's architectural audit explicitly evaluated and rejected it as the cross-instance fan-out mechanism (consumer groups load-balance one message to *one* consumer — the opposite of the broadcast-to-every-instance shape needed here) in favor of the Pub/Sub channel above. |
| `sails:events:by-correlation:<correlationId>` | Same (inactive) store's second index. |

None of this is mandated by the protocol — a different reference
implementation could use any cache/fan-out strategy or none at all.

---

## 5. Intent persistence — current implementation

The earlier handoff version of this section said Intent persistence did not exist. That is no longer true.

Current `prisma/schema.prisma` includes real `Intent` and `IntentEvent` models, with durable lifecycle/event history. `Offer` also carries an optional `intentId` relationship for the current Intent-as-entry-point path.

Use the actual schema and current Intent/RFC documents for exact fields and lifecycle behavior. Do not infer current Intent persistence from the historical "not yet implemented" statement or from `TODO.md`.
