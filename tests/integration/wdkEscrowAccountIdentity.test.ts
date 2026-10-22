// tests/integration/wdkEscrowAccountIdentity.test.ts
//
// #235 R7G-F6A-1 — WDK escrow account identity on real PostgreSQL (migration
// 20261007120000_wdk_escrow_account_identity): every WDK_USDT_EVM escrow gets its account path from
// the database on INSERT (1'/0/<n>, n from wdk_escrow_account_index_seq), unique, immutable, bound to
// its escrow; every provider operation derives exactly that path, on every node. Independent module
// graphs and Prisma pools stand in for separate nodes. The wallet is a fake whose address is a
// function of the derivation path (@tetherto/wdk-wallet-evm ships ESM only); the real-wallet/EVM
// proof is the local-EVM evidence script. #235 R7G-F6C: outbound legs are signed through
// signEscrowTransaction() (tests/integration/wdkOutboundAuthority); the provider's transfer() path is retired.

process.env.WDK_SEED_PHRASE = process.env.WDK_SEED_PHRASE || 'test only seed phrase for wdk escrow account identity integration tests'
process.env.WDK_USDT_CONTRACT = process.env.WDK_USDT_CONTRACT || '0x0000000000000000000000000000000000000001'

const derivedPaths: string[] = []
const mockTransfer = jest.fn()
const mockSign = jest.fn()
const mockReceipt = jest.fn()
const accountFor = (path: string) => ({
  getAddress: async () => `addr:${path}`,
  transfer: (...a: unknown[]) => mockTransfer(path, ...a),
  signTransaction: (...a: unknown[]) => mockSign(path, ...a),
  getTransactionReceipt: (...a: unknown[]) => mockReceipt(path, ...a),
})
jest.mock('@tetherto/wdk-wallet-evm', () => ({
  __esModule: true,
  default: class FakeWalletManagerEvm {
    async getAccount(i: number) { derivedPaths.push(`0'/0/${i}`); return accountFor(`0'/0/${i}`) }
    async getAccountByPath(p: string) { derivedPaths.push(p); return accountFor(p) }
  },
}))

import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const COLLIDING = ['b809d470-125c-4416-80cd-5ea321348d83', '2a1b60b4-6e28-4aa8-a064-013c62738223']
const ALLOCATED = /^1'\/0\/(0|[1-9][0-9]*)$/

type Node = { prisma: PrismaClient; escrowService: any; wdk: any; redis?: { quit(): Promise<unknown> } }

