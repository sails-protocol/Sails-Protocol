// tests/integration/wdkOutboundAuthority.test.ts
//
// #235 R7G-F6C — WDK outbound settlement (RELEASE / REFUND / SPLIT) on real PostgreSQL: the obligation frozen
// before anything is signed, each leg signed by the escrow's own account from its nonce lane and persisted before
// broadcast, gas funded once per leg by a signed treasury transaction that is final before the leg is broadcast,
// corroborated terminal truth, DF1 (no revert / no transaction B once signed), the split's leg order, reconciliation
// from durable state, multi-node convergence, conservation, and the database's refusals.
//
// Boundaries as in wdkSignedLockAuthority.test.ts: a fake WalletManager signs with the real ethers HD wallet of
// the same mnemonic and paths; wdk-rpc.ts is served by the in-memory chain double, here with native gas accounting.

const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
process.env.WDK_SEED_PHRASE = TEST_MNEMONIC
process.env.WDK_CHAIN_ID = '31337'
process.env.WDK_FINALITY_CONFIRMATIONS = '2' // explicit TEST policy
process.env.WDK_USDT_CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
process.env.WDK_RECEIPT_POLL_ATTEMPTS = '1'
process.env.WDK_RECEIPT_POLL_INTERVAL_MS = '1'
process.env.WDK_RPC_URL = 'http://primary.wdk.test:8545'
process.env.WDK_CORROBORATING_RPC_URL = 'http://corroborator.wdk.test:8545'
process.env.WDK_OUTBOUND_MAX_GAS_LIMIT = '100000' // explicit TEST gas policy
process.env.WDK_OUTBOUND_MAX_FEE_PER_GAS_WEI = '5000000000'

import { WdkChainDouble } from '../helpers/wdkChainDouble'

const mockState: { chain: WdkChainDouble | null; transferCalls: number; sendTransactionCalls: number } = { chain: null, transferCalls: 0, sendTransactionCalls: 0 }
jest.mock('../../src/modules/open-settlement/wdk-rpc', () => ({
  createWdkRpc: (url: string) => new Proxy({}, {
    // not a thenable: an awaited RPC client must stay the client
    get: (_t, method: string) => method === 'then' ? undefined : (...args: unknown[]) =>
      ((url.includes('corroborator') ? mockState.chain!.corroboratorRpc() : mockState.chain!.rpc()) as any)[method](...args),
  }),
}))
jest.mock('@tetherto/wdk-wallet-evm', () => {
  const { HDNodeWallet } = require('ethers')
  const wallets = new Map<string, any>()
  const wallet = (path: string) => {
    if (!wallets.has(path)) wallets.set(path, HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, `m/44'/60'/${path}`))
    return wallets.get(path)
  }
  const account = (path: string) => ({
    getAddress: async () => wallet(path).address,
    signTransaction: async (tx: any) => wallet(path).signTransaction(tx),
    transfer: async () => { mockState.transferCalls++; throw new Error('WDK transfer() must never be used') },
    sendTransaction: async () => { mockState.sendTransactionCalls++; throw new Error('WDK sendTransaction() must never be used') },
    getTransactionReceipt: async () => null,
  })
  return {
    __esModule: true,
    default: class FakeWalletManagerEvm {
      async getAccount(i: number) { return account(`0'/0/${i}`) }
      async getAccountByPath(p: string) { return account(p) }
    },
  }
})

import { PrismaClient } from '@prisma/client'
import { HDNodeWallet, Transaction, Wallet } from 'ethers'
import { randomBytes } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const TREASURY = HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, "m/44'/60'/0'/0/0").address
const TOKEN = process.env.WDK_USDT_CONTRACT as string
const OUTBOUND = ['RELEASE', 'REFUND', 'SPLIT_BUYER', 'SPLIT_SELLER'] as const

type Node = { prisma: PrismaClient; escrowService: any; reconcileEscrow: any; reconcile: any; outbound: any; config: any; redis?: { quit(): Promise<unknown> } }

