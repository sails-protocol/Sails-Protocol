/**
 * Full trade lifecycle — end-to-end wiring validation (CTO-role follow-up
 * after RFC-018's validation pass: "validar o fluxo completo end-to-end
 * do Sails P2P Trading SDK com persistência real e integração dos
 * providers").
 *
 * What "persistência real" and "integração dos providers" cannot mean in
 * this sandboxed environment: there is no reachable Postgres/Docker
 * (confirmed earlier this same pass — same limitation TODO.md/RFC-018/
 * RFC-019 already document for Redis and live WDK/HyperDHT calls) and no
 * live WDK testnet or HyperDHT network. That validation is out of reach
 * here and stays the sócio dev's infra-pass job.
 *
 * What IS achievable, and the strongest substitute available without
 * live infra: every OTHER test file in this suite mocks at a single
 * service boundary (routes.test.ts mocks Prisma but stubs eventBus.emit
 * to a no-op so cross-module reactions never fire; reputationOutcome.test.ts
 * mocks intentEngine wholesale; settlementOrchestrator.test.ts mocks
 * escrowService entirely). None of them chains the REAL service layer
 * across every module in one continuous flow with the REAL event bus
 * actually dispatching to the REAL handlers.ts reactions. This file does:
 * only the database (an in-memory fake standing in for Prisma) and the
 * two genuinely-external providers (WDK/HyperDHT) are replaced — every
 * service singleton, the real eventBus (PostgresEventStore as of Missão
 * 05.7, backed by this file's own fake durableEventRecord table below —
 * no live Postgres/Redis needed), and registerEventHandlers() are the
 * actual production code. This is exactly the kind of gap that
 * caught the Trade.escrowId bug fixed earlier this pass (a unit test
 * mocking dispute.service.ts's own database calls directly would never
 * have caught that createEscrow() never wrote the FK another module
 * needed — only a chain that runs escrow creation for real and then
 * asserts what raiseDispute() sees would).
 */
export {} // same reasoning as chatUnification.test.ts/reputationOutcome.test.ts's
// identical comment — forces this file to be a module so top-level consts
// don't leak into the global scope and collide with another test file's.

// ─── In-memory Prisma fake ─────────────────────────────────────────────────
// Every mutating call in the real chain (offer -> intent -> trade -> escrow
// -> dispute -> user) round-trips through these tables instead of a mocked
// return-value queue, so state a later step reads (e.g. dispute.service.ts's
// `if (!trade.escrowId)` guard) reflects what an EARLIER step's handler
// actually wrote — the exact property a per-call mock can't verify.
function makeTable(idPrefix: string, defaults: Record<string, unknown> = {}) {
  const rows = new Map<string, any>()
  let seq = 0
  return {
    rows,
    create: jest.fn(async ({ data }: any) => {
      const id = data.id ?? `${idPrefix}-${++seq}`
      const row = { id, createdAt: new Date(), updatedAt: new Date(), ...defaults, ...data }
      rows.set(id, row)
      return { ...row }
    }),
    findUnique: jest.fn(async ({ where }: any) => {
      const row = typeof where.id === 'string'
        ? rows.get(where.id)
        : [...rows.values()].find((r) => Object.entries(where).every(([k, v]) => r[k] === v))
      return row ? { ...row } : null
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = rows.get(where.id)
      if (!row) throw new Error(`${idPrefix}: row ${where.id} not found`)
      const merged = { ...row }
      for (const [k, v] of Object.entries(data)) {
        merged[k] = v && typeof v === 'object' && 'increment' in (v as any)
          ? (merged[k] ?? 0) + (v as any).increment
          : v
      }
      merged.updatedAt = new Date()
      rows.set(where.id, merged)
      return { ...merged }
    }),
    findMany: jest.fn(async ({ where = {} }: any = {}) => {
      return [...rows.values()]
        .filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
        .map((r) => ({ ...r }))
    }),
    // Robustness-audit fix (2026-07-20): escrow.service.ts/intent-engine.ts
    // now claim state transitions via a conditional updateMany() (WHERE
    // id AND status match) before touching anything side-effecting — see
    // both files' own comments. Real conditional-update semantics here,
    // not a stub: only rows whose current value already matches every
    // `where` entry get updated, and `count` reflects how many actually
    // did — exactly what a concurrent-loser test needs to exercise for
    // real, the same way the in-memory tables above already give every
    // other method real round-trip behavior instead of a canned response.
    // ADR-005 §10/#218 — dispute.service.ts's applyRuling()/appeal() now
    // guard their locked writes with a Prisma `{ not: X }` filter (e.g.
    // `status: { not: 'RESOLVED' }`), not just plain equality. Extending
    // matchesWhereClause rather than adding a second updateMany variant —
    // same "real conditional-update semantics, not a stub" discipline this
    // table's own comment above already commits to.
    updateMany: jest.fn(async ({ where, data }: any) => {
      const matchesWhereClause = (r: any) =>
        Object.entries(where).every(([k, v]) =>
          v && typeof v === 'object' && 'not' in (v as any) ? r[k] !== (v as any).not : r[k] === v
        )
      const matches = [...rows.values()].filter(matchesWhereClause)
      for (const row of matches) {
        const merged = { ...row, ...data, updatedAt: new Date() }
        rows.set(row.id, merged)
      }
      return { count: matches.length }
    }),
    findFirst: jest.fn(async ({ where = {} }: any = {}) => {
      const row = [...rows.values()].find((r) => Object.entries(where).every(([k, v]) => r[k] === v))
      return row ? { ...row } : null
    }),
  }
}