describe('#235 R7G-F6A-1 — WDK escrow account identity (real PostgreSQL)', () => {
  jest.setTimeout(180_000)
  const pg = createPostgresIntegrationHarness()
  let A: Node
  const extra: Node[] = []
  let prisma: PrismaClient

  function load(isolated: boolean): Node {
    let n!: Node
    const body = () => {
      n = {
        prisma: require('../../src/common/database').prisma,
        escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService,
        wdk: require('../../src/modules/open-settlement/wdk-settlement.provider').wdkSettlementProvider,
        redis: isolated ? require('../../src/common/redis').redis : undefined,
      }
    }
    if (isolated) jest.isolateModules(body); else body()
    return n
  }
  const node = () => { const n = load(true); extra.push(n); return n }

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    A = load(false)
    prisma = A.prisma
    await removeTrades(COLLIDING) // a previous interrupted run
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    try {
      const users = (await prisma.user.findMany({ where: { displayName: { startsWith: 'f6a1-' } }, select: { id: true } })).map((u) => u.id)
      const trades = (await prisma.trade.findMany({ where: { OR: [{ buyerId: { in: users } }, { sellerId: { in: users } }] }, select: { id: true } })).map((t) => t.id)
      await removeTrades(trades)
      await prisma.$executeRaw`DELETE FROM offers WHERE "userId" = ANY(${users})`
      await prisma.$executeRaw`DELETE FROM users WHERE id = ANY(${users})`
    } finally {
      for (const n of extra) { await n.prisma.$disconnect().catch(() => undefined); await n.redis?.quit().catch(() => undefined) }
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  beforeEach(() => {
    derivedPaths.length = 0
    mockTransfer.mockReset()
    mockReceipt.mockReset()
    mockSign.mockReset()
    mockSign.mockImplementation(async (path: string) => `signed-by:${path}`)
    mockTransfer.mockImplementation(async () => ({ hash: `0x${randomBytes(32).toString('hex')}`, fee: 1n }))
    mockReceipt.mockResolvedValue({ status: 1 })
  })

  async function removeTrades(tradeIds: string[]) {
    const escrows = (await prisma.escrow.findMany({ where: { tradeId: { in: tradeIds } }, select: { id: true } })).map((e) => e.id)
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
  }

  async function trade(label: string, id?: string) {
    const tag = randomBytes(4).toString('hex')
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `f6a1-${label}-s-${tag}` } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `f6a1-${label}-b-${tag}` } })
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'USDT_ERC20', side: 'SELL', priceUsd: '1', minAmount: '1', maxAmount: '100', paymentMethod: 'PIX' } })
    const t = await prisma.trade.create({ data: { ...(id ? { id } : {}), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'USDT_ERC20', amount: '5', priceUsd: '1', totalUsd: '5', status: 'ACTIVE' } })
    return { t, seller, buyer }
  }
  const create = (n: Node, f: Awaited<ReturnType<typeof trade>>) =>
    n.escrowService.createEscrow({ tradeId: f.t.id, type: 'WDK_USDT_EVM', asset: 'USDT_ERC20', lockedAmount: '5' }, f.seller.id)
  const fixture = (n: Node, f: Awaited<ReturnType<typeof trade>>) =>
    n.prisma.escrow.create({ data: { tradeId: f.t.id, type: 'WDK_USDT_EVM', status: 'CREATED', asset: 'USDT_ERC20', lockedAmount: '5' } })
  const row = (id: string, n: Node = A) => n.prisma.escrow.findUniqueOrThrow({ where: { id } })
  const input = (e: any) => ({ ...e, lockedAmount: e.lockedAmount.toString() })
  const seq = async () => (await prisma.$queryRawUnsafe<Array<{ last_value: bigint; is_called: boolean }>>('SELECT last_value, is_called FROM wdk_escrow_account_index_seq'))[0]
  const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, err: String(e.message) }))

  // ── J / K — allocation ─────────────────────────────────────────────────────────────────────────────

  it('J1-J6/K10: createEscrow allocates ALLOCATED_V1 in the same commit; a fresh node and a fresh client read the same identity', async () => {
    pg.requirePostgres('J')
    const f = await trade('j')
    const e = await create(A, f)
    expect(e.wdkAccountScheme).toBe('ALLOCATED_V1')
    expect(e.wdkAccountPath).toMatch(ALLOCATED)
    const B = node()
    expect((await row(e.id, B)).wdkAccountPath).toBe(e.wdkAccountPath)
    const fresh = load(true); extra.push(fresh)
    expect((await row(e.id, fresh)).wdkAccountPath).toBe(e.wdkAccountPath)
    // a retried createEscrow cannot create a second allocation for the trade
    expect((await settle(create(B, f))).ok).toBe(false)
    expect(await prisma.escrow.count({ where: { tradeId: f.t.id } })).toBe(1)
  })

  it('K1: two nodes create the escrow of the same trade concurrently — one escrow, one allocation', async () => {
    pg.requirePostgres('K1')
    const f = await trade('k1')
    const B = node()
    const results = await Promise.all([settle(create(A, f)), settle(create(B, f))])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const rows = await prisma.escrow.findMany({ where: { tradeId: f.t.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].wdkAccountPath).toMatch(ALLOCATED)
  })

  it('K2/K3: 10 service creations on two nodes and 100 concurrent direct inserts — every path distinct, none legacy, none the treasury', async () => {
    pg.requirePostgres('K2/K3')
    const B = node()
    const fs = await Promise.all(Array.from({ length: 110 }, (_, i) => trade(`k3-${i}`)))
    const viaService = await Promise.all(fs.slice(0, 10).map((f, i) => create(i % 2 ? B : A, f)))
    const direct = await Promise.all(fs.slice(10).map((f, i) => fixture(i % 2 ? B : A, f)))
    const paths = [...viaService, ...direct].map((e) => e.wdkAccountPath)
    expect(paths.every((p) => ALLOCATED.test(p))).toBe(true)
    expect(new Set(paths).size).toBe(110)
    expect([...viaService, ...direct].every((e) => e.wdkAccountScheme === 'ALLOCATED_V1')).toBe(true)
  })

  it('K4/K5/J9: a failure after the insert rolls the allocation back; the retry gets a new, never-reused index', async () => {
    pg.requirePostgres('K4')
    const f = await trade('k4')
    let attempted: string | null = null
    await expect(prisma.$transaction(async (tx) => {
      const e = await tx.escrow.create({ data: { tradeId: f.t.id, type: 'WDK_USDT_EVM', status: 'CREATED', asset: 'USDT_ERC20', lockedAmount: '5' } })
      attempted = e.wdkAccountPath
      throw new Error('crash before commit')
    })).rejects.toThrow('crash before commit')
    expect(await prisma.escrow.count({ where: { tradeId: f.t.id } })).toBe(0)
    const retry = await create(A, f)
    expect(retry.wdkAccountPath).not.toBe(attempted)
    expect(Number(retry.wdkAccountPath!.split('/')[2])).toBeGreaterThan(Number(attempted!.split('/')[2]))
  })

  it('K9/M16/M2: the unique index alone refuses a duplicate path — via a rewound sequence and via trigger-less direct SQL', async () => {
    pg.requirePostgres('K9')
    const f1 = await trade('k9a')
    const f2 = await trade('k9b')
    const e1 = await fixture(A, f1)
    const index = Number(e1.wdkAccountPath!.split('/')[2])
    const saved = await seq()
    try {
      await prisma.$executeRawUnsafe(`SELECT setval('wdk_escrow_account_index_seq', ${index}, false)`)
      await expect(fixture(A, f2)).rejects.toThrow(/wdkAccountPath|Unique constraint/)
    } finally {
      await prisma.$executeRawUnsafe(`SELECT setval('wdk_escrow_account_index_seq', ${saved.last_value}, ${saved.is_called})`)
    }
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE escrows DISABLE TRIGGER escrows_wdk_account_identity_guard')
      await tx.$executeRawUnsafe(
        `INSERT INTO escrows (id, "tradeId", type, status, asset, "lockedAmount", "updatedAt", "wdkAccountScheme", "wdkAccountPath")
         VALUES ('f6a1-dup-${randomBytes(4).toString('hex')}', $1, 'WDK_USDT_EVM', 'CREATED', 'USDT_ERC20', 5, now(), 'ALLOCATED_V1', $2)`, f2.t.id, e1.wdkAccountPath)
    })).rejects.toThrow(/escrows_wdkAccountPath_key|duplicate key/)
    expect(await prisma.escrow.count({ where: { tradeId: f2.t.id } })).toBe(0)
    expect((await fixture(A, f2)).wdkAccountPath).not.toBe(e1.wdkAccountPath)
  })

  // ── N / P — immutability and the authority discriminator ──────────────────────────────────────────

  it('N: the identity is set by the database only and never changes; ordinary lifecycle writes are unaffected', async () => {
    pg.requirePostgres('N')
    const f = await trade('n')
    const other = await trade('n2')
    const e = await fixture(A, f)
    const refuse = /WDK account identity|escrow bound to a WDK account|escrows_wdk_account_identity_check/
    // caller-chosen identity on insert
    await expect(prisma.escrow.create({ data: { tradeId: other.t.id, type: 'WDK_USDT_EVM', status: 'CREATED', asset: 'USDT_ERC20', lockedAmount: '5', wdkAccountScheme: 'ALLOCATED_V1', wdkAccountPath: "1'/0/999999999" } })).rejects.toThrow(refuse)
    await expect(prisma.escrow.create({ data: { tradeId: other.t.id, type: 'MOCK', status: 'CREATED', asset: 'USDT_ERC20', lockedAmount: '5', wdkAccountScheme: 'LEGACY_TRADE_HASH_V0', wdkAccountPath: "0'/0/5" } })).rejects.toThrow(refuse)
    // M5/M8: path/scheme change, via ORM and raw SQL
    await expect(prisma.escrow.update({ where: { id: e.id }, data: { wdkAccountPath: "1'/0/999999998" } })).rejects.toThrow(refuse)
    await expect(prisma.escrow.update({ where: { id: e.id }, data: { wdkAccountScheme: 'LEGACY_TRADE_HASH_V0' } })).rejects.toThrow(refuse)
    await expect(prisma.$executeRawUnsafe(`UPDATE escrows SET "wdkAccountPath" = NULL, "wdkAccountScheme" = NULL WHERE id = $1`, e.id)).rejects.toThrow(refuse)
    // M7: subject binding
    await expect(prisma.$executeRawUnsafe(`UPDATE escrows SET "tradeId" = $2 WHERE id = $1`, e.id, other.t.id)).rejects.toThrow(refuse)
    await expect(prisma.$executeRawUnsafe(`UPDATE escrows SET type = 'MOCK' WHERE id = $1`, e.id)).rejects.toThrow(refuse)
    await expect(prisma.$executeRawUnsafe(`UPDATE escrows SET id = 'f6a1-moved' WHERE id = $1`, e.id)).rejects.toThrow(refuse)
    // a non-WDK escrow can never acquire one
    const m = await prisma.escrow.create({ data: { tradeId: other.t.id, type: 'MOCK', status: 'CREATED', asset: 'USDT_ERC20', lockedAmount: '5' } })
    expect(m.wdkAccountPath).toBeNull()
    await expect(prisma.escrow.update({ where: { id: m.id }, data: { wdkAccountScheme: 'ALLOCATED_V1', wdkAccountPath: "1'/0/999999997" } })).rejects.toThrow(refuse)
    await expect(prisma.$executeRawUnsafe(`UPDATE escrows SET type = 'WDK_USDT_EVM' WHERE id = $1`, m.id)).rejects.toThrow(refuse)
    // lifecycle writes still work and keep the identity
    await prisma.escrow.update({ where: { id: e.id }, data: { status: 'FUNDS_LOCKED', multisigAddr: `addr:${e.wdkAccountPath}` } })
    const after = await row(e.id)
    expect([after.wdkAccountScheme, after.wdkAccountPath, after.status]).toEqual(['ALLOCATED_V1', e.wdkAccountPath, 'FUNDS_LOCKED'])
  })

  // ── S — capacity ──────────────────────────────────────────────────────────────────────────────────

  it('S/M17: the last non-hardened index (2^31-1) is allocated once; the next WDK insert fails, never wraps', async () => {
    pg.requirePostgres('S')
    const f1 = await trade('s1')
    const f2 = await trade('s2')
    const saved = await seq()
    try {
      await prisma.$executeRawUnsafe(`SELECT setval('wdk_escrow_account_index_seq', 2147483646, true)`)
      const last = await fixture(A, f1)
      expect(last.wdkAccountPath).toBe("1'/0/2147483647")
      await expect(fixture(A, f2)).rejects.toThrow(/maximum value/)
      expect(await prisma.escrow.count({ where: { tradeId: f2.t.id } })).toBe(0)
    } finally {
      await prisma.$executeRawUnsafe(`SELECT setval('wdk_escrow_account_index_seq', ${saved.last_value}, ${saved.is_called})`)
    }
  })

  // ── L / M / O — every operation, every node, derives the persisted identity ────────────────────

  it('L/M23: the LOCK recipient, the outbound signer and reconciliation derive the same persisted path on two nodes', async () => {
    pg.requirePostgres('L')
    const f = await trade('l')
    const e = input(await create(A, f))
    const B = node()
    const eB = input(await row(e.id, B))
    expect(await A.wdk.escrowAddress(e)).toBe(`addr:${e.wdkAccountPath}`) // the LOCK recipient (#235 R7G-F6B)
    const TX = { to: '0x0000000000000000000000000000000000000002', value: 0n }
    expect([await A.wdk.signEscrowTransaction(e, TX), await B.wdk.signEscrowTransaction(eB, TX)]).toEqual([`signed-by:${e.wdkAccountPath}`, `signed-by:${e.wdkAccountPath}`]) // every outbound leg (#235 R7G-F6C)
    for (const op of [() => B.wdk.releaseFunds(eB, '0xbuyer'), () => A.wdk.refundFunds(e), () => B.wdk.splitFunds(eB, '0xbuyer', '0xseller', 2500)]) {
      await expect(op()).rejects.toThrow(/executed only by the signed outbound authority/) // the retired transfer() path
    }
    await prisma.wdkTransferAttempt.create({ data: { escrowId: e.id, operationType: 'RELEASE', destination: '0xbuyer2', amount: '5', status: 'SUBMITTED', txHash: '0xsub', activeKey: null } })
    await A.wdk.reconcileTerminalTransfer(e, 'RELEASE', '0xbuyer2', '5')
    const escrowPaths = derivedPaths.filter((p) => p !== "0'/0/0")
    expect(new Set(escrowPaths)).toEqual(new Set([e.wdkAccountPath]))
    expect(mockTransfer).not.toHaveBeenCalled()
    expect(mockReceipt.mock.calls[mockReceipt.mock.calls.length - 1][0]).toBe(e.wdkAccountPath)
  })

  it('M14: two escrows of trades whose historical index collides get two accounts; the trade hash is never consulted', async () => {
    pg.requirePostgres('M14')
    const { escrowIndexFor } = require('../../src/modules/open-settlement/wdk-settlement.provider')
    expect(escrowIndexFor(COLLIDING[0])).toBe(escrowIndexFor(COLLIDING[1]))
    const [f1, f2] = [await trade('m14a', COLLIDING[0]), await trade('m14b', COLLIDING[1])]
    const [e1, e2] = [input(await create(A, f1)), input(await create(node(), f2))]
    expect(e1.wdkAccountPath).not.toBe(e2.wdkAccountPath)
    expect([await A.wdk.escrowAddress(e1), await A.wdk.escrowAddress(e2)]).toEqual([`addr:${e1.wdkAccountPath}`, `addr:${e2.wdkAccountPath}`])
    expect(derivedPaths).not.toContain(`0'/0/${escrowIndexFor(COLLIDING[0])}`)
  })

  it('O/M13: a persisted address that the path does not derive fails closed before anything is signed, and nothing is corrected', async () => {
    pg.requirePostgres('O')
    const f = await trade('o')
    const created = await create(A, f)
    await prisma.escrow.update({ where: { id: created.id }, data: { multisigAddr: '0xnot-this-account' } })
    const e = input(await row(created.id))
    for (const op of [() => A.wdk.escrowAddress(e), () => A.wdk.signEscrowTransaction(e, { to: '0x0000000000000000000000000000000000000002', value: 0n })]) {
      await expect(op()).rejects.toThrow(/not its persisted address 0xnot-this-account/)
    }
    expect(mockSign).not.toHaveBeenCalled()
    expect(mockTransfer).not.toHaveBeenCalled()
    const after = await row(created.id)
    expect([after.multisigAddr, after.wdkAccountPath]).toEqual(['0xnot-this-account', created.wdkAccountPath])
  })

  // ── migration preflight (SQL) ─────────────────────────────────────────────────────────────────────

  it('M12/M19/M25: the migration preflight aborts on two WDK escrows sharing a legacy account and names both', async () => {
    pg.requirePostgres('preflight SQL')
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/20261007120000_wdk_escrow_account_identity/migration.sql'), 'utf8')
    const helper = sql.slice(sql.indexOf('CREATE FUNCTION pg_temp.sails_wdk_legacy_index'), sql.indexOf('LANGUAGE sql IMMUTABLE;') + 'LANGUAGE sql IMMUTABLE;'.length)
    const check = sql.slice(sql.indexOf('DO $$'), sql.indexOf('END $$;') + 'END $$;'.length)
    const [f1, f2] = [await trade('pf-a', COLLIDING[0]).catch(() => null), await trade('pf-b', COLLIDING[1]).catch(() => null)]
    const ids = await Promise.all([COLLIDING[0], COLLIDING[1]].map(async (tradeId, i) =>
      (await prisma.escrow.findUnique({ where: { tradeId } }))?.id ?? (await fixture(A, (i ? f2 : f1)!)).id))
    let message = ''
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(helper)
      await tx.$executeRawUnsafe(check).catch((err: Error) => { message = err.message })
      throw new Error('rollback')
    }).catch(() => undefined)
    expect(message).toMatch(/share one legacy account/)
    for (const id of ids) expect(message).toContain(id)
  })
})
