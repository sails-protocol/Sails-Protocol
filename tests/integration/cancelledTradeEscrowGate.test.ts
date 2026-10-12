// tests/integration/cancelledTradeEscrowGate.test.ts
//
// #235 R7G-A — CANCELLED_TRADE_NO_NEW_ECONOMIC_COMMITMENT_V1, on real PostgreSQL.
//
// Once a Trade is CANCELLED no new trade-backed Escrow may be created for it, and a manual cancellation
// (tradeService.updateStatus, #294) and createEscrow() have one durable order: both take the trade-lifecycle
// advisory lock (trade-lifecycle-lock.ts) before reading the Trade. Either the cancellation wins (CANCELLED,
// no escrow, createEscrow refused) or the escrow is committed first and the cancellation then follows #294's
// existing rules for a trade that has an escrow.
//
// The interleavings are forced, not hoped for: a test pauses one request at the exact point of interest
// (a proxied transaction client) and drives the other request from a second module graph — its own
// PrismaClient and connection pool, as another node would be — then observes the database while the first
// one waits. A "node" is an independent module graph (jest.isolateModules) on the same database.

import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

type Node = { prisma: any; escrowService: any; tradeService: any; feeSnapshot: any; providers: (type: string) => any; redis?: any }

describe('#235 R7G-A — a cancelled trade can take no new escrow (real PostgreSQL)', () => {
  jest.setTimeout(180_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let A: Node
  const extraNodes: Node[] = []
  const ownedUserIds: string[] = []

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    require('../../src/common/events/handlers').registerEventHandlers()
    A = {
      prisma,
      escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService,
      tradeService: require('../../src/modules/open-p2p/trade.service').tradeService,
      feeSnapshot: require('../../src/modules/open-settlement/escrow-fee-snapshot.service').escrowFeeSnapshotService,
      providers: require('../../src/modules/open-settlement/escrow-providers').getSettlementProvider,
    }
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    try {
      const named = await prisma.user.findMany({ where: { displayName: { startsWith: 'r7ga-' } }, select: { id: true } })
      const users = [...new Set([...ownedUserIds, ...named.map((u) => u.id)])]
      const tradeIds = (await prisma.trade.findMany({ where: { OR: [{ buyerId: { in: users } }, { sellerId: { in: users } }] }, select: { id: true } })).map((t) => t.id)
      const escrowIds = (await prisma.escrow.findMany({ where: { tradeId: { in: tradeIds } }, select: { id: true } })).map((e) => e.id)
      const refs = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('tradeId', 'escrowId', 'interactionId') AND table_name NOT IN ('trades', 'escrows')`
      for (let pass = 0; pass < 4; pass++) {
        for (const { table_name, column_name } of refs) {
          const ids = column_name === 'tradeId' ? tradeIds : escrowIds
          await prisma.$executeRawUnsafe(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1)`, ids).catch(() => undefined)
        }
      }
      await prisma.$executeRaw`DELETE FROM event_projection_claims WHERE "subjectId" = ANY(${tradeIds}) OR "subjectId" = ANY(${escrowIds})`
      await prisma.$executeRaw`UPDATE trades SET "escrowId" = NULL WHERE id = ANY(${tradeIds})`
      await prisma.$executeRaw`DELETE FROM escrows WHERE id = ANY(${escrowIds})`
      await prisma.$executeRaw`DELETE FROM trades WHERE id = ANY(${tradeIds})`
      await prisma.$executeRaw`DELETE FROM offers WHERE "userId" = ANY(${users})`
      await prisma.$executeRaw`DELETE FROM users WHERE id = ANY(${users})`
    } finally {
      for (const n of extraNodes) {
        await n.prisma.$disconnect().catch(() => undefined)
        await n.redis?.quit().catch(() => undefined)
      }
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  // ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

  /** A fresh module graph: its own PrismaClient (own connection pool), services and providers — another node. */
  function node(): Node {
    let n!: Node
    jest.isolateModules(() => {
      n = {
        prisma: require('../../src/common/database').prisma,
        escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService,
        tradeService: require('../../src/modules/open-p2p/trade.service').tradeService,
        feeSnapshot: require('../../src/modules/open-settlement/escrow-fee-snapshot.service').escrowFeeSnapshotService,
        providers: require('../../src/modules/open-settlement/escrow-providers').getSettlementProvider,
        redis: require('../../src/common/redis').redis,
      }
    })
    extraNodes.push(n)
    return n
  }

  /** An ACTIVE Trade (state fixture) with the given economic intent. */
  async function trade(label: string, asset = 'BTC', amount = '0.01') {
    const tag = randomBytes(5).toString('hex')
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `r7ga-${label}-s-${tag}` } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `r7ga-${label}-b-${tag}` } })
    ownedUserIds.push(seller.id, buyer.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: asset as any, side: 'SELL', priceUsd: '1', minAmount: '0.00000001', maxAmount: '100000000', paymentMethod: 'PIX' } })
    const t = await prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: asset as any, amount, priceUsd: '1', totalUsd: amount, status: 'ACTIVE' } })
    return { t, seller, buyer, amount, asset }
  }

  const escrowsOf = (tradeId: string) => prisma.escrow.findMany({ where: { tradeId } })
  const statusOf = async (tradeId: string) => (await prisma.trade.findUniqueOrThrow({ where: { id: tradeId } })).status
  const createdEvents = (tradeId: string) => prisma.durableEventRecord.count({ where: { correlationId: tradeId, eventName: 'settlement.escrow.created' } })
  const create = (n: Node, f: Awaited<ReturnType<typeof trade>>, input: Record<string, unknown> = {}) =>
    n.escrowService.createEscrow({ tradeId: f.t.id, asset: f.asset, lockedAmount: f.amount, ...input }, f.seller.id)
  const cancel = (n: Node, f: Awaited<ReturnType<typeof trade>>) => n.tradeService.updateStatus(f.t.id, 'CANCELLED', f.buyer.id)

  /** Every function on every provider instance of a node, spied, so "no provider call" is asserted. */
  function spyProviders(n: Node) {
    const spies: jest.SpyInstance[] = []
    for (const type of ['MULTISIG', 'LIGHTNING_HODL', 'WDK_USDT_EVM', 'SAFE_GUARD_EVM', 'MOCK']) {
      const provider = n.providers(type)
      let proto = Object.getPrototypeOf(provider)
      const names = new Set<string>()
      while (proto && proto !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(proto)) if (k !== 'constructor' && typeof provider[k] === 'function') names.add(k)
        proto = Object.getPrototypeOf(proto)
      }
      for (const k of names) spies.push(jest.spyOn(provider, k))
    }
    return { calls: () => spies.reduce((sum, s) => sum + s.mock.calls.length, 0), restore: () => spies.forEach((s) => s.mockRestore()) }
  }

  /**
   * Runs the node's NEXT interactive transaction through a client whose `model.method` resolves the real call
   * and then awaits `after(result)` — still inside the transaction, holding whatever it already locked.
   */
  function pauseInNextTransaction(n: Node, model: string, method: string, after: (result: unknown) => Promise<void>) {
    const original = n.prisma.$transaction.bind(n.prisma)
    const spy = jest.spyOn(n.prisma, '$transaction').mockImplementationOnce((fn: any, ...rest: any[]) =>
      original((tx: any) => fn(new Proxy(tx, {
        get(target, prop) {
          const value = Reflect.get(target, prop)
          if (prop === '$executeRaw' && model === '$executeRaw') {
            return async (...args: any[]) => { const r = await value.apply(target, args); await after(r); return r }
          }
          if (prop !== model) return typeof value === 'function' ? value.bind(target) : value
          return new Proxy(value, {
            get(delegate, m) {
              const fnv = Reflect.get(delegate, m)
              if (m !== method) return typeof fnv === 'function' ? fnv.bind(delegate) : fnv
              return async (...args: any[]) => { const r = await fnv.apply(delegate, args); await after(r); return r }
            },
          })
        },
      })), ...rest))
    return spy
  }

  /** Polls `probe` for `ms`; true as soon as it holds. */
  async function becomes(probe: () => Promise<boolean>, ms = 1500): Promise<boolean> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await probe()) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return probe()
  }

  // ─── T1-T4: sequential ────────────────────────────────────────────────────────────────────────────────

  it('T1: an ACTIVE trade takes its canonical escrow', async () => {
    pg.requirePostgres('T1')
    const f = await trade('t1')
    const e = await create(A, f)
    expect([e.tradeId, e.asset, e.lockedAmount.toString(), e.status]).toEqual([f.t.id, 'BTC', '0.01', 'CREATED'])
    expect(await createdEvents(f.t.id)).toBe(1)
  })

  it('T2/T3: a trade cancelled before createEscrow begins is refused — no escrow, no event, no provider call', async () => {
    pg.requirePostgres('T2/T3')
    const f = await trade('t2')
    await cancel(A, f)
    expect(await statusOf(f.t.id)).toBe('CANCELLED')
    const providers = spyProviders(A)
    try {
      await expect(create(A, f)).rejects.toThrow(/is CANCELLED: no new escrow/)
      expect(await escrowsOf(f.t.id)).toEqual([])
      expect(await createdEvents(f.t.id)).toBe(0)
      expect(providers.calls()).toBe(0)
    } finally {
      providers.restore()
    }
  })

  it('T4: an escrow committed before the cancellation begins — #294 rules apply (CREATED is not escrow-governed: cancel allowed; a governed escrow refuses it)', async () => {
    pg.requirePostgres('T4')
    const f = await trade('t4')
    const e = await create(A, f)
    await cancel(A, f)
    expect(await statusOf(f.t.id)).toBe('CANCELLED')
    expect((await escrowsOf(f.t.id)).map((x) => [x.id, x.status])).toEqual([[e.id, 'CREATED']])

    const g = await trade('t4g')
    const eg = await create(A, g)
    await prisma.escrow.update({ where: { id: eg.id }, data: { status: 'DISPUTED' } })
    await expect(cancel(A, g)).rejects.toThrow(/escrow is DISPUTED and governs the outcome/)
    expect(await statusOf(g.t.id)).toBe('ACTIVE')
  })

  // ─── forced interleavings (both orders), across two nodes ─────────────────────────────────────────────

  it('T5a/H: createEscrow passed its pre-check, then node B cancels — the escrow is refused under the lock (no post-cancellation escrow)', async () => {
    pg.requirePostgres('T5a')
    const f = await trade('x')
    const B = node()
    const original = A.feeSnapshot.computeSnapshotFields.bind(A.feeSnapshot)
    const spy = jest.spyOn(A.feeSnapshot, 'computeSnapshotFields').mockImplementationOnce(async (...args: any[]) => {
      await cancel(B, f) // between createEscrow's unlocked pre-check (ACTIVE) and its locked insert
      return original(...args)
    })
    try {
      await expect(create(A, f)).rejects.toThrow(/is CANCELLED: no new escrow/)
    } finally {
      spy.mockRestore()
    }
    expect(await statusOf(f.t.id)).toBe('CANCELLED')
    expect(await escrowsOf(f.t.id)).toEqual([])
    expect(await createdEvents(f.t.id)).toBe(0)
  })

  it('T5b/H: node A\'s cancellation holds the lock and has read "no escrow"; node B\'s createEscrow cannot commit until it is done, then is refused', async () => {
    pg.requirePostgres('T5b')
    const f = await trade('y')
    const B = node()
    let creation!: Promise<unknown>
    let escrowAppearedWhileCancelHeld = false
    const spy = pauseInNextTransaction(A, 'escrow', 'findUnique', async () => {
      creation = create(B, f).then(() => 'created', (err: Error) => err.message)
      escrowAppearedWhileCancelHeld = await becomes(async () => (await escrowsOf(f.t.id)).length > 0)
    })
    try {
      await cancel(A, f)
    } finally {
      spy.mockRestore()
    }
    expect(escrowAppearedWhileCancelHeld).toBe(false)
    expect(await creation).toMatch(/is CANCELLED: no new escrow/)
    expect(await statusOf(f.t.id)).toBe('CANCELLED')
    expect(await escrowsOf(f.t.id)).toEqual([])
  })

  it('T5c/H: node A\'s createEscrow holds the lock and has read ACTIVE; node B\'s cancellation cannot commit until the escrow does, then follows #294', async () => {
    pg.requirePostgres('T5c')
    const f = await trade('z')
    const B = node()
    let cancellation!: Promise<unknown>
    let cancelledWhileCreateHeld = false
    const spy = pauseInNextTransaction(A, 'trade', 'findUnique', async () => {
      cancellation = cancel(B, f).then(() => 'cancelled', (err: Error) => err.message)
      cancelledWhileCreateHeld = await becomes(async () => (await statusOf(f.t.id)) === 'CANCELLED')
    })
    let e: any
    try {
      e = await create(A, f)
    } finally {
      spy.mockRestore()
    }
    expect(cancelledWhileCreateHeld).toBe(false)
    expect(await cancellation).toBe('cancelled') // CREATED is not escrow-governed (#294): the later cancellation is allowed
    expect((await escrowsOf(f.t.id)).map((x) => x.id)).toEqual([e.id])
    expect(await statusOf(f.t.id)).toBe('CANCELLED')
  })

  it('T5d: the escrow row is only ever inserted inside the locked transaction — an insert outside it would follow a committed cancellation', async () => {
    pg.requirePostgres('T5d')
    const f = await trade('w')
    const B = node()
    let cancelledBeforeInsert = false
    const original = A.prisma.escrow.create.bind(A.prisma.escrow)
    const spy = jest.spyOn(A.prisma.escrow, 'create').mockImplementation(async (...args: any[]) => {
      await cancel(B, f)
      cancelledBeforeInsert = true
      return original(...args)
    })
    try {
      await create(A, f).catch(() => undefined)
    } finally {
      spy.mockRestore()
    }
    const rows = await escrowsOf(f.t.id)
    expect(cancelledBeforeInsert && rows.length > 0).toBe(false)
    expect(rows).toHaveLength(1)
    expect(await statusOf(f.t.id)).toBe('ACTIVE')
  })

  it('T5/T6: unforced races between cancel and createEscrow on two nodes, repeated — every outcome is legal, both orders occur', async () => {
    pg.requirePostgres('T5/T6')
    const B = node()
    const outcomes: Record<string, number> = {}
    for (let i = 0; i < 24; i++) {
      const f = await trade(`r${i}`)
      const [c, x] = i % 2 ? [A, B] : [B, A]
      // The two paths differ in length, so a simultaneous start is biased towards one order; a varying head
      // start, alternately for each side, makes both orders happen.
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const head = (i % 6) * 10
      const [created, cancelled] = await Promise.allSettled([
        delay(i % 2 ? head : 0).then(() => create(c, f)),
        delay(i % 2 ? 0 : head).then(() => cancel(x, f)),
      ])
      const rows = await escrowsOf(f.t.id)
      const status = await statusOf(f.t.id)
      expect(cancelled.status).toBe('fulfilled') // with no escrow, or a CREATED one, cancellation is always allowed
      expect(status).toBe('CANCELLED')
      if (created.status === 'fulfilled') {
        expect(rows.map((r) => r.id)).toEqual([created.value.id]) // escrow first, cancellation followed it
        outcomes.escrowFirst = (outcomes.escrowFirst ?? 0) + 1
      } else {
        expect(String(created.reason?.message)).toMatch(/is CANCELLED: no new escrow/)
        expect(rows).toEqual([])
        outcomes.cancelFirst = (outcomes.cancelFirst ?? 0) + 1
      }
    }
    expect(outcomes.escrowFirst ?? 0).toBeGreaterThan(0)
    expect(outcomes.cancelFirst ?? 0).toBeGreaterThan(0)
  })

  // ─── restart ──────────────────────────────────────────────────────────────────────────────────────────

  it('T7: node A cancels; node B (fresh module graph, as after a restart) is refused', async () => {
    pg.requirePostgres('T7')
    const f = await trade('t7')
    await cancel(A, f)
    await expect(create(node(), f)).rejects.toThrow(/is CANCELLED: no new escrow/)
    expect(await escrowsOf(f.t.id)).toEqual([])
  })

  it('T8: node A creates the escrow; node B (fresh module graph) cancels under #294\'s rules', async () => {
    pg.requirePostgres('T8')
    const f = await trade('t8')
    const e = await create(A, f)
    await cancel(node(), f)
    expect(await statusOf(f.t.id)).toBe('CANCELLED')
    expect((await escrowsOf(f.t.id)).map((x) => x.id)).toEqual([e.id])
  })

  // ─── races combined with R7F-B ────────────────────────────────────────────────────────────────────────

  it('T9: several concurrent createEscrow calls on two nodes plus a cancellation — at most one escrow, never after the cancellation won', async () => {
    pg.requirePostgres('T9')
    const B = node()
    for (let i = 0; i < 6; i++) {
      const f = await trade(`t9-${i}`)
      const results = await Promise.allSettled([create(A, f), create(B, f), cancel(i % 2 ? A : B, f), create(A, f), create(B, f)])
      const created = results.filter((r, k) => k !== 2 && r.status === 'fulfilled')
      const rows = await escrowsOf(f.t.id)
      expect(rows.length).toBeLessThanOrEqual(1)
      expect(created).toHaveLength(rows.length)
      expect(results[2].status).toBe('fulfilled')
      expect(await statusOf(f.t.id)).toBe('CANCELLED')
    }
  })

  it.each([
    ['T10 wrong asset', 'BTC', '0.01', { asset: 'USDT_ERC20' }, /does not match trade/],
    ['T11 wrong amount', 'BTC', '0.01', { lockedAmount: '0.0100001' }, /does not equal trade/],
    ['T12 unsupported AssetType', 'LN_BTC', '0.01', {}, /no authorized settlement translation/],
  ])('%s raced against a cancellation: refused by R7F-B, never an escrow', async (_label, asset, amount, wrong, message) => {
    pg.requirePostgres(String(_label))
    const B = node()
    for (let i = 0; i < 4; i++) {
      const f = await trade(`bind-${i}`, asset as string, amount as string)
      const [created, cancelled] = await Promise.allSettled([create(i % 2 ? A : B, f, wrong as Record<string, unknown>), cancel(i % 2 ? B : A, f)])
      expect(created.status).toBe('rejected')
      expect(String((created as PromiseRejectedResult).reason?.message)).toMatch(new RegExp(`${(message as RegExp).source}|is CANCELLED: no new escrow`))
      expect(cancelled.status).toBe('fulfilled')
      expect(await escrowsOf(f.t.id)).toEqual([])
    }
  })

  // ─── crash / rollback ─────────────────────────────────────────────────────────────────────────────────

  const boom = async () => { throw new Error('injected crash') }

  it.each([
    ['C1 createEscrow: after acquiring the lock, before reading the trade', '$executeRaw', ''],
    ['C2 createEscrow: after reading the trade, before the insert', 'trade', 'findUnique'],
    ['C3 createEscrow: after the insert, before commit', 'escrow', 'create'],
  ])('%s — rollback leaves no escrow and releases the lock', async (_label, model, method) => {
    pg.requirePostgres(String(_label))
    const f = await trade('c-create')
    const spy = pauseInNextTransaction(A, model as string, method as string, boom)
    try {
      await expect(create(A, f)).rejects.toThrow('injected crash')
    } finally {
      spy.mockRestore()
    }
    expect(await escrowsOf(f.t.id)).toEqual([])
    expect(await createdEvents(f.t.id)).toBe(0)
    expect(await statusOf(f.t.id)).toBe('ACTIVE')
    const e = await create(node(), f) // the lock and the tradeId slot are free again, for any node
    expect((await escrowsOf(f.t.id)).map((x) => x.id)).toEqual([e.id])
  })

  it.each([
    ['C4 cancellation: after acquiring the lock, before persisting CANCELLED', 'escrow', 'findUnique'],
    ['C5 cancellation: after the CANCELLED write, before commit', 'trade', 'findUnique'],
  ])('%s — rollback leaves the trade ACTIVE and releases the lock', async (_label, model, method) => {
    pg.requirePostgres(String(_label))
    const f = await trade('c-cancel')
    const spy = pauseInNextTransaction(A, model as string, method as string, boom)
    try {
      await expect(cancel(A, f)).rejects.toThrow('injected crash')
    } finally {
      spy.mockRestore()
    }
    expect(await statusOf(f.t.id)).toBe('ACTIVE')
    const e = await create(node(), f)
    expect((await escrowsOf(f.t.id)).map((x) => x.id)).toEqual([e.id])
  })
})