const users = makeTable('user', { reputationScore: 0, totalTrades: 0, totalVolumeBtc: '0' })
const offers = makeTable('offer', { status: 'ACTIVE' })
// InternalOrderBook.getOffers() (liquidity.service.ts) always queries with
// `include: { user: { select: { reputationScore: true } } }` and
// mapOfferToLiquidityOffer() reads offer.user.reputationScore directly —
// the generic findMany above doesn't know about Prisma's `include`, so
// this nests the real (in-memory) user row onto each returned offer, the
// one place this flow needs it.
const originalOffersFindMany = offers.findMany
offers.findMany = jest.fn(async (args: any) => {
  const rows = await originalOffersFindMany(args)
  return rows.map((r: any) => ({ ...r, user: { reputationScore: users.rows.get(r.userId)?.reputationScore ?? 0 } }))
})
const trades = makeTable('trade', { status: 'PENDING', escrowId: null })
const escrows = makeTable('escrow', { status: 'CREATED' })
const escrowEvents = makeTable('escrowEvent')
// Missão 11 Fase 4.1 — createEscrow() now unguardedly calls
// escrowFeeSnapshotService.computeSnapshotFields() (fail-closed) before
// creating the escrow row. No test in this file publishes a fee policy,
// so findMany() correctly returns [] every time (same "every table
// round-trips for real, empty is a real answer too" convention this
// file already uses for the vouch table below).
const feePolicyVersions = makeTable('feePolicyVersion')
const disputes = makeTable('dispute', { status: 'OPENED' })
const intents = makeTable('intent', { expiresAt: null })
// RFC-021 D7 — vouch.service.ts's burnVouchesFor() (called from
// handlers.ts's settlement.escrow.released/refunded reactions) needs a
// real vouch table too, even though no test in this file creates any
// vouches — findMany() correctly returns [] (no active vouch for anyone
// here), matching this file's own "every table round-trips for real"
// discipline rather than a separately-mocked no-op.
const vouches = makeTable('vouch', { burnedAt: null })
// Missão 11 Fase 9.3 — markPaymentSent()/initiateRelease()/initiateSplit()
// now re-check funding uncertainty (empty here is correct: no test in
// this file ever records reorg-sweep evidence, same "table round-trips
// for real, empty is a real answer too" convention already used above).
const escrowFundingEvidence = makeTable('escrowFundingEvidence')
// Fase 7.3.1 §B — DisputeService.findCommittedArbiterId() reads this for
// every raiseDispute()/appeal() call. Empty here (this file's escrows are
// all honestly MOCK-typed, per createEscrow()'s own mockEscrow-aware
// default — no MULTISIG/LIGHTNING_HODL submitParticipantKey() flow ever
// runs, so no arbiter commitment row ever exists), which correctly makes
// findUnique() return null — the same "table round-trips for real, empty
// is a real answer too" convention this file already applies to
// feePolicyVersion/vouch above.
const escrowParticipantKeys = makeTable('escrowParticipantKey')
// M8-R2 (2026-09-11, docs/DESTINATION_AUTHORITY_ARCHITECTURE.md) — a
// dispute ruling's own RELEASE/REFUND/SPLIT settlement action no longer
// accepts a caller/arbiter-supplied destination (see dispute.service.ts's
// applyRuling()); it always resolves each beneficiary's own registered
// PayoutAddress via this table instead. Real findUnique keyed by
// {participantId, asset} (Prisma's own compound-unique shape), same
// "every table round-trips for real" convention this file already uses.
const payoutAddressRows = new Map<string, { participantId: string; asset: string; address: string }>()
const payoutAddresses = {
  findUnique: jest.fn(async ({ where }: { where: { participantId_asset: { participantId: string; asset: string } } }) => {
    const key = `${where.participantId_asset.participantId}:${where.participantId_asset.asset}`
    return payoutAddressRows.get(key) ?? null
  }),
}
function registerPayoutAddress(participantId: string, asset: string, address: string) {
  payoutAddressRows.set(`${participantId}:${asset}`, { participantId, asset, address })
}

