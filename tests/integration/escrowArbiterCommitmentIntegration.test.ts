// tests/integration/escrowArbiterCommitmentIntegration.test.ts
//
// Missão 11 Fase 5.2 — real-Postgres proof of the escrow-specific,
// immutable arbiter public-key commitment (EscrowParticipantKey
// role='arbiter'):
//   1. escrowService.submitParticipantKey() persists it end-to-end, once
//      both buyer and seller pubkeys have arrived, using the real
//      MultisigProvider (not mocked).
//   2. The escrow's own committed arbiter pubkey, combined with the real
//      buyer/seller pubkeys, reconstructs the SAME P2WSH address stored on
//      Escrow.multisigAddr — proof persisted-key == script-key (§5).
//   3. escrowService.getEscrow() (the existing authenticated read surface,
//      zero new routes) exposes the commitment via participantKeys (§7).
//   4. The DB-native trigger (escrow_participant_keys_arbiter_immutability_
//      guard, this mission's own new migration) rejects UPDATE/DELETE of
//      the arbiter row, while a buyer/seller row remains freely mutable —
//      proven against a real database, not a mock (a mock has no trigger).
//
// Missão 11 Fase 6.3B.1 — connectivity, authorization, and the fail-loud
// requirePostgres() contract all come from the shared
// tests/integration/postgresTestHarness.ts now (this file used to carry
// its own local skip()-and-console.warn helper, a silent false-green when
// Postgres was unreachable — replaced, not merely relocated).

// MOCK_ESCROW=true is the repo's own .env default — this file needs the
// REAL MultisigProvider derivation path (submitParticipantKey()'s
// `!config.features.mockEscrow` guard), and .env sets no MULTISIG_SEED at
// all. Both must be set before src/config is ever required (this file's
// own beforeAll() is the first thing that requires it), same "set
// process.env before requiring config" discipline
// tests/multisigProvider.test.ts's loadProvider() helper already
// establishes elsewhere in this suite.
process.env.MOCK_ESCROW = 'false'
process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'fase-5-2-integration-test-seed'

// Missão 11 Fase 5.3 §A — the "correct triggeredBy but wrong persisted
// pubkey" / "TRUSTED_ARBITRATORS changed" tests below need a SECOND
// escrowService instance built under a DIFFERENT MULTISIG_SEED, to prove
// the real signature-collection path (escrow-pending-tx.ts's
// initiateSignatureCollectionCore(), not a hand-built provider fixture)
// fails closed against a real persisted commitment. jest.resetModules()
// + re-require, same technique tests/multisigProvider.test.ts's own
// loadProvider() already established. common/database's `prisma` client
// is cached on `global.__prisma` (survives resetModules — a real Node
// global, not part of Jest's module registry), so this never opens a
// second connection pool; the ORIGINAL escrowService captured before any
// reset keeps its own already-bound reference and is unaffected by any
// later reset in this same file.
const BASE_ENV = { ...process.env }
function loadEscrowServiceWithSeed(seed: string): typeof import('../../src/modules/open-settlement/escrow.service').escrowService {
  jest.resetModules()
  process.env = { ...BASE_ENV, MOCK_ESCROW: 'false', MULTISIG_SEED: seed }
  return require('../../src/modules/open-settlement/escrow.service').escrowService
}

import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { boundOfferRow, boundTradeRow, sellerPixAccount } from './economicFixtures'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from 'tiny-secp256k1'
import { ECPairFactory } from 'ecpair'
import { createHash } from 'crypto'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const network = bitcoin.networks.testnet

