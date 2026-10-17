// tests/integration/buyerPayoutAuthority.test.ts
//
// #235 R7G NF-B1 — buyer payout authority and AUTO_SETTLE_ON_MATCH on real PostgreSQL.
//
// NF-B1: the legacy buyer "receiving account" (buyerIndexFor(): sha256('buyer:' + id) % (2^31-1) under the Sails
// seed) collides between distinct buyers and is held by the server, not the buyer. Proven here:
//   - the collision, with the repository's own function;
//   - no settlement path derives that account any more: AUTO_SETTLE_ON_MATCH (which acted for both parties - LOCK as
//     the seller, "payment sent" as the buyer, release on an emulated PIX confirmation) is refused on every
//     value-moving rail before any escrow, LOCK, claim, event or broadcast;
//   - every WDK release pays the buyer's registered payout address, frozen once the obligation is recorded
//     (PREPARED): later payout changes, crashes, fresh nodes and concurrent recoverers never redirect it, and the
//     database refuses a rewritten destination;
//   - a legacy transfer() release to an address that is not the buyer's registered payout fails closed.
//
// Boundaries as in wdkOutboundAuthority.test.ts: a fake WalletManager signs with the real ethers HD wallet of the
// same mnemonic and paths; wdk-rpc.ts is served by the in-memory chain double with native gas accounting.

const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
process.env.WDK_SEED_PHRASE = TEST_MNEMONIC
process.env.WDK_CHAIN_ID = '31337'
process.env.WDK_FINALITY_CONFIRMATIONS = '2' // explicit TEST policy
process.env.WDK_USDT_CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
process.env.WDK_RECEIPT_POLL_ATTEMPTS = '6'
process.env.WDK_RECEIPT_POLL_INTERVAL_MS = '1'
process.env.WDK_RPC_URL = 'http://primary.wdk.test:8545'
process.env.WDK_CORROBORATING_RPC_URL = 'http://corroborator.wdk.test:8545'
process.env.WDK_OUTBOUND_MAX_GAS_LIMIT = '100000' // explicit TEST gas policy
process.env.WDK_OUTBOUND_MAX_FEE_PER_GAS_WEI = '5000000000'
process.env.AUTO_SETTLE_ON_MATCH = 'true'
process.env.MOCK_ESCROW = 'false'

import { WdkChainDouble } from '../helpers/wdkChainDouble'

const mockState: { chain: WdkChainDouble | null; transferCalls: number } = { chain: null, transferCalls: 0 }
jest.mock('../../src/modules/open-settlement/wdk-rpc', () => ({
  createWdkRpc: (url: string) => new Proxy({}, {
    get: (_t, method: string) => method === 'then' ? undefined : (...args: unknown[]) =>
      ((url.includes('corroborator') ? mockState.chain!.corroboratorRpc() : mockState.chain!.rpc()) as any)[method](...args),
  }),
}))
jest.mock('@tetherto/wdk-wallet-evm', () => {
  const { HDNodeWallet } = require('ethers')
  const account = (path: string) => {
    const w = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, `m/44'/60'/${path}`)
    return {
      getAddress: async () => w.address,
      signTransaction: async (tx: any) => w.signTransaction(tx),
      transfer: async () => { mockState.transferCalls++; throw new Error('WDK transfer() must never be used') },
      sendTransaction: async () => { mockState.transferCalls++; throw new Error('WDK sendTransaction() must never be used') },
      getTransactionReceipt: async () => ({ status: 1 }), // read by the legacy read-only reconciliation
    }
  }
  return { __esModule: true, default: class { async getAccount(i: number) { return account(`0'/0/${i}`) } async getAccountByPath(p: string) { return account(p) } } }
})

import { PrismaClient } from '@prisma/client'
import { HDNodeWallet, Wallet } from 'ethers'
import { randomBytes } from 'crypto'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const TREASURY = HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, "m/44'/60'/0'/0/0").address
const TOKEN = process.env.WDK_USDT_CONTRACT as string
// Two distinct buyer ids whose legacy buyerIndexFor() accounts collide (found with the repository's function).
const COLLIDING = ['493b01eb-249d-4b4e-925a-c349ed124956', '3cd92598-a6fd-4900-9b8b-1692153c9468']

type Node = { prisma: PrismaClient; escrowService: any; reconcileEscrow: any; outbound: any; payout: any; orchestrator: any }