// intentEvent's hash-chain (writeIntentEvent(), core/intent-engine.ts) needs
// findFirst ordered by createdAt desc, not just any match — the generic
// findFirst above returns array-scan order, which happens to be insertion
// order here (fine for prevHash chaining, but overridden explicitly for
// clarity since correctness here matters more than the generic helper).
const intentEventRows: any[] = []
let intentEventSeq = 0
const intentEvents = {
  create: jest.fn(async ({ data }: any) => {
    const row = { id: `intentEvent-${++intentEventSeq}`, createdAt: new Date(), ...data }
    intentEventRows.push(row)
    return { ...row }
  }),
  findFirst: jest.fn(async ({ where }: any) => {
    const matches = intentEventRows.filter((r) => r.intentId === where.intentId)
    return matches.length ? matches[matches.length - 1] : null
  }),
}

// eventBus's default store is PostgresEventStore as of Missão 05.7 — the
// real eventBus this file deliberately exercises (see this file's own
// header comment) now needs prisma.durableEventRecord too. Same
// last-match-by-correlationId shape as intentEvents above, for the same
// reason (publish() needs the most recent prior row for a correlationId
// to chain prevHash, not just any match).
// Issue #298 - event_projection_claims with the REAL semantics the property depends on: a unique
// (eventId, projectionKey, subjectId) identity; createMany({skipDuplicates}) reports how many rows were
// actually inserted (0 for an already-claimed identity), exactly like INSERT ... ON CONFLICT DO NOTHING.
const projectionClaimKeys = new Set<string>()
const projectionClaimRows: any[] = []
const eventProjectionClaims = {
  rows: { clear: () => { projectionClaimKeys.clear(); projectionClaimRows.length = 0 } },
  create: jest.fn(async ({ data }: any) => {
    const key = `${data.eventId}|${data.projectionKey}|${data.subjectId}`
    if (projectionClaimKeys.has(key)) throw new Error(`Unique constraint failed on ${key}`)
    projectionClaimKeys.add(key)
    const row = { id: `claim-${projectionClaimRows.length + 1}`, appliedAt: new Date(), ...data }
    projectionClaimRows.push(row)
    return { ...row }
  }),
  createMany: jest.fn(async ({ data }: any) => {
    let count = 0
    for (const d of data) {
      const key = `${d.eventId}|${d.projectionKey}|${d.subjectId}`
      if (projectionClaimKeys.has(key)) continue
      projectionClaimKeys.add(key)
      projectionClaimRows.push({ id: `claim-${projectionClaimRows.length + 1}`, appliedAt: new Date(), ...d })
      count++
    }
    return { count }
  }),
  findMany: jest.fn(async ({ where = {} }: any = {}) =>
    projectionClaimRows.filter((r) => Object.entries(where).every(([k, v]) => (v && typeof v === 'object') ? true : r[k] === v)).map((r) => ({ ...r }))
  ),
}

const durableEventRows: any[] = []
let durableEventSeq = 0
const durableEventRecords = {
  create: jest.fn(async ({ data }: any) => {
    const row = { id: `durableEvent-${++durableEventSeq}`, ...data }
    durableEventRows.push(row)
    return { ...row }
  }),
  findFirst: jest.fn(async ({ where }: any) => {
    const matches = durableEventRows.filter((r) => r.correlationId === where.correlationId)
    return matches.length ? matches[matches.length - 1] : null
  }),
  findMany: jest.fn(async ({ where }: any) => {
    return durableEventRows.filter((r) => r.correlationId === where.correlationId)
  }),
  // Issue #298 - PostgresEventStore.redeliver() reloads a durable event by id.
  findUnique: jest.fn(async ({ where }: any) => durableEventRows.find((r) => r.id === where.id) ?? null),
}