describe('#235 R7G-F6C — WDK outbound settlement authority (real PostgreSQL)', () => {
  jest.setTimeout(300_000)
  const pg = createPostgresIntegrationHarness()
  let A: Node
  let prisma: PrismaClient
  let extra: Node[] = []
  let chain: WdkChainDouble

  function load(isolated: boolean): Node {
    let n!: Node
    const body = () => {
      n = {
        prisma: require('../../src/common/database').prisma,
        escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService,
        reconcileEscrow: require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcileWdkOutboundEscrow,
        reconcile: require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements,
        outbound: require('../../src/modules/open-settlement/wdk-outbound-authority'),
        config: require('../../src/config').config,
        redis: isolated ? require('../../src/common/redis').redis : undefined,
      }
    }
    if (isolated) jest.isolateModules(body); else body()
    return n
  }
  const node = () => { const n = load(true); extra.push(n); return n }

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
  // Test-owned lanes: chain 31337, the test mnemonic's treasury and this suite's escrow accounts.
  let lanes: string[] = []
  // Every test's attempts are removed after it: a later test's fresh chain reuses the same treasury nonces.
  let testEscrows: string[] = []
  const resetLanes = () => withTriggersOff(async (tx) => {
    const accounts = [TREASURY, ...lanes]
    await tx.$executeRaw`DELETE FROM wdk_lane_halts WHERE "chainId" = 31337 AND account = ANY(${accounts})`
    await tx.$executeRaw`DELETE FROM wdk_lane_audit WHERE "chainId" = 31337 AND account = ANY(${accounts})`
    await tx.$executeRaw`DELETE FROM wdk_nonce_lanes WHERE "chainId" = 31337 AND account = ANY(${accounts})`
  })

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    A = load(false)
    prisma = A.prisma
    require('../../src/common/events/handlers').registerEventHandlers()
    await resetLanes()
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    try {
      const users = (await prisma.user.findMany({ where: { displayName: { startsWith: 'f6c-' } }, select: { id: true } })).map((u) => u.id)
      const trades = (await prisma.trade.findMany({ where: { OR: [{ buyerId: { in: users } }, { sellerId: { in: users } }] }, select: { id: true } }))
      const tradeIds = trades.map((t) => t.id)
      const escrows = (await prisma.escrow.findMany({ where: { tradeId: { in: tradeIds } }, select: { id: true } })).map((e) => e.id)
      await withTriggersOff(async (tx) => {
        await tx.$executeRaw`DELETE FROM wdk_transfer_attempts WHERE "escrowId" = ANY(${escrows}) AND "operationType" = 'GAS_FUNDING'`
        await tx.$executeRaw`DELETE FROM wdk_transfer_attempts WHERE "escrowId" = ANY(${escrows})`
      })
      await resetLanes()
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
    } finally {
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
    mockState.chain = chain
    mockState.transferCalls = 0
    mockState.sendTransactionCalls = 0
    testEscrows = []
    await resetLanes()
  })

  afterEach(async () => {
    if (!pg.isAvailable()) return
    expect(mockState.transferCalls).toBe(0)
    expect(mockState.sendTransactionCalls).toBe(0)
    await withTriggersOff(async (tx) => {
      await tx.$executeRaw`DELETE FROM wdk_transfer_attempts WHERE "escrowId" = ANY(${testEscrows}) AND "operationType" = 'GAS_FUNDING'`
      await tx.$executeRaw`DELETE FROM wdk_transfer_attempts WHERE "escrowId" = ANY(${testEscrows})`
    })
    // Release this test's extra nodes promptly (a retained application graph per node leaks for the whole lane).
    for (const n of extra.splice(0)) await n.redis?.quit().catch(() => undefined)
    A.config.wdk.laneStuckBlocks = undefined
  })

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────────────

  const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (err: Error) => ({ ok: false as const, err: String(err.message) }))
  const evm = () => Wallet.createRandom().address

  /** A WDK escrow whose signed LOCK is final (FUNDS_LOCKED), with registered USDT payout addresses. */
  async function funded(label: string, amount = '5') {
    const tag = randomBytes(4).toString('hex')
    const mk = (role: string) => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `f6c-${label}-${role}-${tag}` } })
    const [seller, buyer, arbiter] = [await mk('s'), await mk('b'), await mk('a')]
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'USDT_ERC20', side: 'SELL', priceUsd: '1', minAmount: '0.00000001', maxAmount: '100000', paymentMethod: 'PIX' } })
    const t = await prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'USDT_ERC20', amount, priceUsd: '1', totalUsd: amount, status: 'ACTIVE' } })
    const e = await A.escrowService.createEscrow({ tradeId: t.id, type: 'WDK_USDT_EVM', asset: 'USDT_ERC20', lockedAmount: amount }, seller.id)
    testEscrows.push(e.id)
    const account = HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, `m/44'/60'/${e.wdkAccountPath}`).address
    lanes.push(account)
    const [buyerPayout, sellerPayout] = [evm(), evm()]
    const payout = require('../../src/modules/open-settlement/payout-address.service').payoutAddressService
    await payout.setPayoutAddress(buyer.id, 'USDT_ERC20', buyerPayout)
    await payout.setPayoutAddress(seller.id, 'USDT_ERC20', sellerPayout)
    await settle(A.escrowService.lockFunds(e.id, seller.id))
    chain.mine(2)
    const locked = await settle(A.escrowService.lockFunds(e.id, seller.id))
    if (!locked.ok) throw new Error(`fixture lock failed: ${locked.err}`)
    return { t, e, seller, buyer, arbiter, account, buyerPayout, sellerPayout }
  }
  type F = Awaited<ReturnType<typeof funded>>
  const paymentPending = (f: F) => A.escrowService.markPaymentSent(f.e.id, f.buyer.id)
  async function disputed(f: F) {
    await A.escrowService.openDispute(f.e.id, f.buyer.id, 'f6c split')
    await prisma.dispute.create({ data: { tradeId: f.t.id, escrowId: f.e.id, openedBy: f.buyer.id, reason: 'f6c split', arbiterId: f.arbiter.id } })
  }
  const release = (n: Node, f: F) => settle(n.escrowService.releaseFunds(f.e.id, undefined, f.seller.id))
  const refund = (n: Node, f: F) => settle(n.escrowService.refundFunds(f.e.id, f.seller.id))
  const split = (n: Node, f: F, bps: number) => settle(n.escrowService.splitFunds(f.e.id, undefined, undefined, bps, f.arbiter.id))
  const reconcileEscrow = (n: Node, f: F) => n.reconcileEscrow(f.e.id)
  const escrowOf = (f: F) => prisma.escrow.findUniqueOrThrow({ where: { id: f.e.id } })
  const legs = (f: F) => prisma.wdkTransferAttempt.findMany({ where: { escrowId: f.e.id, operationType: { in: [...OUTBOUND] } }, orderBy: { createdAt: 'asc' } })
  const fundings = (f: F) => prisma.wdkTransferAttempt.findMany({ where: { escrowId: f.e.id, operationType: 'GAS_FUNDING' }, orderBy: { createdAt: 'asc' } })
  const events = (f: F, to: string) => prisma.escrowEvent.count({ where: { escrowId: f.e.id, toStatus: to as any } })
  const durable = (f: F, name: string) => prisma.durableEventRecord.count({ where: { correlationId: f.t.id, eventName: name } })
  const broadcastsFrom = (address: string) => [...chain.distinctBroadcastHashes()].filter((h) => {
    const raw = chain.sendCalls.find((r) => Transaction.from(r).hash === h)!
    return Transaction.from(raw).from === address
  })
  /** Mines and reconciles until the escrow has a settlement result (bounded). */
  async function converge(f: F, n: Node = A, rounds = 6) {
    for (let i = 0; i < rounds; i++) {
      chain.mine(2)
      await reconcileEscrow(n, f)
      if ((await escrowOf(f)).txReleaseId) return
    }
  }
  const LEG_GAS = 72_000n * 3_000_000_000n // signed gas limit (60k estimate + 20%) x maxFeePerGas of the double

  // ── RELEASE ─────────────────────────────────────────────────────────────────────────────────────────

  it('J1-J15/T2/T5/T13-T15/U: RELEASE — frozen leg, signed by the escrow account before any broadcast, gas funded once and final before the leg, corroborated, projected once, conserved', async () => {
    pg.requirePostgres('release golden')
    const f = await funded('rel')
    await paymentPending(f)
    const [treasuryNativeBefore, treasuryGasBefore] = [chain.nativeBalance(TREASURY), chain.gasSpent.get(TREASURY) ?? 0n]
    const first = await release(A, f)
    expect(first.ok).toBe(false)
    expect((first as any).err).toMatch(/stays COMPLETED: its outbound transaction is signed/)
    const [leg] = await legs(f)
    expect([leg.authority, leg.operationType, leg.status, leg.fromAddress, leg.destination, leg.amount.toFixed(), Number(leg.nonce)])
      .toEqual(['SIGNED_RAW_V1', 'RELEASE', 'SIGNED', f.account, f.buyerPayout, '5', 0])
    const decoded = Transaction.from(leg.signedRawTx!)
    expect([decoded.from, decoded.to, decoded.nonce, decoded.hash]).toEqual([f.account, TOKEN, 0, leg.txHash])
    const [funding] = await fundings(f)
    expect([funding.status, funding.fromAddress, funding.destination, funding.fundsAttemptId, funding.valueWei!.toFixed()]).toEqual(['SUBMITTED', TREASURY, f.account, leg.id, LEG_GAS.toString()])
    expect(broadcastsFrom(f.account)).toEqual([]) // M16: the leg is not broadcast before its gas is final
    expect((await escrowOf(f)).status).toBe('COMPLETED') // DF1: claimed, never reverted once signed
    await converge(f)
    const e = await escrowOf(f)
    expect([e.status, e.txReleaseId]).toEqual(['COMPLETED', leg.txHash])
    const [done] = await legs(f)
    expect([done.status, done.primarySource, done.corroboratingSource]).toEqual(['CONFIRMED', 'primary', 'corroborator'])
    expect((await fundings(f)).map((x) => x.status)).toEqual(['CONFIRMED'])
    // conservation: token principal moved once, exactly; native gas accounted separately
    expect([chain.balance(f.buyerPayout), chain.balance(f.account)]).toEqual([5_000_000n, 0n])
    const gasPaidByEscrow = chain.gasSpent.get(f.account)!
    expect(gasPaidByEscrow).toBe(50_000n * 2_000_000_000n)
    expect(chain.nativeBalance(f.account)).toBe(LEG_GAS - gasPaidByEscrow) // leftover stays in this escrow's own account
    // T15: the treasury paid exactly the funding plus the funding transaction's own gas, nothing else
    expect(treasuryNativeBefore - chain.nativeBalance(TREASURY)).toBe(LEG_GAS + (chain.gasSpent.get(TREASURY)! - treasuryGasBefore))
    expect(broadcastsFrom(f.account)).toEqual([leg.txHash]) // T10: one economic transaction
    expect([await events(f, 'COMPLETED'), await durable(f, 'settlement.escrow.released')]).toEqual([1, 1])
    // retries and other nodes add nothing
    expect((await release(node(), f)).ok).toBe(false)
    await reconcileEscrow(node(), f)
    expect([await events(f, 'COMPLETED'), await durable(f, 'settlement.escrow.released'), (await legs(f)).length, (await fundings(f)).length]).toEqual([1, 1, 1, 1])
  })

  it('M27/U: an amount above 2^53 base units moves exactly — the obligation is integer arithmetic, never floating point', async () => {
    pg.requirePostgres('exact amount')
    chain.fund(TREASURY, 10n ** 16n)
    const f = await funded('big', '9007199254.740993') // 9007199254740993 base units = 2^53 + 1
    await paymentPending(f)
    await release(A, f)
    expect((await legs(f)).map((l) => l.amount.toFixed())).toEqual(['9007199254.740993'])
    await converge(f)
    expect([(await escrowOf(f)).status, chain.balance(f.buyerPayout), chain.balance(f.account)]).toEqual(['COMPLETED', 9_007_199_254_740_993n, 0n])
  })

  it('K1/T3: REFUND (FUNDS_LOCKED) returns exactly the principal to the treasury that funded the LOCK', async () => {
    pg.requirePostgres('refund')
    const f = await funded('refund')
    const treasuryTokens = chain.balance(TREASURY)
    await refund(A, f)
    expect((await legs(f)).map((l) => [l.operationType, l.destination, l.amount.toFixed()])).toEqual([['REFUND', TREASURY, '5']])
    await converge(f)
    expect([(await escrowOf(f)).status, chain.balance(TREASURY) - treasuryTokens, chain.balance(f.account), await durable(f, 'settlement.escrow.refunded')]).toEqual(['REFUNDED', 5_000_000n, 0n, 1])
  })

  it('K2/S2/C5/M5: the arbiter RELEASE and REFUND race on a DISPUTED escrow — one claim, one family, the database refuses the other', async () => {
    pg.requirePostgres('refund race')
    const f = await funded('ref')
    await paymentPending(f)
    await disputed(f)
    const treasuryTokens = chain.balance(TREASURY)
    const [r1, r2] = await Promise.all([
      settle(A.escrowService.releaseFunds(f.e.id, undefined, f.arbiter.id)),
      settle(node().escrowService.refundFunds(f.e.id, f.arbiter.id)),
    ])
    const status = (await escrowOf(f)).status
    expect(['COMPLETED', 'REFUNDED']).toContain(status)
    const ops = (await legs(f)).map((l) => l.operationType)
    expect(new Set(ops).size).toBe(1)
    expect([r1, r2].filter((r) => !r.ok && /already transitioned|already froze|Invalid escrow transition/.test((r as any).err))).toHaveLength(1)
    const other = ops[0] === 'RELEASE' ? 'REFUND' : 'RELEASE'
    await expect(prisma.wdkTransferAttempt.create({ data: { escrowId: f.e.id, operationType: other, destination: TREASURY, amount: '5', authority: 'SIGNED_RAW_V1', chainId: 31337, fromAddress: f.account, tokenContract: TOKEN } }))
      .rejects.toThrow(/already has an economic .* outbound obligation/)
    await converge(f)
    const e = await escrowOf(f)
    expect(e.txReleaseId).not.toBeNull()
    if (status === 'REFUNDED') expect(chain.balance(TREASURY) - treasuryTokens).toBe(5_000_000n)
    else expect(chain.balance(f.buyerPayout)).toBe(5_000_000n)
    expect(chain.balance(f.account)).toBe(0n)
  })

  it('C1/C4/C7/M6/M7: the same obligation prepared twice at once records one set of legs; different legs are refused', async () => {
    pg.requirePostgres('prepare once')
    const f = await funded('prep')
    await paymentPending(f)
    const escrow = await escrowOf(f)
    const legs1 = [{ operationType: 'RELEASE', destination: f.buyerPayout, amount: '5' }]
    await Promise.all([A.outbound.prepareWdkOutbound(escrow, legs1), node().outbound.prepareWdkOutbound(escrow, legs1), node().outbound.prepareWdkOutbound(escrow, legs1)].map((p) => p.catch((e: Error) => e)))
    expect((await legs(f)).map((l) => [l.operationType, l.status, l.destination])).toEqual([['RELEASE', 'PREPARED', f.buyerPayout]])
    await expect(A.outbound.prepareWdkOutbound(escrow, [{ operationType: 'RELEASE', destination: f.sellerPayout, amount: '5' }])).rejects.toThrow(/frozen outbound obligation/)
    await expect(A.outbound.prepareWdkOutbound(escrow, [{ operationType: 'RELEASE', destination: f.buyerPayout, amount: '4' }])).rejects.toThrow(/frozen outbound obligation/)
    expect((await legs(f))).toHaveLength(1)
  })

  it('K4: a CREATED WDK escrow (funding never proven) is never refunded on-chain', async () => {
    pg.requirePostgres('refund created')
    const tag = randomBytes(4).toString('hex')
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `f6c-created-s-${tag}` } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `f6c-created-b-${tag}` } })
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'USDT_ERC20', side: 'SELL', priceUsd: '1', minAmount: '0.00000001', maxAmount: '100000', paymentMethod: 'PIX' } })
    const t = await prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'USDT_ERC20', amount: '5', priceUsd: '1', totalUsd: '5', status: 'ACTIVE' } })
    const e = await A.escrowService.createEscrow({ tradeId: t.id, type: 'WDK_USDT_EVM', asset: 'USDT_ERC20', lockedAmount: '5' }, seller.id)
    testEscrows.push(e.id)
    const r = await settle(A.escrowService.refundFunds(e.id, seller.id))
    expect((r as any).err).toMatch(/CREATED: its WDK funding was never proven/)
    expect([(await prisma.escrow.findUniqueOrThrow({ where: { id: e.id } })).status, await prisma.wdkTransferAttempt.count({ where: { escrowId: e.id } })]).toEqual(['CREATED', 0])
  })

  // ── SPLIT ───────────────────────────────────────────────────────────────────────────────────────────

  it('L1-L12/T4/U: SPLIT — two frozen legs summing exactly to the principal; the seller leg only after the buyer leg is final; one funding per leg', async () => {
    pg.requirePostgres('split golden')
    const f = await funded('spl')
    await paymentPending(f)
    await disputed(f)
    const first = await split(A, f, 3333)
    expect(first.ok).toBe(false)
    let ls = await legs(f)
    expect(ls.map((l) => [l.operationType, l.status, l.destination, l.amount.toFixed()])).toEqual([
      ['SPLIT_BUYER', 'SIGNED', f.buyerPayout, '1.6665'], ['SPLIT_SELLER', 'PREPARED', f.sellerPayout, '3.3335'],
    ])
    await converge(f)
    ls = await legs(f)
    expect(ls.map((l) => [l.operationType, l.status, Number(l.nonce)])).toEqual([['SPLIT_BUYER', 'CONFIRMED', 0], ['SPLIT_SELLER', 'CONFIRMED', 1]])
    expect(ls[1].signedAtBlock! >= ls[0].finalityHeadBlock!).toBe(true) // L8: seller signed only after the buyer leg was final
    const e = await escrowOf(f)
    expect([e.status, e.txReleaseId]).toEqual(['SPLIT', `${ls[0].txHash},${ls[1].txHash}`])
    expect([chain.balance(f.buyerPayout), chain.balance(f.sellerPayout), chain.balance(f.account)]).toEqual([1_666_500n, 3_333_500n, 0n]) // U: sum = 5_000_000
    const fs = await fundings(f)
    expect(fs.map((x) => x.fundsAttemptId)).toEqual([ls[0].id, ls[1].id])
    expect(BigInt(fs[1].valueWei!.toFixed())).toBe(LEG_GAS - (LEG_GAS - 50_000n * 2_000_000_000n)) // leg 2 funded only its deficit after leg 1's leftover
    expect([await events(f, 'SPLIT'), await durable(f, 'settlement.escrow.split')]).toEqual([1, 1])
  })

  it('L5-L7/R14/M8/M9: the buyer leg final, the seller leg fails before signing — the split continues with a new generation of only that leg; the buyer leg never repeats', async () => {
    pg.requirePostgres('split resume')
    const f = await funded('spl-resume')
    await paymentPending(f)
    await disputed(f)
    await split(A, f, 5000)
    await converge(f, A, 1) // buyer leg final; seller leg signing attempted on the next pass
    let estimates = 0
    chain.hooks.estimateGas = () => { if (++estimates === 1) throw new Error('estimate unavailable (injected)'); return 60_000n }
    for (let i = 0; i < 3; i++) { chain.mine(2); await reconcileEscrow(A, f) }
    chain.hooks.estimateGas = undefined
    await converge(f)
    const ls = await legs(f)
    expect(ls.map((l) => [l.operationType, l.status])).toEqual([['SPLIT_BUYER', 'CONFIRMED'], ['SPLIT_SELLER', 'FAILED_BEFORE_SUBMISSION'], ['SPLIT_SELLER', 'CONFIRMED']])
    expect(broadcastsFrom(f.account).length).toBe(2)
    expect([chain.balance(f.buyerPayout), chain.balance(f.sellerPayout)]).toEqual([2_500_000n, 2_500_000n])
    expect((await escrowOf(f)).status).toBe('SPLIT')
  })

  it('L10/M28: the seller leg reverts on-chain after the buyer leg was final — no completion, manual review, nothing re-signed', async () => {
    pg.requirePostgres('split partial revert')
    const f = await funded('spl-rev')
    await paymentPending(f)
    await disputed(f)
    await split(A, f, 5000)
    await converge(f, A, 2)
    const seller = (await legs(f)).find((l) => l.operationType === 'SPLIT_SELLER')!
    expect(seller.status).not.toBe('PREPARED')
    chain.tokenBalances.set(f.account, 0n) // the seller leg's transfer reverts on-chain
    let report: any
    for (let i = 0; i < 4; i++) { chain.mine(2); report = await reconcileEscrow(A, f) }
    const ls = await legs(f)
    expect(ls.map((l) => [l.operationType, l.status])).toEqual([['SPLIT_BUYER', 'CONFIRMED'], ['SPLIT_SELLER', 'REVERTED']])
    expect(report.requiresManualReview.some((m: any) => /SPLIT_SELLER .* reverted on-chain .* manual review/.test(m.reason))).toBe(true)
    const e = await escrowOf(f)
    expect([e.status, e.txReleaseId, await events(f, 'SPLIT')]).toEqual(['SPLIT', null, 0])
    expect(broadcastsFrom(f.account).length).toBe(2)
  })

  // ── DF1 / ambiguity / corroboration ─────────────────────────────────────────────────────────────────

  it('M/DF1/T7/T9/R7/M3/M4/M18/M19: broadcast timeouts, no receipt, malformed receipts — the leg stays signed, the escrow claimed; the same bytes converge', async () => {
    pg.requirePostgres('df1 ambiguity')
    const f = await funded('df1')
    await paymentPending(f)
    await release(A, f)
    const [leg] = await legs(f)
    chain.hooks.beforeSend = (raw) => { if (Transaction.from(raw).from === f.account) throw new Error('ETIMEDOUT (injected)') }
    for (let i = 0; i < 2; i++) { chain.mine(2); await reconcileEscrow(A, f) }
    chain.hooks.beforeSend = undefined
    chain.hooks.receipt = (h) => (h === leg.txHash ? { status: '0x7' } : undefined)
    for (let i = 0; i < 2; i++) { chain.mine(2); await reconcileEscrow(node(), f) }
    expect([(await legs(f)).map((l) => l.status), (await escrowOf(f)).status]).toEqual([['SUBMITTED'], 'COMPLETED'])
    chain.hooks.receipt = undefined
    await converge(f, node())
    expect((await escrowOf(f)).txReleaseId).toBe(leg.txHash)
    expect(broadcastsFrom(f.account)).toEqual([leg.txHash])
    expect(new Set(chain.sendCalls.filter((r) => Transaction.from(r).from === f.account))).toEqual(new Set([leg.signedRawTx]))
  })

  it('DF1 pre-signing: a failure before any leg is signed reverts the claim (nothing could move); a later release starts cleanly', async () => {
    pg.requirePostgres('df1 pre-sign')
    const f = await funded('presign')
    await paymentPending(f)
    chain.hooks.estimateGas = () => { throw new Error('execution reverted (injected estimate)') }
    const r = await release(A, f)
    expect((r as any).err).toMatch(/could not be prepared \(nothing was signed or broadcast\)/)
    expect([(await escrowOf(f)).status, (await legs(f)).map((l) => l.status), await fundings(f)]).toEqual(['PAYMENT_PENDING', ['FAILED_BEFORE_SUBMISSION'], []])
    chain.hooks.estimateGas = undefined
    await release(A, f)
    await converge(f)
    expect((await legs(f)).map((l) => l.status)).toEqual(['FAILED_BEFORE_SUBMISSION', 'CONFIRMED'])
    expect(chain.balance(f.buyerPayout)).toBe(5_000_000n)
  })

  it('R1-R3: the process dies after the claim, before the obligation is recorded — reconciliation records it from durable authority and converges; once recorded, a failing generation is never re-recorded', async () => {
    pg.requirePostgres('crash before record')
    const crashAfterClaim = async (f: F, call: () => Promise<unknown>, claimed: string) => {
      const spy = jest.spyOn(A.outbound, 'settleWdkOutbound').mockImplementation(() => new Promise(() => undefined)) // the process dies here
      try {
        void call()
        for (let i = 0; i < 100 && (await escrowOf(f)).status !== claimed; i++) await new Promise((r) => setTimeout(r, 20))
      } finally {
        spy.mockRestore()
      }
      expect([(await escrowOf(f)).status, (await escrowOf(f)).txReleaseId, (await legs(f)).length]).toEqual([claimed, null, 0])
    }
    // RELEASE: recorded by a fresh node from the buyer's registered payout address, then one leg, one funding, one event
    const r = await funded('r1')
    await paymentPending(r)
    await crashAfterClaim(r, () => release(A, r), 'COMPLETED')
    await reconcileEscrow(node(), r)
    expect((await legs(r)).map((l) => [l.operationType, l.destination, l.amount.toFixed()])).toEqual([['RELEASE', r.buyerPayout, '5']])
    await converge(r, node())
    expect([(await escrowOf(r)).txReleaseId, chain.balance(r.buyerPayout), (await legs(r)).length, (await fundings(r)).length, await events(r, 'COMPLETED')])
      .toEqual([(await legs(r))[0].txHash, 5_000_000n, 1, 1, 1])
    // SPLIT (arbitrated): the frozen buyerBps of the claim, through the reconciliation pass itself
    const s = await funded('r1s')
    await paymentPending(s)
    await disputed(s)
    await crashAfterClaim(s, () => split(A, s, 2500), 'SPLIT')
    await A.reconcile({ projectionGraceMs: 0 })
    expect((await legs(s)).map((l) => [l.operationType, l.amount.toFixed()])).toEqual([['SPLIT_BUYER', '1.25'], ['SPLIT_SELLER', '3.75']])
    await converge(s)
    expect([(await escrowOf(s)).status, chain.balance(s.buyerPayout), chain.balance(s.sellerPayout)]).toEqual(['SPLIT', 1_250_000n, 3_750_000n])
    // bounded: a recorded generation refused before signing (fee above the cap) is not re-recorded on every pass
    const b = await funded('r1b')
    await paymentPending(b)
    await crashAfterClaim(b, () => release(A, b), 'COMPLETED')
    A.config.wdk.outboundMaxFeePerGasWei = 2_000_000_000n
    try {
      await reconcileEscrow(A, b)
      const report = await reconcileEscrow(A, b)
      expect(report.requiresManualReview.some((m: any) => /RELEASE failed before anything was signed/.test(m.reason))).toBe(true)
    } finally {
      A.config.wdk.outboundMaxFeePerGasWei = 5_000_000_000n
    }
    expect([(await escrowOf(b)).status, (await legs(b)).map((l) => l.status), broadcastsFrom(b.account)]).toEqual(['COMPLETED', ['FAILED_BEFORE_SUBMISSION'], []])
  })

  it('R4/R5/M1: persisting the signed leg fails — nothing was broadcast, nothing signed is durable, the claim is reverted', async () => {
    pg.requirePostgres('persist failure')
    const f = await funded('persist')
    await paymentPending(f)
    await prisma.$executeRawUnsafe(`ALTER TABLE wdk_transfer_attempts ADD CONSTRAINT f6c_injected_failure CHECK (NOT ("escrowId" = '${f.e.id}' AND status::text = 'SIGNED'))`)
    try {
      expect((await release(A, f) as any).err).toMatch(/f6c_injected_failure/)
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE wdk_transfer_attempts DROP CONSTRAINT f6c_injected_failure')
    }
    expect([(await legs(f)).map((l) => [l.status, l.signedRawTx]), (await escrowOf(f)).status, broadcastsFrom(f.account), await fundings(f)]).toEqual([[['FAILED_BEFORE_SUBMISSION', null]], 'PAYMENT_PENDING', [], []])
    expect(Number((await prisma.wdkNonceLane.findUnique({ where: { chainId_account: { chainId: 31337, account: f.account } } }))?.nextNonce ?? 0n)).toBe(0) // the nonce allocation rolled back with it
  })

  it('M33/WDK_CHAIN_ID_PINNING_V1: an RPC serving another chain — nothing signed or broadcast, the claim reverted', async () => {
    pg.requirePostgres('outbound chain')
    const f = await funded('chain')
    await paymentPending(f)
    chain.chainIdValue = 1n
    try {
      expect((await release(A, f) as any).err).toMatch(/serves chain 1, but WDK_CHAIN_ID is 31337/)
    } finally {
      chain.chainIdValue = 31337n
    }
    expect([(await legs(f)).map((l) => [l.status, l.signedRawTx]), (await escrowOf(f)).status, broadcastsFrom(f.account), await fundings(f)]).toEqual([[['FAILED_BEFORE_SUBMISSION', null]], 'PAYMENT_PENDING', [], []])
  })

  it('J13/M13-like: a final, corroborated revert of a RELEASE stops for manual review — no transaction B, the escrow is not reverted', async () => {
    pg.requirePostgres('release revert')
    const f = await funded('rel-rev')
    await paymentPending(f)
    await release(A, f)
    chain.tokenBalances.set(f.account, 0n)
    let report: any
    for (let i = 0; i < 5; i++) { chain.mine(2); report = await reconcileEscrow(A, f) }
    expect((await legs(f)).map((l) => [l.status, l.primarySource, l.corroboratingSource])).toEqual([['REVERTED', 'primary', 'corroborator']])
    expect(report.requiresManualReview.some((m: any) => /reverted on-chain .* nothing is re-signed/.test(m.reason))).toBe(true)
    expect([(await escrowOf(f)).status, (await escrowOf(f)).txReleaseId]).toEqual(['COMPLETED', null])
    expect(broadcastsFrom(f.account)).toHaveLength(1)
    expect((await release(A, f)).ok).toBe(false)
  })

  it('N/M17/T11: one RPC never finalizes an outbound leg — the corroborator unreachable keeps it pending; reachable, it converges', async () => {
    pg.requirePostgres('corroboration')
    const f = await funded('corr')
    await paymentPending(f)
    await release(A, f)
    chain.corroborator.unavailable = true
    for (let i = 0; i < 4; i++) { chain.mine(2); await reconcileEscrow(A, f) }
    expect([(await fundings(f)).map((x) => x.status), (await legs(f)).map((l) => l.status), (await escrowOf(f)).txReleaseId]).toEqual([['SUBMITTED'], ['SIGNED'], null])
    chain.corroborator.unavailable = false
    await converge(f)
    expect((await escrowOf(f)).txReleaseId).not.toBeNull()
  })

  // ── gas authority ───────────────────────────────────────────────────────────────────────────────────

  it('H1-H8/G/S6/M13/M35: gas funding is one signed treasury transaction per leg — concurrent nodes and an ambiguous funding broadcast never fund twice', async () => {
    pg.requirePostgres('gas once')
    const f = await funded('gas')
    await paymentPending(f)
    chain.hooks.beforeSend = (raw) => { if (Transaction.from(raw).to === f.account) throw new Error('socket hang up (funding, injected)') }
    await release(A, f)
    chain.hooks.beforeSend = undefined
    const [funding] = await fundings(f)
    expect(funding.status).toBe('SIGNED')
    await Promise.all([reconcileEscrow(node(), f), reconcileEscrow(node(), f), reconcileEscrow(A, f)])
    await converge(f)
    const fs = await fundings(f)
    expect(fs).toHaveLength(1)
    expect(chain.sendCalls.filter((r) => Transaction.from(r).to === f.account).every((r) => r === funding.signedRawTx)).toBe(true)
    expect(chain.nativeBalance(f.account) + chain.gasSpent.get(f.account)!).toBe(BigInt(funding.valueWei!.toFixed()))
    await expect(prisma.wdkTransferAttempt.create({ data: { escrowId: f.e.id, operationType: 'GAS_FUNDING', destination: f.account, amount: '0', authority: 'SIGNED_RAW_V1', chainId: 31337, fromAddress: TREASURY, fundsAttemptId: fs[0].fundsAttemptId, valueWei: '1' } }))
      .rejects.toThrow(/Unique constraint failed|fundsAttemptId/)
  })

  it('H/T6: a gas funding refused before signing (the treasury lane paused) stays PREPARED; the leg is never broadcast without gas; unpaused, the same funding is signed and the obligation converges', async () => {
    pg.requirePostgres('gas paused')
    const f = await funded('gas-paused')
    await paymentPending(f)
    const gov = require('../../src/modules/open-settlement/wdk-lane-governance')
    await gov.pauseLane(31337, TREASURY, 'test-operator', 'no gas authority (test)')
    const r = await release(A, f)
    expect((r as any).err).toMatch(/OPERATOR_PAUSE.* stays COMPLETED/)
    for (let i = 0; i < 2; i++) { chain.mine(2); await reconcileEscrow(A, f) }
    const [funding] = await fundings(f)
    expect([funding.status, funding.signedRawTx, (await legs(f)).map((l) => l.status), broadcastsFrom(f.account), chain.balance(f.account)]).toEqual(['PREPARED', null, ['SIGNED'], [], 5_000_000n])
    expect((await gov.unpauseLane(31337, TREASURY, 'test-operator')) ?? null).toBeNull()
    await converge(f)
    const fs = await fundings(f)
    expect([fs.length, fs[0].id, fs[0].status, (await escrowOf(f)).txReleaseId !== null, chain.balance(f.buyerPayout)]).toEqual([1, funding.id, 'CONFIRMED', true, 5_000_000n])
  })

  it('I/M14/M15: gas policy — an estimate or fee above the caps is refused before anything is signed or funded', async () => {
    pg.requirePostgres('gas caps')
    const f = await funded('caps')
    await paymentPending(f)
    chain.hooks.estimateGas = () => 1_000_000n // an inflated estimate (a hostile or broken RPC)
    expect((await release(A, f) as any).err).toMatch(/gas limit 1200000 is above WDK_OUTBOUND_MAX_GAS_LIMIT 100000/)
    expect([(await escrowOf(f)).status, (await legs(f)).map((l) => l.status), await fundings(f)]).toEqual(['PAYMENT_PENDING', ['FAILED_BEFORE_SUBMISSION'], []])
    chain.hooks.estimateGas = undefined
    A.config.wdk.outboundMaxFeePerGasWei = 2_000_000_000n
    try {
      expect((await release(A, f) as any).err).toMatch(/maxFeePerGas 3000000000 is above WDK_OUTBOUND_MAX_FEE_PER_GAS_WEI 2000000000/)
    } finally {
      A.config.wdk.outboundMaxFeePerGasWei = 5_000_000_000n
    }
    expect(chain.sendCalls).toHaveLength(1) // only the fixture's LOCK
  })

  it('I/H: no gas policy, no corroborating RPC — outbound refused before any claim; a caller-supplied destination is refused (M10)', async () => {
    pg.requirePostgres('policy')
    const f = await funded('pol')
    await paymentPending(f)
    const saved = A.config.wdk.outboundMaxGasLimit
    A.config.wdk.outboundMaxGasLimit = undefined
    try {
      expect((await release(A, f) as any).err).toMatch(/no WDK_OUTBOUND_MAX_GAS_LIMIT configured/)
    } finally {
      A.config.wdk.outboundMaxGasLimit = saved
    }
    expect((await settle(A.escrowService.releaseFunds(f.e.id, evm(), f.seller.id)) as any).err).toMatch(/caller-supplied destination is refused/)
    expect([(await escrowOf(f)).status, await legs(f)]).toEqual(['PAYMENT_PENDING', []])
  })

  // ── multi-node / restart ────────────────────────────────────────────────────────────────────────────

  it('S1/S3/S5/S7-S9/R10/R11: two nodes release at once, reconciliation races the live call, the publish fails once — one leg, one funding, one event', async () => {
    pg.requirePostgres('multi-node')
    const f = await funded('mn')
    await paymentPending(f)
    await Promise.all([release(A, f), release(node(), f), reconcileEscrow(node(), f)])
    expect([(await legs(f)).length, (await fundings(f)).length]).toEqual([1, 1])
    for (let i = 0; i < 2; i++) { chain.mine(2); await Promise.all([reconcileEscrow(node(), f), reconcileEscrow(node(), f)]) }
    const lifecycle = require('../../src/modules/open-settlement/escrow-lifecycle')
    const spy = jest.spyOn(lifecycle, 'publishEscrowTransition').mockRejectedValueOnce(new Error('event bus down (injected)'))
    try {
      await converge(f)
    } finally {
      spy.mockRestore()
    }
    await Promise.all([reconcileEscrow(node(), f), reconcileEscrow(node(), f)])
    await A.reconcile({ projectionGraceMs: 0 })
    expect([await events(f, 'COMPLETED'), await durable(f, 'settlement.escrow.released')]).toEqual([1, 1])
    expect([(await legs(f)).length, (await fundings(f)).length, broadcastsFrom(f.account).length]).toEqual([1, 1, 1])
  })

  it('E3/M26: another transaction of the escrow account takes the leg\'s nonce — suspicion halts the escrow lane; corroborated, the leg is NONCE_CONSUMED_ELSEWHERE for review', async () => {
    pg.requirePostgres('escrow nonce')
    const f = await funded('ext')
    await paymentPending(f)
    await release(A, f)
    chain.hooks.beforeSend = (raw) => { if (Transaction.from(raw).from === f.account) throw new Error('ECONNRESET (injected)') }
    chain.external(f.account) // someone with the seed spends nonce 0 of the escrow account before the leg ever reaches a node
    let report: any
    for (let i = 0; i < 3; i++) { chain.mine(2); report = await reconcileEscrow(A, f) }
    chain.hooks.beforeSend = undefined
    const [leg] = await legs(f)
    expect(leg.status).toBe('NONCE_CONSUMED_ELSEWHERE')
    expect(report.requiresManualReview.some((m: any) => /consumed by another transaction/.test(m.reason))).toBe(true)
    const halts = await prisma.wdkLaneHalt.findMany({ where: { chainId: 31337, account: f.account, clearedAt: null } })
    expect(halts.map((h) => h.reason)).toContain('PROVEN_EXTERNAL_NONCE_CONSUMPTION')
    expect([(await escrowOf(f)).txReleaseId, chain.mined.has(leg.txHash!), chain.balance(f.account)]).toEqual([null, false, 5_000_000n]) // nothing moved
  })

  // ── database authority ──────────────────────────────────────────────────────────────────────────────

  it('W/C8: the database refuses — a second family, a changed frozen leg, a gas funding without a signed leg, a rewritten funding, a deleted signed leg, a signed obligation next to a legacy transfer()', async () => {
    pg.requirePostgres('db bypass')
    const f = await funded('db')
    await paymentPending(f)
    chain.hooks.estimateGas = () => { throw new Error('hold before signing (injected)') }
    await release(A, f) // prepared then FAILED_BEFORE_SUBMISSION, claim reverted
    chain.hooks.estimateGas = undefined
    const g = await funded('db2')
    await paymentPending(g)
    await release(A, g)
    const [leg] = await legs(g)
    const refuse = /immutable|frozen|already has an economic|must fund a signed outbound leg|cannot be deleted|legacy transfer\(\)|gas_funding_shape/
    await expect(prisma.wdkTransferAttempt.create({ data: { escrowId: g.e.id, operationType: 'REFUND', destination: TREASURY, amount: '5', authority: 'SIGNED_RAW_V1', chainId: 31337, fromAddress: g.account, tokenContract: TOKEN } })).rejects.toThrow(refuse)
    await expect(prisma.wdkTransferAttempt.update({ where: { id: leg.id }, data: { destination: evm() } })).rejects.toThrow(refuse)
    await expect(prisma.wdkTransferAttempt.update({ where: { id: leg.id }, data: { amount: '4' } })).rejects.toThrow(refuse)
    await expect(prisma.wdkTransferAttempt.delete({ where: { id: leg.id } })).rejects.toThrow(refuse)
    const [funding] = await fundings(g)
    await expect(prisma.wdkTransferAttempt.update({ where: { id: funding.id }, data: { valueWei: '1' } })).rejects.toThrow(refuse)
    await expect(prisma.wdkTransferAttempt.update({ where: { id: funding.id }, data: { status: 'CONFIRMED' } })).rejects.toThrow(/corroboration_check|finality_evidence_check/)
    await expect(prisma.wdkTransferAttempt.update({ where: { id: leg.id }, data: { status: 'REVERTED' } })).rejects.toThrow(/corroboration_check|finality_evidence_check/) // M21: no hand-written revert either
    await expect(prisma.wdkTransferAttempt.create({ data: { escrowId: f.e.id, operationType: 'GAS_FUNDING', destination: f.account, amount: '0', authority: 'SIGNED_RAW_V1', chainId: 31337, fromAddress: TREASURY, fundsAttemptId: (await legs(f))[0].id, valueWei: '1' } })).rejects.toThrow(refuse)
    await expect(prisma.wdkTransferAttempt.create({ data: { escrowId: f.e.id, operationType: 'GAS_FUNDING', destination: f.account, amount: '1', authority: 'SIGNED_RAW_V1', chainId: 31337, fromAddress: TREASURY } })).rejects.toThrow(refuse)
    // a legacy transfer() outbound attempt that may have moved funds blocks any signed outbound authority (M32)
    await prisma.wdkTransferAttempt.create({ data: { escrowId: f.e.id, operationType: 'RELEASE', status: 'SUBMISSION_UNKNOWN', destination: f.buyerPayout, amount: '5' } })
    await expect(prisma.wdkTransferAttempt.create({ data: { escrowId: f.e.id, operationType: 'RELEASE', destination: f.buyerPayout, amount: '5', authority: 'SIGNED_RAW_V1', chainId: 31337, fromAddress: f.account, tokenContract: TOKEN } })).rejects.toThrow(refuse)
    expect((await release(A, f) as any).err).toMatch(/legacy transfer\(\)|active|Unique/)
  })

  // ── unfillable lane gap ─────────────────────────────────────────────────────────────────────────────

  it('P/UNFILLABLE_LANE_GAP_V1/M24/M25: a lane initialized past a foreign pending nonce that later disappears stays fail-closed — no resume, no rewind, visible to the operator', async () => {
    pg.requirePostgres('lane gap')
    const tag = randomBytes(4).toString('hex')
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `f6c-gap-s-${tag}` } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `f6c-gap-b-${tag}` } })
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'USDT_ERC20', side: 'SELL', priceUsd: '1', minAmount: '0.00000001', maxAmount: '100000', paymentMethod: 'PIX' } })
    const t = await prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'USDT_ERC20', amount: '5', priceUsd: '1', totalUsd: '5', status: 'ACTIVE' } })
    const e = await A.escrowService.createEscrow({ tradeId: t.id, type: 'WDK_USDT_EVM', asset: 'USDT_ERC20', lockedAmount: '5' }, seller.id)
    testEscrows.push(e.id)
    const foreign = chain.external(TREASURY) // pending at nonce 0, never mined
    await settle(A.escrowService.lockFunds(e.id, seller.id)) // lane initialized at 1 (pending 1): the LOCK takes nonce 1
    chain.drop(foreign) // the foreign transaction disappears: nonce 0 is never consumed
    const lock = await prisma.wdkTransferAttempt.findFirstOrThrow({ where: { escrowId: e.id, operationType: 'LOCK' } })
    expect(Number(lock.nonce)).toBe(1)
    A.config.wdk.laneStuckBlocks = 3
    for (let i = 0; i < 3; i++) { chain.mine(2); await A.reconcile({ projectionGraceMs: 0 }) }
    const gov = require('../../src/modules/open-settlement/wdk-lane-governance')
    const status = await gov.laneStatus(31337, TREASURY)
    expect(status.activeHalts.map((h: any) => h.reason)).toEqual(['STUCK_LOWEST_NONCE'])
    expect(status.laneGap).toEqual({ chainLatestNonce: 0, lowestUnresolvedNonce: 1, unsignedNonces: [0] })
    const resume = await settle(gov.resumeLane(31337, TREASURY, 'test-operator'))
    expect((resume as any).err).toMatch(/not terminal/)
    expect(Number((await prisma.wdkNonceLane.findUniqueOrThrow({ where: { chainId_account: { chainId: 31337, account: TREASURY } } })).nextNonce)).toBe(2)
    await expect(prisma.wdkNonceLane.update({ where: { chainId_account: { chainId: 31337, account: TREASURY } }, data: { nextNonce: 0n } })).rejects.toThrow(/never decreases/)
    expect((await prisma.wdkTransferAttempt.findFirstOrThrow({ where: { escrowId: e.id, operationType: 'LOCK' } })).status).toMatch(/^(SIGNED|SUBMITTED)$/) // never terminal: it can never be mined
  })
})