describe('#235 R7G NF-B1 — buyer payout authority / AUTO_SETTLE_ON_MATCH (real PostgreSQL)', () => {
  jest.setTimeout(300_000)
  const pg = createPostgresIntegrationHarness()
  let A: Node
  let prisma: PrismaClient
  let chain: WdkChainDouble
  let autoSettle: (payload: unknown) => Promise<void>
  const extra: Array<{ redis?: { quit(): Promise<unknown> } }> = []
  let lanes: string[] = []
  let testEscrows: string[] = []

  function load(isolated: boolean): Node {
    let n!: Node
    const body = () => {
      n = {
        prisma: require('../../src/common/database').prisma,
        escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService,
        reconcileEscrow: require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcileWdkOutboundEscrow,
        outbound: require('../../src/modules/open-settlement/wdk-outbound-authority'),
        payout: require('../../src/modules/open-settlement/payout-address.service').payoutAddressService,
        orchestrator: require('../../src/modules/open-settlement/settlement-orchestrator'),
      }
      if (isolated) extra.push({ redis: require('../../src/common/redis').redis })
    }
    if (isolated) jest.isolateModules(body); else body()
    return n
  }
  const node = () => load(true)

  const GUARDS: Array<[string, string]> = [
    ['wdk_transfer_attempts', 'wdk_transfer_attempts_signed_identity_guard'], ['wdk_nonce_lanes', 'wdk_nonce_lanes_guard'],
    ['wdk_lane_halts', 'wdk_lane_halts_governance_guard'], ['wdk_lane_audit', 'wdk_lane_audit_append_only_guard'],
  ]
  async function withTriggersOff(fn: (tx: any) => Promise<void>) {
    await prisma.$transaction(async (tx) => {
      for (const [t, g] of GUARDS) await tx.$executeRawUnsafe(`ALTER TABLE ${t} DISABLE TRIGGER ${g}`)
      await fn(tx)
      for (const [t, g] of GUARDS) await tx.$executeRawUnsafe(`ALTER TABLE ${t} ENABLE TRIGGER ${g}`)
    })
  }
  const resetLanes = () => withTriggersOff(async (tx) => {
    const accounts = [TREASURY, ...lanes]
    await tx.$executeRaw`DELETE FROM wdk_lane_halts WHERE "chainId" = 31337 AND account = ANY(${accounts})`
    await tx.$executeRaw`DELETE FROM wdk_lane_audit WHERE "chainId" = 31337 AND account = ANY(${accounts})`
    await tx.$executeRaw`DELETE FROM wdk_nonce_lanes WHERE "chainId" = 31337 AND account = ANY(${accounts})`
  })

  /** Removes every row this suite owns (users named nfb1-*, including the fixed colliding ids). */
  async function cleanup() {
    const users = (await prisma.user.findMany({ where: { OR: [{ displayName: { startsWith: 'nfb1-' } }, { id: { in: COLLIDING } }] }, select: { id: true } })).map((u) => u.id)
    const tradeIds = (await prisma.trade.findMany({ where: { OR: [{ buyerId: { in: users } }, { sellerId: { in: users } }] }, select: { id: true } })).map((t) => t.id)
    const escrows = (await prisma.escrow.findMany({ where: { tradeId: { in: tradeIds } }, select: { id: true } })).map((e) => e.id)
    await withTriggersOff(async (tx) => {
      await tx.$executeRaw`DELETE FROM wdk_transfer_attempts WHERE "escrowId" = ANY(${escrows}) AND "operationType" = 'GAS_FUNDING'`
      await tx.$executeRaw`DELETE FROM wdk_transfer_attempts WHERE "escrowId" = ANY(${escrows})`
    })
    const events = (await prisma.escrowEvent.findMany({ where: { escrowId: { in: escrows } }, select: { id: true } })).map((e) => e.id)
    await prisma.$executeRaw`DELETE FROM event_projection_claims WHERE "subjectId" = ANY(${tradeIds}) OR "subjectId" = ANY(${escrows}) OR "subjectId" = ANY(${events}) OR "eventId" = ANY(${events})`
    await prisma.durableEventRecord.deleteMany({ where: { correlationId: { in: tradeIds } } })
    const refs = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('tradeId', 'escrowId') AND table_name NOT IN ('trades', 'escrows')`
    for (let pass = 0; pass < 3; pass++) {
      for (const { table_name, column_name } of refs) {
        await prisma.$executeRawUnsafe(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1)`, column_name === 'tradeId' ? tradeIds : escrows).catch(() => undefined)
      }
    }
    await prisma.$executeRaw`UPDATE trades SET "escrowId" = NULL WHERE id = ANY(${tradeIds})`
    await prisma.$executeRaw`DELETE FROM escrows WHERE id = ANY(${escrows})`
    await prisma.$executeRaw`DELETE FROM trades WHERE id = ANY(${tradeIds})`
    await prisma.$executeRaw`DELETE FROM offers WHERE "userId" = ANY(${users})`
    await prisma.$executeRaw`DELETE FROM payout_addresses WHERE "participantId" = ANY(${users})`
    await prisma.$executeRaw`DELETE FROM users WHERE id = ANY(${users})`
  }

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    A = load(false)
    prisma = A.prisma
    // The real openp2p.trade.created handler, captured as registered (awaited directly - no sleeps).
    const { eventBus } = require('../../src/common/events/event-bus')
    const on = jest.spyOn(eventBus, 'on')
    require('../../src/common/events/handlers').registerEventHandlers()
    autoSettle = on.mock.calls.filter(([event]) => event === 'openp2p.trade.created').map(([, listener]) => listener as any).pop()
    on.mockRestore()
    await cleanup()
    await resetLanes()
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    try {
      await cleanup()
      await resetLanes()
    } finally {
      for (const n of extra) await n.redis?.quit().catch(() => undefined)
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  beforeEach(async () => {
    if (!pg.isAvailable()) return
    chain = new WdkChainDouble(TOKEN)
    chain.gasAccounting = true
    chain.fund(TREASURY, 10n ** 15n)
    chain.fundNative(TREASURY, 10n ** 19n)
    // A fast-finality network: blocks arrive while a call polls for its receipt, so the live path runs end to end.
    chain.hooks.receipt = (h: string) => { if (!(chain as any).mined.has(h)) chain.mine(3); return undefined }
    mockState.chain = chain
    mockState.transferCalls = 0
    testEscrows = []
    await resetLanes()
  })

  afterEach(async () => {
    if (!pg.isAvailable()) return
    expect(mockState.transferCalls).toBe(0)
    await cleanup() // every test owns its rows, including the fixed colliding buyer ids
  })

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────────────

  const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (err: Error) => ({ ok: false as const, err: String(err.message) }))
  const evm = () => Wallet.createRandom().address

  /** A matched trade (no escrow yet) whose buyer has a registered USDT payout address. */
  async function matched(label: string, buyerId?: string) {
    const tag = randomBytes(4).toString('hex')
    const buyer = await prisma.user.create({ data: { ...(buyerId ? { id: buyerId } : {}), publicKey: randomBytes(32).toString('hex'), displayName: `nfb1-${label}-b-${tag}` } })
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `nfb1-${label}-s-${tag}` } })
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'USDT_ERC20', side: 'SELL', priceUsd: '1', minAmount: '0.00000001', maxAmount: '100000', paymentMethod: 'PIX' } })
    const t = await prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'USDT_ERC20', amount: '5', priceUsd: '1', totalUsd: '5', status: 'ACTIVE' } })
    const buyerPayout = evm()
    await A.payout.setPayoutAddress(buyer.id, 'USDT_ERC20', buyerPayout)
    return { t, buyer, seller, buyerPayout }
  }
  type M = Awaited<ReturnType<typeof matched>>
  /** The same trade, escrowed and funded through the normal seller path (FUNDS_LOCKED), then payment claimed by the buyer. */
  async function paymentPending(m: M) {
    const e = await A.escrowService.createEscrow({ tradeId: m.t.id, type: 'WDK_USDT_EVM', asset: 'USDT_ERC20', lockedAmount: '5' }, m.seller.id)
    testEscrows.push(e.id)
    const account = HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, `m/44'/60'/${e.wdkAccountPath}`).address
    lanes.push(account)
    const locked = await settle(A.escrowService.lockFunds(e.id, m.seller.id))
    if (!locked.ok) throw new Error(`fixture lock failed: ${locked.err}`)
    await A.escrowService.markPaymentSent(e.id, m.buyer.id)
    return { e, account }
  }
  const escrowOfTrade = (m: M) => prisma.escrow.findFirst({ where: { tradeId: m.t.id } })
  const legs = (escrowId: string) => prisma.wdkTransferAttempt.findMany({ where: { escrowId, operationType: { in: ['RELEASE', 'REFUND', 'SPLIT_BUYER', 'SPLIT_SELLER'] } }, orderBy: { createdAt: 'asc' } })
  const fundings = (escrowId: string) => prisma.wdkTransferAttempt.count({ where: { escrowId, operationType: 'GAS_FUNDING' } })
  const events = (escrowId: string, to: string) => prisma.escrowEvent.count({ where: { escrowId, toStatus: to as any } })
  async function converge(escrowId: string, n: Node = A, rounds = 6) {
    for (let i = 0; i < rounds; i++) {
      chain.mine(2)
      await n.reconcileEscrow(escrowId)
      if ((await prisma.escrow.findUniqueOrThrow({ where: { id: escrowId } })).txReleaseId) return
    }
  }

  // ── NF-B1: the collision and its reachability ───────────────────────────────────────────────────────

  it('NF1/NF6: two distinct buyers share one legacy buyer account, and no source file but the provider and the read-only preflight derives it', async () => {
    const { buyerIndexFor, wdkSettlementProvider } = require('../../src/modules/open-settlement/wdk-settlement.provider')
    expect(COLLIDING[0]).not.toBe(COLLIDING[1])
    expect(buyerIndexFor(COLLIDING[0])).toBe(buyerIndexFor(COLLIDING[1]))
    expect(await wdkSettlementProvider.getAccountAddress(buyerIndexFor(COLLIDING[0]))).toBe(await wdkSettlementProvider.getAccountAddress(buyerIndexFor(COLLIDING[1])))
    // mechanical reachability: every source reference to the legacy buyer derivation, and every use of a raw 0'/0/<i> account
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : [])
    const root = join(__dirname, '../..')
    const sources = [...files(join(root, 'src')), ...files(join(root, 'scripts')), ...files(join(root, 'examples'))]
    const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    const derive = sources.filter((f) => /buyerIndexFor\s*\(/.test(code(f))).map((f) => f.slice(root.length + 1).replace(/\\/g, '/'))
    expect(derive).toEqual(['src/modules/open-settlement/wdk-settlement.provider.ts']) // its definition only
    const rawAccount = sources.flatMap((f) => [...code(f).matchAll(/getAccountAddress\(([^)]*)\)/g)].map((m) => `${f.slice(root.length + 1).replace(/\\/g, '/')}:${m[1]}`))
    expect(rawAccount.filter((r) => !r.includes('wdk-settlement.provider.ts'))).toEqual(['src/modules/open-settlement/escrow-settlement-reconciliation.service.ts:0']) // the treasury only
  })

  it('NF8/C1/C9: AUTO_SETTLE_ON_MATCH for two colliding buyers at once — refused before any escrow, LOCK, claim, event or broadcast', async () => {
    pg.requirePostgres('auto-settle')
    const [a, b] = [await matched('as-a', COLLIDING[0]), await matched('as-b', COLLIDING[1])]
    const payload = (m: M) => ({ tradeId: m.t.id, offerId: m.t.offerId, buyerId: m.buyer.id, sellerId: m.seller.id, asset: 'USDT_ERC20', amount: '5', priceUsd: '1' })
    // the real handler, both trades at once, plus a direct call per trade (the demo / any other caller)
    await Promise.all([autoSettle(payload(a)), autoSettle(payload(b))])
    for (const m of [a, b]) {
      const direct = await settle(A.orchestrator.executeSettlement({ tradeId: m.t.id }))
      expect(direct).toEqual({ ok: false, err: expect.stringMatching(/runs only on the MOCK rail.*never moves value on WDK_USDT_EVM.*Nothing was executed/) })
      expect(await escrowOfTrade(m)).toBeNull()
    }
    expect(chain.sendCalls).toEqual([])
    expect(await prisma.wdkTransferAttempt.count({ where: { escrow: { tradeId: { in: [a.t.id, b.t.id] } } } })).toBe(0)
    // a value rail chosen explicitly is refused the same way
    for (const escrowType of ['MULTISIG', 'WDK_USDT_EVM', 'LIGHTNING_HODL', 'SAFE_GUARD_EVM']) {
      expect((await settle(A.orchestrator.executeSettlement({ tradeId: a.t.id, escrowType })) as any).err).toMatch(new RegExp(`never moves value on ${escrowType}`))
    }
    expect(await escrowOfTrade(a)).toBeNull()
  })

  it('NF2/NF13: a WDK release pays the buyer\'s registered payout — a caller-supplied destination (the legacy buyer account included) is refused', async () => {
    pg.requirePostgres('destination')
    const m = await matched('dest', COLLIDING[0])
    const { e } = await paymentPending(m)
    const { buyerIndexFor, wdkSettlementProvider } = require('../../src/modules/open-settlement/wdk-settlement.provider')
    const legacy = await wdkSettlementProvider.getAccountAddress(buyerIndexFor(m.buyer.id))
    expect((await settle(A.escrowService.releaseFunds(e.id, legacy, m.seller.id)) as any).err).toMatch(/caller-supplied destination is refused/)
    expect([(await prisma.escrow.findUniqueOrThrow({ where: { id: e.id } })).status, await legs(e.id)]).toEqual(['PAYMENT_PENDING', []])
    expect((await settle(A.escrowService.releaseFunds(e.id, undefined, m.seller.id))).ok).toBe(true)
    const [leg] = await legs(e.id)
    expect([leg.destination, leg.status, chain.balance(m.buyerPayout), chain.balance(legacy)]).toEqual([m.buyerPayout, 'CONFIRMED', 5_000_000n, 0n])
  })

  // ── payout authority: frozen at the recorded obligation ─────────────────────────────────────────────

  it('NF3/NF4/NF9/R9/R10/R11: the payout changed after the obligation is recorded — a crash, three recoverers and the stalled live call all pay the frozen destination', async () => {
    pg.requirePostgres('payout frozen')
    const m = await matched('frz')
    const { e, account } = await paymentPending(m)
    const original = m.buyerPayout
    // the live call stalls right after its claim (the process "dies" there)
    let resume!: () => void
    const gate = new Promise<void>((r) => { resume = r })
    const real = A.outbound.settleWdkOutbound
    const spy = jest.spyOn(A.outbound, 'settleWdkOutbound').mockImplementation(async (...args: unknown[]) => { await gate; return (real as any)(...args) })
    const live = settle(A.escrowService.releaseFunds(e.id, undefined, m.seller.id))
    for (let i = 0; i < 100 && (await prisma.escrow.findUniqueOrThrow({ where: { id: e.id } })).status !== 'COMPLETED'; i++) await new Promise((r) => setTimeout(r, 20))
    // fresh nodes recover concurrently (R1 recording from durable authority), then the buyer changes the payout
    await Promise.all([node().reconcileEscrow(e.id), node().reconcileEscrow(e.id), A.reconcileEscrow(e.id)])
    expect((await legs(e.id)).map((l) => l.destination)).toEqual([original])
    const moved = evm()
    await A.payout.setPayoutAddress(m.buyer.id, 'USDT_ERC20', moved)
    resume()
    await live
    spy.mockRestore()
    await converge(e.id, node())
    const final = await legs(e.id)
    expect([final.length, final[0].destination, final[0].status, await fundings(e.id), await events(e.id, 'COMPLETED')]).toEqual([1, original, 'CONFIRMED', 1, 1])
    expect([chain.balance(original), chain.balance(moved), chain.balance(account)]).toEqual([5_000_000n, 0n, 0n]) // NF11
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: e.id } })).txReleaseId).toBe(final[0].txHash)
  })

  it('NF14: the database refuses a rewritten destination — PREPARED and SIGNED legs', async () => {
    pg.requirePostgres('db destination')
    const m = await matched('db')
    const { e } = await paymentPending(m)
    // PREPARED: the obligation recorded directly, nothing signed yet
    await prisma.escrow.update({ where: { id: e.id }, data: { status: 'COMPLETED' } })
    const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: e.id } })
    await A.outbound.prepareWdkOutbound(escrow, [{ operationType: 'RELEASE', destination: m.buyerPayout, amount: '5' }])
    const [prepared] = await legs(e.id)
    expect(prepared.status).toBe('PREPARED')
    const refuse = /immutable|frozen/
    await expect(prisma.$executeRawUnsafe(`UPDATE wdk_transfer_attempts SET destination = $1 WHERE id = $2`, evm(), prepared.id)).rejects.toThrow(refuse)
    await expect(prisma.$executeRawUnsafe(`UPDATE wdk_transfer_attempts SET amount = 4 WHERE id = $1`, prepared.id)).rejects.toThrow(refuse)
    // SIGNED: driven by reconciliation, then rewritten by raw SQL
    chain.hooks.receipt = undefined // nothing mines: the leg stays signed
    await A.reconcileEscrow(e.id)
    const [signed] = await legs(e.id)
    expect(['SIGNED', 'SUBMITTED']).toContain(signed.status)
    await expect(prisma.$executeRawUnsafe(`UPDATE wdk_transfer_attempts SET destination = $1 WHERE id = $2`, evm(), signed.id)).rejects.toThrow(refuse)
    await expect(prisma.$executeRawUnsafe(`DELETE FROM wdk_transfer_attempts WHERE id = $1`, signed.id)).rejects.toThrow(/cannot be deleted|immutable/)
    // a competing family next to it is refused too
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO wdk_transfer_attempts (id, "escrowId", "operationType", destination, amount, authority, "chainId", "fromAddress", "tokenContract", status, "updatedAt") VALUES (gen_random_uuid()::text, $1, 'REFUND', $2, 5, 'SIGNED_RAW_V1', 31337, $3, $4, 'PREPARED', now())`,
      e.id, TREASURY, signed.fromAddress, TOKEN,
    )).rejects.toThrow(/already has an economic/)
  })

  it('C8: a payout update racing the release — exactly one leg, paid to the destination it froze', async () => {
    pg.requirePostgres('payout race')
    const m = await matched('race')
    const { e } = await paymentPending(m)
    const moved = evm()
    await Promise.all([settle(A.escrowService.releaseFunds(e.id, undefined, m.seller.id)), A.payout.setPayoutAddress(m.buyer.id, 'USDT_ERC20', moved)])
    await converge(e.id)
    const final = await legs(e.id)
    expect(final).toHaveLength(1)
    expect([m.buyerPayout, moved]).toContain(final[0].destination)
    const other = final[0].destination === moved ? m.buyerPayout : moved
    expect([chain.balance(final[0].destination), chain.balance(other), await events(e.id, 'COMPLETED')]).toEqual([5_000_000n, 0n, 1])
  })

  it('C2: the auto-settle path racing the seller\'s own release — the release is the only economic movement', async () => {
    pg.requirePostgres('auto vs manual')
    const m = await matched('c2')
    const { e } = await paymentPending(m)
    const payload = { tradeId: m.t.id, offerId: m.t.offerId, buyerId: m.buyer.id, sellerId: m.seller.id, asset: 'USDT_ERC20', amount: '5', priceUsd: '1' }
    const [, manual] = await Promise.all([autoSettle(payload), settle(A.escrowService.releaseFunds(e.id, undefined, m.seller.id))])
    expect(manual.ok).toBe(true)
    expect([(await legs(e.id)).length, await events(e.id, 'COMPLETED'), chain.balance(m.buyerPayout)]).toEqual([1, 1, 5_000_000n])
    expect(await prisma.escrow.count({ where: { tradeId: m.t.id } })).toBe(1)
  })

  // ── legacy ──────────────────────────────────────────────────────────────────────────────────────────

  it('NF15: a legacy transfer() release to an address that is not the buyer\'s registered payout fails closed — no result written', async () => {
    pg.requirePostgres('legacy destination')
    const m = await matched('leg', COLLIDING[1])
    const e = await A.escrowService.createEscrow({ tradeId: m.t.id, type: 'WDK_USDT_EVM', asset: 'USDT_ERC20', lockedAmount: '5' }, m.seller.id)
    testEscrows.push(e.id)
    const { buyerIndexFor, wdkSettlementProvider } = require('../../src/modules/open-settlement/wdk-settlement.provider')
    const legacy = await wdkSettlementProvider.getAccountAddress(buyerIndexFor(m.buyer.id))
    await prisma.escrow.update({ where: { id: e.id }, data: { status: 'COMPLETED' } })
    await prisma.wdkTransferAttempt.create({ data: { escrowId: e.id, operationType: 'RELEASE', status: 'CONFIRMED', destination: legacy, amount: '5', txHash: `0x${randomBytes(32).toString('hex')}` } })
    const report = await require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered.filter((r: any) => r.escrowId === e.id)).toEqual([])
    expect(report.requiresManualReview.some((r: any) => r.escrowId === e.id)).toBe(true)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: e.id } })).txReleaseId).toBeNull()
    expect(await prisma.wdkTransferAttempt.count({ where: { escrowId: e.id, authority: 'SIGNED_RAW_V1' } })).toBe(0) // nothing new is signed for it
    // the read-only preflight names it for manual review
    const { runWdkLockPreflight } = require('../../scripts/wdk-lock-authority-preflight')
    const preflight = await runWdkLockPreflight(process.env.DATABASE_URL, { ...process.env })
    expect(preflight.findings.filter((f: any) => f.kind === 'LEGACY_OUTBOUND_UNREGISTERED_DESTINATION' && f.detail.escrowId === e.id).map((f: any) => [f.detail.destination, f.detail.registeredPayout]))
      .toEqual([[legacy, m.buyerPayout]])
  })
})