// PostgresEventStore.publish() (Missão 05.8) wraps its write in a real
// Postgres transaction (pg_advisory_xact_lock-serialized per
// correlationId) — a trivial passthrough is enough here since this file
// doesn't test EventStore concurrency (tests/postgresEventStore.test.ts
// does). Missão 11 Fase 9.3 — withEscrowFundingLock() (escrow-lifecycle.ts)
// also runs markPaymentSent()/initiateRelease()/initiateSplit()'s final
// write through this same $transaction mock; escrow/escrowFundingEvidence
// delegate to the SAME real in-memory tables the top-level prisma mock
// below uses, so a transactional write is visible to a later unlocked
// read exactly like a real Prisma transaction would be.
const mockTransaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) =>
  callback({
    durableEventRecord: durableEventRecords,
    escrow: escrows,
    escrowFundingEvidence: escrowFundingEvidence,
    // Missão 11 Fase 9.7 — emitEscrowTransition() now does its own
    // escrowEvent existence-check-then-create INSIDE withEscrowFundingLock()
    // — same real fake-table object already used for prisma.escrowEvent
    // below, this file's own "every table round-trips for real" discipline.
    escrowEvent: escrowEvents,
    // ADR-005 / #218 — dispute.service.ts's applyRuling()/appeal() now run
    // their resolve-write / authority-reassignment write inside
    // prisma.$transaction() (economic-disposition:<disputeId> advisory
    // lock + a conditional updateMany claim). Same real fake-table object
    // already used for prisma.dispute below, so a transactional write is
    // visible to a later unlocked read exactly like a real Prisma
    // transaction would be — same discipline as escrow/escrowEvent above.
    dispute: disputes,
    // Issue #298 - the claim marker and every projection claim go through the real unique-identity table above;
    // projections mutate the same in-memory tables the rest of the flow reads.
    eventProjectionClaim: eventProjectionClaims,
    user: users,
    trade: trades,
    vouch: vouches,
    $executeRaw: jest.fn().mockResolvedValue(0),
  })
)

jest.mock('../src/common/database', () => ({
  prisma: {
    user: users,
    offer: offers,
    trade: trades,
    escrow: escrows,
    escrowEvent: escrowEvents,
    escrowParticipantKey: escrowParticipantKeys,
    escrowFundingEvidence: escrowFundingEvidence,
    feePolicyVersion: feePolicyVersions,
    payoutAddress: payoutAddresses,
    dispute: disputes,
    intent: intents,
    intentEvent: intentEvents,
    vouch: vouches,
    durableEventRecord: durableEventRecords,
    eventProjectionClaim: eventProjectionClaims,
    $transaction: (...args: unknown[]) => mockTransaction(...(args as [any])),
  },
}))

// Same ESM-only-package problem every other test file mocking this import
// chain already documents (reputationOutcome.test.ts's identical comment):
// @tetherto/wdk-wallet-evm ships pure ESM, no CJS build. Never actually
// reached here regardless — config.features.mockEscrow defaults true
// (RT-001, config/index.ts), so escrow.service.ts's getProvider() always
// returns MockSettlementProvider no matter what EscrowType is requested.
jest.mock('@tetherto/wdk-wallet-evm', () => ({
  __esModule: true,
  default: class FakeWalletManagerEvm {},
}))

// @arkade-os/sdk's CJS build still transitively requires @scure/btc-signer,
// which ships pure ESM (no CJS build) — same "Unexpected token 'export'"
// problem as @tetherto/wdk-wallet-evm above, same fix. None of these tests
// exercise lightning-hodl.provider.ts's real Arkade calls.
jest.mock('@arkade-os/sdk', () => ({
  SeedIdentity: { fromSeed: jest.fn() },
  MultisigTapscript: { encode: jest.fn() },
  CSVMultisigTapscript: { encode: jest.fn() },
  VtxoScript: class FakeVtxoScript {},
  RestArkProvider: class FakeRestArkProvider {},
  RestIndexerProvider: class FakeRestIndexerProvider {},
  buildOffchainTx: jest.fn(),
  combineTapscriptSigs: jest.fn(),
  verifyTapscriptSignatures: jest.fn(),
}))

// lightning-hodl.provider.ts's Phase 2 addition imports @scure/btc-signer
// directly (pure ESM, same reason @arkade-os/sdk itself is mocked above)
// — this test never reaches those code paths, a bare stub is enough.
jest.mock('@scure/btc-signer', () => ({ Transaction: { fromPSBT: jest.fn() } }))

// pear.service.ts's real HyperDHT/Hyperswarm classes need a live P2P
// network to do anything real — not exercised here (negotiation.service.ts's
// open() only touches Prisma/eventBus; HumanChatChannel.sendEvent(), the
// method that actually needs pearNodeRegistry, is never called by this
// flow), stubbed out same as routes.test.ts/reputationOutcome.test.ts.
jest.mock('../src/infrastructure/p2p/pear.service', () => ({
  pearNodeRegistry: {
    get: jest.fn().mockReturnValue(undefined),
    start: jest.fn().mockResolvedValue('fake-peer-id'),
    stop: jest.fn().mockResolvedValue(undefined),
  },
}))