describe('Escrow arbiter public-key commitment — real lifecycle + DB-native immutability (Missão 11 Fase 5.2, real Postgres)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  // Missão 11 Fase 6.3B.1 — was a soft skip()-and-console.warn helper
  // (silent false green when Postgres was unreachable); now delegates to
  // the centralized harness, which throws instead.
  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  async function fixtureTrade() {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-${suffix}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-${suffix}` } })
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({
      data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '50000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(acct) },
    })
    const trade = await prisma.trade.create({
      data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '50000', totalUsd: '50' },
    })
    return { buyer, seller, trade }
  }

  function keypair(seed: string) {
    return ECPair.fromPrivateKey(createHash('sha256').update(seed).digest(), { network })
  }

  it('submitParticipantKey() persists the arbiter commitment end-to-end, and it reconstructs the exact stored multisigAddr', async () => {
    requirePostgres('persists + reconstructs')
    const { buyer, seller, trade } = await fixtureTrade()
    const buyerKey = keypair(`buyer-${trade.id}`)
    const sellerKey = keypair(`seller-${trade.id}`)
    const buyerPubkeyHex = Buffer.from(buyerKey.publicKey).toString('hex')
    const sellerPubkeyHex = Buffer.from(sellerKey.publicKey).toString('hex')

    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG' as any, lockedAmount: '0.001', asset: 'BTC' as any }, seller.id)
    expect(escrow.multisigAddr).toBeNull() // client-held-keys pass — no address until both pubkeys arrive

    // Missão 11 Fase 9.1.1 — fail-closed capability declaration required.
    await escrowService.submitParticipantKey(escrow.id, buyer.id, buyerPubkeyHex, MULTISIG_CAPABILITY_PROFILE_V1)
    const { escrow: fundedEscrow } = await escrowService.submitParticipantKey(escrow.id, seller.id, sellerPubkeyHex, MULTISIG_CAPABILITY_PROFILE_V1)

    expect(fundedEscrow.multisigAddr).toMatch(/^tb1/)

    const arbiterRow = await prisma.escrowParticipantKey.findUnique({ where: { escrowId_role: { escrowId: escrow.id, role: 'arbiter' } } })
    expect(arbiterRow).not.toBeNull()
    expect(arbiterRow!.pubkey).toMatch(/^(02|03)[0-9a-f]{64}$/)

    // §5 — reconstruct the address from the three raw, real pubkeys
    // (buyer/seller freshly derived above, arbiter from the persisted
    // commitment just read back) exactly the way a remote wallet would,
    // with zero access to multisigProvider/MULTISIG_SEED.
    const pubkeys = [buyerPubkeyHex, sellerPubkeyHex, arbiterRow!.pubkey].map((hex) => Buffer.from(hex, 'hex')).sort(Buffer.compare)
    const p2ms = bitcoin.payments.p2ms({ m: 2, pubkeys, network })
    const p2wsh = bitcoin.payments.p2wsh({ redeem: p2ms, network })
    expect(p2wsh.address).toBe(fundedEscrow.multisigAddr)

    // §7 — the existing authenticated read surface (zero new routes)
    // exposes the commitment.
    const read = await escrowService.getEscrow(escrow.id)
    const arbiterEntry = read.participantKeys.find((k: { role: string }) => k.role === 'arbiter')
    expect(arbiterEntry).toBeDefined()
    expect(arbiterEntry.publicKeyHex).toBe(arbiterRow!.pubkey)
    expect(read.participantKeys.find((k: { role: string }) => k.role === 'buyer').publicKeyHex).toBe(buyerPubkeyHex)
    expect(read.participantKeys.find((k: { role: string }) => k.role === 'seller').publicKeyHex).toBe(sellerPubkeyHex)
  })

  it('DB-native trigger rejects UPDATE and DELETE of an arbiter row, while a buyer row remains freely mutable', async () => {
    requirePostgres('DB trigger')
    const { buyer, seller, trade } = await fixtureTrade()
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' } })

    const arbiterRow = await prisma.escrowParticipantKey.create({
      data: { escrowId: escrow.id, role: 'arbiter', participantId: 'arb-1', pubkey: `02${'aa'.repeat(32)}` },
    })

    await expect(
      prisma.escrowParticipantKey.update({ where: { id: arbiterRow.id }, data: { pubkey: `03${'bb'.repeat(32)}` } })
    ).rejects.toThrow(/immutable once written/)

    await expect(
      prisma.escrowParticipantKey.delete({ where: { id: arbiterRow.id } })
    ).rejects.toThrow(/immutable and may not be deleted/)

    const buyerRow = await prisma.escrowParticipantKey.create({
      data: { escrowId: escrow.id, role: 'buyer', participantId: buyer.id, pubkey: `02${'cc'.repeat(32)}` },
    })
    await expect(
      prisma.escrowParticipantKey.update({ where: { id: buyerRow.id }, data: { pubkey: `02${'dd'.repeat(32)}` } })
    ).resolves.toBeDefined()
    await expect(prisma.escrowParticipantKey.delete({ where: { id: buyerRow.id } })).resolves.toBeDefined()

    void seller // fixture symmetry only, not otherwise referenced
  })
})

// Missão 11 Fase 5.3 §A/§A.1 — real signature-collection-path proof that
// assertArbiterMatchesScript()'s triggeredBy context (restored by this
// phase's own one-line fix in escrow-pending-tx.ts) and the persisted-
// arbiter-pubkey check (Fase 5.2) both actually fire on the ONLY path
// MULTISIG uses for a real disputed release/refund/split — never a
// hand-built MultisigEscrowInput fixture. Complements
// tests/multisigProvider.test.ts's own unit-level drift-detection suite
// (which proves the LOGIC in isolation) by proving the WIRING.
describe('Signature-collection path — real triggeredBy/arbiter-context defense-in-depth (Missão 11 Fase 5.3, real Postgres)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
  })

  afterEach(() => {
    process.env = { ...BASE_ENV } // undo any per-test env drift (loadEscrowServiceWithSeed)
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  // Missão 11 Fase 6.3B.1 — was a soft skip()-and-console.warn helper
  // (silent false green when Postgres was unreachable); now delegates to
  // the centralized harness, which throws instead.
  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  const RELEASE_ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
  const DEFAULT_ARBITER_ID = 'k6-test-arbiter' // .env's own TRUSTED_ARBITRATORS default

  async function fixtureTrade() {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-${suffix}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-${suffix}` } })
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({
      data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '50000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(acct) },
    })
    const trade = await prisma.trade.create({
      data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '50000', totalUsd: '50' },
    })
    return { buyer, seller, trade }
  }

  function keypair(seed: string) {
    return ECPair.fromPrivateKey(createHash('sha256').update(seed).digest(), { network })
  }

  function mockExplorerFetch(txid: string) {
    const fetchMock = jest.fn()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ txid, vout: 0, value: 100_000, status: { confirmed: true } }] })
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ halfHourFee: 5 }) })
    ;(global as any).fetch = fetchMock
  }

  // Real MULTISIG escrow, funded through the real submitParticipantKey()
  // flow (so it carries a real persisted arbiter commitment — Fase 5.2),
  // then forced DISPUTED with a real funding txid recorded, ready for a
  // real disputed buildUnsignedRelease() call.
  async function fixtureDisputedEscrowWithCommitment(svc: typeof escrowService, arbiterIdForDispute: string) {
    const { buyer, seller, trade } = await fixtureTrade()
    const buyerKey = keypair(`buyer-${trade.id}`)
    const sellerKey = keypair(`seller-${trade.id}`)
    const buyerPubkeyHex = Buffer.from(buyerKey.publicKey).toString('hex')
    const sellerPubkeyHex = Buffer.from(sellerKey.publicKey).toString('hex')

    const escrow = await svc.createEscrow({ tradeId: trade.id, type: 'MULTISIG' as any, lockedAmount: '0.001', asset: 'BTC' as any }, seller.id)
    // Missão 11 Fase 9.1.1 — fail-closed capability declaration required.
    await svc.submitParticipantKey(escrow.id, buyer.id, buyerPubkeyHex, MULTISIG_CAPABILITY_PROFILE_V1)
    await svc.submitParticipantKey(escrow.id, seller.id, sellerPubkeyHex, MULTISIG_CAPABILITY_PROFILE_V1)

    const txid = createHash('sha256').update(escrow.id).digest('hex')
    await prisma.escrow.update({ where: { id: escrow.id }, data: { status: 'DISPUTED', txLockId: txid, txLockVout: 0 } })
    await prisma.dispute.create({
      data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'fixture', arbiterId: arbiterIdForDispute },
    })
    return { escrow, buyer, seller, trade, txid }
  }

  it('1. correct arbiter context (triggeredBy matches both the assigned dispute AND the persisted commitment) -> accepted', async () => {
    requirePostgres('correct context accepted')
    const { escrow, buyer, txid } = await fixtureDisputedEscrowWithCommitment(escrowService, DEFAULT_ARBITER_ID)
    mockExplorerFetch(txid)

    const pending = await escrowService.initiateRelease(escrow.id, RELEASE_ADDR, DEFAULT_ARBITER_ID)
    expect(pending.requiredSigners).toEqual([buyer.id])
  })

  it('2. wrong triggeredBy arbiter (assigned to the dispute, but not the identity baked into the script) -> rejected', async () => {
    requirePostgres('wrong triggeredBy rejected')
    // A different arbiter is genuinely ASSIGNED to this dispute (passes
    // isSellerOrAssignedArbiter's own authorization check against the
    // real Dispute row) but is not TRUSTED_ARBITRATORS[0] — the single
    // identity whose key is actually baked into this escrow's script.
    // Before this phase's fix, escrow.triggeredBy was never threaded to
    // the provider, so assertArbiterMatchesScript()'s identity check was
    // silently unreachable and this call would have wrongly succeeded.
    const { escrow, txid } = await fixtureDisputedEscrowWithCommitment(escrowService, 'a-different-assigned-arbiter')

    await expect(
      escrowService.initiateRelease(escrow.id, RELEASE_ADDR, 'a-different-assigned-arbiter')
    ).rejects.toThrow(/does not match the arbiter public key committed/)
    void txid // fetch is never reached — confirms the rejection happens before any network call
  })

  it('3/4. correct triggeredBy identity, but the persisted commitment no longer matches live config (MULTISIG_SEED drifted since creation) -> rejected', async () => {
    requirePostgres('persisted pubkey mismatch rejected')
    // Commitment established under the file's baseline seed.
    const { escrow, txid } = await fixtureDisputedEscrowWithCommitment(escrowService, DEFAULT_ARBITER_ID)

    // A SEPARATE escrowService instance, as if a later deployment rotated
    // MULTISIG_SEED (same TRUSTED_ARBITRATORS identity) — triggeredBy
    // correctly names today's one configured arbiter, so the OLD identity
    // check alone would wrongly pass; the persisted-pubkey check (Fase
    // 5.2) is what must catch this.
    const driftedEscrowService = loadEscrowServiceWithSeed('fase-5-3-drifted-seed')
    mockExplorerFetch(txid)

    await expect(
      driftedEscrowService.initiateRelease(escrow.id, RELEASE_ADDR, DEFAULT_ARBITER_ID)
    ).rejects.toThrow(/does not match the arbiter public key committed/)
  })

  it('5. legacy escrow (no persisted arbiter commitment) under a disputed release -> rejected outright (Missão 11 Fase 9.3 §4 — no persisted commitment = not eligible for real MULTISIG settlement)', async () => {
    requirePostgres('legacy escrow rejected, not silently accepted')
    // Simulates a pre-Fase-5.2 escrow: buyer/seller keys persisted
    // directly (bypassing submitParticipantKey()'s auto-commitment write,
    // which does not exist for a genuinely historical row), no
    // role='arbiter' row created at all.
    //
    // Missão 11 Fase 9.3 §4 (independently-reproduced red-team finding,
    // Kimi K3 R1 MULTI-01) — this used to fall back to a plain
    // identity-string check against live config ("compatibility path
    // preserved"); that fallback was removed since production never
    // launched (no real escrow anywhere is legacy-shaped) and it let a
    // future TRUSTED_ARBITRATORS/MULTISIG_SEED change silently redefine
    // what an uncommitted escrow's script means. This test now proves the
    // opposite of its original name: the legacy shape is REJECTED, not
    // preserved.
    const { buyer, seller, trade } = await fixtureTrade()
    const buyerKey = keypair(`legacy-buyer-${trade.id}`)
    const sellerKey = keypair(`legacy-seller-${trade.id}`)
    const buyerPubkeyHex = Buffer.from(buyerKey.publicKey).toString('hex')
    const sellerPubkeyHex = Buffer.from(sellerKey.publicKey).toString('hex')
    const txid = createHash('sha256').update(`legacy-${trade.id}`).digest('hex')

    const escrow = await prisma.escrow.create({
      data: { tradeId: trade.id, type: 'MULTISIG', status: 'DISPUTED', lockedAmount: '0.001', asset: 'BTC', txLockId: txid, txLockVout: 0 },
    })
    await prisma.escrowParticipantKey.create({ data: { escrowId: escrow.id, role: 'buyer', participantId: buyer.id, pubkey: buyerPubkeyHex } })
    await prisma.escrowParticipantKey.create({ data: { escrowId: escrow.id, role: 'seller', participantId: seller.id, pubkey: sellerPubkeyHex } })
    await prisma.dispute.create({ data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'fixture', arbiterId: DEFAULT_ARBITER_ID } })

    const arbiterRow = await prisma.escrowParticipantKey.findUnique({ where: { escrowId_role: { escrowId: escrow.id, role: 'arbiter' } } })
    expect(arbiterRow).toBeNull() // confirms this fixture is genuinely legacy-shaped

    mockExplorerFetch(txid)
    await expect(
      escrowService.initiateRelease(escrow.id, RELEASE_ADDR, DEFAULT_ARBITER_ID)
    ).rejects.toThrow(/no persisted arbiter public-key commitment/)

    const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: escrow.id } })
    expect(pending).toBeNull()
  })

  it('6. happy path: non-disputed release (ordinary buyer+seller signing) is unaffected by the triggeredBy threading fix', async () => {
    requirePostgres('happy path unaffected')
    const { buyer, seller, trade } = await fixtureTrade()
    const buyerKey = keypair(`hp-buyer-${trade.id}`)
    const sellerKey = keypair(`hp-seller-${trade.id}`)
    const buyerPubkeyHex = Buffer.from(buyerKey.publicKey).toString('hex')
    const sellerPubkeyHex = Buffer.from(sellerKey.publicKey).toString('hex')

    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG' as any, lockedAmount: '0.001', asset: 'BTC' as any }, seller.id)
    // Missão 11 Fase 9.1.1 — fail-closed capability declaration required.
    await escrowService.submitParticipantKey(escrow.id, buyer.id, buyerPubkeyHex, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, sellerPubkeyHex, MULTISIG_CAPABILITY_PROFILE_V1)

    const txid = createHash('sha256').update(`hp-${escrow.id}`).digest('hex')
    await prisma.escrow.update({ where: { id: escrow.id }, data: { status: 'PAYMENT_PENDING', txLockId: txid, txLockVout: 0 } })
    mockExplorerFetch(txid)

    const pending = await escrowService.initiateRelease(escrow.id, RELEASE_ADDR, seller.id)
    expect(pending.requiredSigners).toEqual([buyer.id, seller.id])
  })
})