jest.mock('../src/modules/open-p2p/reconciliation.service', () => ({
  reconciliationService: { reconcilePeerPair: jest.fn().mockResolvedValue([]) },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { liquidityRouter } = require('../src/modules/open-liquidity/liquidity.service')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { tradeService } = require('../src/modules/open-p2p/trade.service')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { escrowService } = require('../src/modules/open-settlement/escrow.service')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { executeSettlement } = require('../src/modules/open-settlement/settlement-orchestrator')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DisputeService } = require('../src/modules/open-settlement/dispute.service')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TrustedArbitratorProvider } = require('../src/modules/open-settlement/arbitration-provider')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerEventHandlers } = require('../src/common/events/handlers')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { eventBus } = require('../src/common/events/event-bus')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { intentEngine } = require('../src/core/intent-engine')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OpenP2PTradeIntentHandler } = require('../src/modules/open-p2p/intent-handler')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nacl = require('tweetnacl')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { signAuthorityDecision } = require('../src/modules/open-settlement/arbitration-authority')

// Missão 13 Fase 2 — resolveDispute() now verifies a signed authority
// decision against the arbiter's registered User.publicKey (INV-12) before
// executing any settlement. This file's arbiter ('arbiter-1') needs a real
// Ed25519 identity for that check to have anything real to verify, same as
// every other participant in this file's in-memory `users` table.
const arbiterKeypair = nacl.sign.keyPair()
const arbiterPublicKeyHex = Buffer.from(arbiterKeypair.publicKey).toString('hex')

function signArbiterDecision(
  dispute: { id: string; escrowId: string; appealRound?: number },
  authorityId: string,
  outcome: 'RELEASE' | 'REFUND' | 'SPLIT',
  buyerBps: number | null = null,
  issuedAt = '2026-08-29T00:00:00.000Z'
): [string, string] {
  const signature = signAuthorityDecision(
    {
      disputeId: dispute.id,
      escrowId: dispute.escrowId,
      appealRound: dispute.appealRound,
      authorityId,
      outcome,
      buyerBps,
      issuedAt,
    },
    arbiterKeypair.secretKey
  )
  return [signature, issuedAt]
}

// The real eventBus (InMemoryEventStore, RFC-010's always-available
// default) — genuinely dispatches to registerEventHandlers()'s real
// listeners synchronously within emit()'s call, but a listener's own
// internal awaits resolve on later microtask ticks it doesn't block
// emit() on (Node's EventEmitter is fire-and-forget for async listeners —
// a real characteristic of this architecture, not something introduced
// by this test). flush() drains the microtask queue via a macrotask
// boundary so assertions after a mutating call see the reaction's
// completed effect, not a half-finished one.
const flush = () => new Promise((resolve) => setImmediate(resolve))

function seedUsers() {
  users.rows.clear()
  users.rows.set('buyer-1', { id: 'buyer-1', reputationScore: 0, totalTrades: 0, totalVolumeBtc: '0' })
  users.rows.set('seller-1', { id: 'seller-1', reputationScore: 0, totalTrades: 0, totalVolumeBtc: '0' })
  users.rows.set('arbiter-1', { id: 'arbiter-1', reputationScore: 0, totalTrades: 0, totalVolumeBtc: '0', publicKey: arbiterPublicKeyHex })
}

beforeAll(() => {
  registerEventHandlers()
  // RFC-018 Phase 3 — validateStructure() now delegates to whichever
  // handler is registered for the Intent type, same as app.ts's real
  // buildApp() boot sequence.
  intentEngine.registerHandler(OpenP2PTradeIntentHandler)
})

beforeEach(() => {
  jest.clearAllMocks()
  ;[users, offers, trades, escrows, escrowEvents, escrowParticipantKeys, disputes, intents, eventProjectionClaims].forEach((t) => t.rows.clear())
  intentEventRows.length = 0
  seedUsers()
})

describe('Full trade lifecycle — Intent born -> Offer -> discovery -> Trade -> escrow -> settlement -> reputation', () => {
  it('walks a real happy-path trade through every real service, end to end', async () => {
    // 1-2. Wallet A (seller) creates an Intent + publishes an Offer.
    const offer = await liquidityRouter.createOffer({
      userId: 'seller-1',
      asset: 'USDT_ERC20',
      side: 'SELL',
      priceUsd: '1.00',
      minAmount: '10',
      maxAmount: '100',
      paymentMethod: 'PIX',
    })
    expect(offer.intentId).toBeTruthy()
    expect(intents.rows.get(offer.intentId)?.status).toBe('COORDINATED')

    // 3. Wallet B (buyer) discovers it — the real order-book aggregation,
    // not a hand-picked fixture. getAggregatedOffers(asset, side) filters
    // by the offer's OWN side (InternalOrderBook.getOffers()) — a SELL
    // offer is an "ask", found by querying the SELL side, same as
    // getOrderBook()'s own bids/asks split.
    const { offers: discovered } = await liquidityRouter.getAggregatedOffers('USDT_ERC20', 'SELL')
    expect(discovered.map((o: any) => o.id)).toContain(offer.id)

    // 4-5. Trade is born from the discovered Offer — walks the Intent
    // DISCOVERING -> MATCHED -> NEGOTIATING (trade.service.ts) and opens
    // the negotiation channel (negotiation.service.ts).
    const trade = await tradeService.createTrade({
      offerId: offer.id,
      counterpartyId: 'buyer-1',
      amount: '20',
    })
    expect(trade.intentId).toBe(offer.intentId)
    expect(intents.rows.get(offer.intentId)?.status).toBe('NEGOTIATING')

    // 6-8. Escrow locks, (emulated) PIX payment happens, settlement
    // finalizes — the real orchestrator, the same function
    // common/events/handlers.ts wires to openp2p.trade.created when
    // AUTO_SETTLE_ON_MATCH=true, called directly here exactly like the
    // demo script and settlement.routes.ts's own callers do.
    const result = await executeSettlement({
      tradeId: trade.id,
      buyerReceivingAddress: '0xBuyerTestnetAddress',
    })
    await flush()

    // The bug fixed earlier this pass: Trade.escrowId must actually be
    // the escrow createEscrow() just made — this is the FK
    // dispute.service.ts's raiseDispute() depends on, and until today's
    // fix nothing in the real flow ever wrote it.
    expect(trades.rows.get(trade.id)?.escrowId).toBe(result.escrowId)
    expect(escrows.rows.get(result.escrowId)?.status).toBe('COMPLETED')
    expect(trades.rows.get(trade.id)?.status).toBe('COMPLETED')

    // 9. Reputation updates — both parties credited, no dispute in this
    // path (RFC-007 D8/D9).
    expect(users.rows.get('buyer-1')?.reputationScore).toBe(2)
    expect(users.rows.get('seller-1')?.reputationScore).toBe(2)
    expect(users.rows.get('buyer-1')?.totalTrades).toBe(1)
    expect(users.rows.get('seller-1')?.totalTrades).toBe(1)

    // The Intent this whole chain started from reached its own real
    // terminal state — not left behind by any of the 4 modules it passed
    // through (RFC-018's entire point).
    expect(intents.rows.get(offer.intentId)?.status).toBe('FULFILLED')
  })

  it('a dispute raised after escrow locks resolves through the real chain — proves the Trade.escrowId fix end to end', async () => {
    const offer = await liquidityRouter.createOffer({
      userId: 'seller-1',
      asset: 'USDT_ERC20',
      side: 'SELL',
      priceUsd: '1.00',
      minAmount: '10',
      maxAmount: '100',
      paymentMethod: 'PIX',
    })
    const trade = await tradeService.createTrade({
      offerId: offer.id,
      counterpartyId: 'buyer-1',
      amount: '20',
    })

    const escrow = await escrowService.createEscrow({
      tradeId: trade.id,
      lockedAmount: '20',
      asset: 'USDT_ERC20',
    }, 'seller-1')
    await flush()
    // Before today's fix this would still be null against a real database
    // — nothing ever wrote it. Asserted explicitly here, not just implied
    // by the raiseDispute() call below succeeding.
    expect(trades.rows.get(trade.id)?.escrowId).toBe(escrow.id)

    await escrowService.lockFunds(escrow.id, 'seller-1')
    await flush()
    expect(intents.rows.get(offer.intentId)?.status).toBe('COMMITTED')

    const disputeService = new DisputeService(new TrustedArbitratorProvider(['arbiter-1']))
    const dispute = await disputeService.raiseDispute(trade.id, 'buyer-1', 'PIX payment never arrived')
    expect(dispute.arbiterId).toBe('arbiter-1')
    expect(escrows.rows.get(escrow.id)?.status).toBe('DISPUTED')

    const [refundSig, refundIssuedAt] = signArbiterDecision(dispute, 'arbiter-1', 'REFUND')
    const resolved = await disputeService.resolveDispute(dispute.id, 'arbiter-1', 'REFUND', undefined, undefined, undefined, refundSig, refundIssuedAt)
    await flush()

    expect(resolved.status).toBe('RESOLVED')
    expect(escrows.rows.get(escrow.id)?.status).toBe('REFUNDED')
    expect(trades.rows.get(trade.id)?.status).toBe('CANCELLED')
    expect(intents.rows.get(offer.intentId)?.status).toBe('FAILED')

    // RFC-007 D9 — a REFUND ruling means the seller won, the buyer lost.
    expect(users.rows.get('seller-1')?.reputationScore).toBe(2)
    expect(users.rows.get('buyer-1')?.reputationScore).toBe(-5)
  })

  // RFC-021 D9 (2026-08-02) — the same real chain as the REFUND test above,
  // proving the third §1.9 dispute-ruling option actually moves funds and
  // reaches every module's own real terminal state, not just dispute.
  // service.ts's own unit-mocked applyRuling() dispatch (disputeFlow.test.ts).
  it('a SPLIT dispute ruling resolves through the real chain — funds move, both sides score NEUTRAL, Intent reaches FULFILLED', async () => {
    const offer = await liquidityRouter.createOffer({
      userId: 'seller-1',
      asset: 'USDT_ERC20',
      side: 'SELL',
      priceUsd: '1.00',
      minAmount: '10',
      maxAmount: '100',
      paymentMethod: 'PIX',
    })
    const trade = await tradeService.createTrade({
      offerId: offer.id,
      counterpartyId: 'buyer-1',
      amount: '20',
    })
    const escrow = await escrowService.createEscrow({
      tradeId: trade.id,
      lockedAmount: '20',
      asset: 'USDT_ERC20',
    }, 'seller-1')
    await flush()
    await escrowService.lockFunds(escrow.id, 'seller-1')
    await flush()

    // M8-R2 — the buyer's and seller's own registered PayoutAddress rows,
    // the ONLY destinations this ruling's settlement action may use.
    registerPayoutAddress('buyer-1', 'USDT_ERC20', '0xBuyerRegisteredAddress')
    registerPayoutAddress('seller-1', 'USDT_ERC20', '0xSellerRegisteredAddress')

    const disputeService = new DisputeService(new TrustedArbitratorProvider(['arbiter-1']))
    const dispute = await disputeService.raiseDispute(trade.id, 'buyer-1', 'PIX payment only partially confirmed')
    expect(escrows.rows.get(escrow.id)?.status).toBe('DISPUTED')

    // M8-R2 — a real address is still supplied here (as a legacy/old
    // caller would) specifically to prove it has NO effect: the
    // MockSettlementProvider's own real splitFunds() bakes each
    // destination into its returned txId (see the assertion below), so a
    // wrong/attacker value here would be directly observable if it were
    // ever actually used instead of the registered addresses above.
    const [splitSig, splitIssuedAt] = signArbiterDecision(dispute, 'arbiter-1', 'SPLIT', 6000)
    const resolved = await disputeService.resolveDispute(dispute.id, 'arbiter-1', 'SPLIT', '0xAttackerBuyerAddress', '0xAttackerSellerAddress', 6000, splitSig, splitIssuedAt)
    await flush()

    expect(resolved.status).toBe('RESOLVED')
    expect(resolved.ruling).toBe('SPLIT')
    expect(escrows.rows.get(escrow.id)?.status).toBe('SPLIT')
    // Real 2-transfer MockSettlementProvider.splitFunds() — each txId
    // embeds the first 8 chars of the address it actually paid out to
    // (escrow-providers.ts's own MockSettlementProvider.splitFunds()).
    // Proves the REGISTERED addresses were used, not the ones supplied
    // to resolveDispute() above.
    const txReleaseId = escrows.rows.get(escrow.id)?.txReleaseId as string
    expect(txReleaseId).toContain('0xBuyerR') // '0xBuyerRegisteredAddress'.slice(0, 8)
    expect(txReleaseId).toContain('0xSeller') // '0xSellerRegisteredAddress'.slice(0, 8)
    expect(txReleaseId).not.toContain('Attacker')
    expect(trades.rows.get(trade.id)?.status).toBe('COMPLETED')

    // RFC-021 D9 — neither party "lost" a split ruling; both score NEUTRAL.
    expect(users.rows.get('buyer-1')?.reputationScore).toBe(0)
    expect(users.rows.get('seller-1')?.reputationScore).toBe(0)

    expect(intents.rows.get(offer.intentId)?.status).toBe('FULFILLED')
  })
})

// Security-validation round (2026-07-19, "replay de evento / idempotência"
// scenario): InMemoryEventStore (event-store.ts, RFC-010's always-available
// default) is a plain EventEmitter — it never redelivers an event on its
// own, so neither of the two behaviors below is reachable through any real
// code path in this reference implementation TODAY. They matter because
// RFC-010 already anticipates swapping in a durable backend
// (RedisStreamsEventStore, still unbuilt per BACKLOG.md), and durable
// queues commonly redeliver on at-least-once semantics — these tests put
// that future requirement under pressure now, before it's built, rather
// than discovering it live.
describe('Event replay / idempotency — durable-event redelivery must never duplicate an effect (Issue #298)', () => {
  // registerEventHandlers() already ran once in this file's top-level
  // beforeAll (above) — eventBus is a module-level singleton shared by
  // every describe block in this file, so calling it again here would
  // double-register every listener (EventEmitter.on() has no dedup),
  // making a single emit() fire each reaction twice on its own — a test
  // bug that would fake the exact "double-count" this block exists to
  // isolate for real, found the hard way while writing this test.

  beforeEach(() => {
    jest.clearAllMocks()
    ;[users, offers, trades, escrows, escrowEvents, escrowParticipantKeys, disputes, intents, eventProjectionClaims].forEach((t) => t.rows.clear())
    intentEventRows.length = 0
    seedUsers()
  })

  it('GOOD: a duplicate settlement.escrow.locked is naturally rejected by the Intent state machine — COMMITTED is not re-enterable', async () => {
    const offer = await liquidityRouter.createOffer({
      userId: 'seller-1', asset: 'USDT_ERC20', side: 'SELL', priceUsd: '1.00', minAmount: '10', maxAmount: '100', paymentMethod: 'PIX',
    })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: 'buyer-1', amount: '20' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, lockedAmount: '20', asset: 'USDT_ERC20' }, 'seller-1')
    await escrowService.lockFunds(escrow.id, 'seller-1')
    await flush()
    expect(intents.rows.get(offer.intentId)?.status).toBe('COMMITTED')

    // Redeliver the exact same event a second time — simulates a durable
    // queue's at-least-once retry, not something this test fabricates
    // beyond what actually flows through escrow.service.ts's transition().
    await eventBus.emit('settlement.escrow.locked', {
      escrowId: escrow.id, tradeId: trade.id, from: 'CREATED', to: 'FUNDS_LOCKED', triggeredBy: 'seller-1',
    }, trade.id)
    await flush()

    // core/state-machine.ts's VALID_TRANSITIONS has no COMMITTED -> COMMITTED
    // entry — intent-engine.ts's transition() throws, event-store.ts's
    // subscribe() catches and logs it (console.error, expected in this
    // test's output), and the Intent is left exactly where it was.
    // Protected by construction, not by anything built for this test.
    expect(intents.rows.get(offer.intentId)?.status).toBe('COMMITTED')
  })

  it('INVARIANT (Issue #298, was the "BAD known gap"): the SAME durable settlement.escrow.released event redelivered N times - including concurrently and by a second consumer - applies each additive effect exactly once', async () => {
    const offer = await liquidityRouter.createOffer({
      userId: 'seller-1', asset: 'USDT_ERC20', side: 'SELL', priceUsd: '1.00', minAmount: '10', maxAmount: '100', paymentMethod: 'PIX',
    })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: 'buyer-1', amount: '20' })
    await executeSettlement({ tradeId: trade.id, buyerReceivingAddress: '0xBuyerTestnetAddress' })
    await flush()
    expect(users.rows.get('buyer-1')?.reputationScore).toBe(2)
    expect(users.rows.get('seller-1')?.reputationScore).toBe(2)
    const totalTradesBefore = users.rows.get('buyer-1')?.totalTrades
    const volumeBefore = users.rows.get('buyer-1')?.totalVolumeBtc
    expect(totalTradesBefore).toBe(1)

    // Redeliver the exact same durable event (a durable queue's at-least-once retry, a lost ack, or another
    // instance receiving it over the cross-instance fanout): same eventId, so the projection claims collide.
    const released = durableEventRows.find((r) => r.eventName === 'settlement.escrow.released')
    expect(released).toBeDefined()
    const results = await Promise.all(Array.from({ length: 5 }, () => eventBus.redeliver(released.id)))
    expect(results.every(Boolean)).toBe(true)
    await flush()
    await flush()

    // Previously this DID double-count (asserted as 4/4 as a documented gap). Now it cannot.
    expect(users.rows.get('buyer-1')?.reputationScore).toBe(2)
    expect(users.rows.get('seller-1')?.reputationScore).toBe(2)
    expect(users.rows.get('buyer-1')?.totalTrades).toBe(totalTradesBefore)
    expect(users.rows.get('buyer-1')?.totalVolumeBtc).toBe(volumeBefore)
    expect(trades.rows.get(trade.id)?.status).toBe('COMPLETED')
  })
})
