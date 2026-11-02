// tests/integration/intentTransitionAtomicity.test.ts
//
// Issue #253 (Intent atomicity mission) - on real PostgreSQL. An Intent transition is three facts:
//   (1) the status change (CAS), (2) its IntentEvent history row, (3) the published domain event.
// (1)+(2) must be ONE database transaction; (3) cannot share a transaction with the event bus, so it is owed
// durably by (2) and recovered by recoverUnpublishedIntentEvents() if the process dies before it happens.
//
// The crash between (1) and (2) is injected by a DATABASE trigger that rejects the IntentEvent insert: it hits
// the old (two statements) and the new (one transaction) implementation alike, so the same test is RED before
// the fix and GREEN after, with no knowledge of how the engine is built.

import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const FAULT = 'fault:intent-event-insert'

describe('Intent transition atomicity + recoverable publication (real PostgreSQL)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let eventBus: any
  let intentEngine: any
  let createIntentEngine: any
  let recover: (opts?: { graceMs?: number }) => Promise<{ republished: string[]; markedPublished: string[]; failed: Array<{ intentEventId: string; error: string }> }>
  let liquidityRouter: any
  let tradeService: any

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ eventBus } = require('../../src/common/events/event-bus'))
    ;({ intentEngine, createIntentEngine } = require('../../src/core/intent-engine'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    intentEngine.registerHandler(require('../../src/modules/open-p2p/intent-handler').OpenP2PTradeIntentHandler)
    recover = (opts) => require('../../src/core/intent-publication-recovery').recoverUnpublishedIntentEvents(opts)

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_intent_event_fault() RETURNS trigger AS $$
      BEGIN
        IF NEW."triggeredBy" = '${FAULT}' THEN RAISE EXCEPTION 'SIMULATED_CRASH on intent_events insert'; END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`)
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_intent_event_fault_trg ON intent_events')
    await prisma.$executeRawUnsafe('CREATE TRIGGER test_intent_event_fault_trg BEFORE INSERT ON intent_events FOR EACH ROW EXECUTE FUNCTION test_intent_event_fault()')
  })

  afterAll(async () => {
    jest.restoreAllMocks()
    if (dbAvailable) {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_intent_event_fault_trg ON intent_events')
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  async function negotiatingIntent(): Promise<string> {
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    expect((await prisma.intent.findUnique({ where: { id: trade.intentId } }))!.status).toBe('NEGOTIATING')
    return trade.intentId as string
  }

  const commit = (engine: any, intentId: string, by = 'probe') =>
    engine.transition(intentId, 'COMMITTED', by, 'intent.committed', { intentId, settlementId: 'settle-1', terms: null })

  // The process dies after the transaction committed and before the event is published.
  async function crashNextPublish(run: () => Promise<unknown>): Promise<void> {
    const spy = jest.spyOn(eventBus, 'emit').mockImplementationOnce((async () => { throw new Error('SIMULATED_CRASH before publish') }) as never)
    try {
      await expect(run()).rejects.toThrow(/SIMULATED_CRASH before publish/)
    } finally {
      spy.mockRestore()
    }
  }

  const status = async (id: string) => (await prisma.intent.findUnique({ where: { id } }))!.status
  const historyTo = (id: string, toStatus: string) => prisma.intentEvent.count({ where: { intentId: id, toStatus } })
  const durable = (id: string, eventName: string) => prisma.durableEventRecord.count({ where: { correlationId: id, eventName } })

  it('crash between the status CAS and the IntentEvent insert rolls BOTH back, and the retry then succeeds', async () => {
    pg.requirePostgres('intent atomicity')
    const id = await negotiatingIntent()

    await expect(commit(createIntentEngine(), id, FAULT)).rejects.toThrow(/SIMULATED_CRASH/)
    // old code: status COMMITTED with no IntentEvent (a transition with no history that no retry can repair)
    expect(await status(id)).toBe('NEGOTIATING')
    expect(await historyTo(id, 'COMMITTED')).toBe(0)
    expect(await durable(id, 'intent.committed')).toBe(0)

    await commit(createIntentEngine(), id)
    expect(await status(id)).toBe('COMMITTED')
    expect(await historyTo(id, 'COMMITTED')).toBe(1)
    expect(await durable(id, 'intent.committed')).toBe(1)
  })

  it('crash after the commit and before the publication: the IntentEvent owes the publication and recovery pays it exactly once', async () => {
    pg.requirePostgres('intent publication crash')
    const id = await negotiatingIntent()

    await crashNextPublish(() => commit(createIntentEngine(), id))

    // state and history are durable and consistent; the event itself is not yet published
    expect(await status(id)).toBe('COMMITTED')
    expect(await historyTo(id, 'COMMITTED')).toBe(1)
    expect(await durable(id, 'intent.committed')).toBe(0)

    // within the grace window a live publisher may still be about to publish: recovery must not race it
    expect((await recover({ graceMs: 60_000 })).republished).toHaveLength(0)
    expect(await durable(id, 'intent.committed')).toBe(0)

    const first = await recover({ graceMs: 0 })
    expect(first.failed).toEqual([])
    expect(await durable(id, 'intent.committed')).toBe(1)
    expect(first.republished.length).toBeGreaterThanOrEqual(1)

    // re-delivery of the same recovery: nothing more is published
    await recover({ graceMs: 0 })
    expect(await durable(id, 'intent.committed')).toBe(1)
    expect(await historyTo(id, 'COMMITTED')).toBe(1)
  })

  it('retry after restart is rejected as an invalid transition and adds neither history nor events', async () => {
    pg.requirePostgres('intent retry')
    const id = await negotiatingIntent()
    await commit(createIntentEngine(), id)

    await expect(commit(createIntentEngine(), id)).rejects.toThrow(/Invalid Intent transition: COMMITTED/)
    expect(await historyTo(id, 'COMMITTED')).toBe(1)
    expect(await durable(id, 'intent.committed')).toBe(1)
  })

  it('two instances racing the same transition: exactly one wins, one history row, one event, intact hash chain', async () => {
    pg.requirePostgres('intent concurrency')
    const id = await negotiatingIntent()

    const results = await Promise.allSettled([commit(createIntentEngine(), id, 'a'), commit(createIntentEngine(), id, 'b'), commit(createIntentEngine(), id, 'c')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/concurrent request|Invalid Intent transition/)

    expect(await historyTo(id, 'COMMITTED')).toBe(1)
    expect(await durable(id, 'intent.committed')).toBe(1)

    const chain = await prisma.intentEvent.findMany({ where: { intentId: id }, orderBy: { createdAt: 'asc' } })
    expect(chain.length).toBeGreaterThan(1)
    expect(chain[0].prevHash).toBe('genesis')
    for (let i = 1; i < chain.length; i++) expect(chain[i].prevHash).toBe(chain[i - 1].entryHash)
  })

  it('concurrent recovery workers publish the owed event exactly once', async () => {
    pg.requirePostgres('intent recovery concurrency')
    const id = await negotiatingIntent()
    await crashNextPublish(() => commit(createIntentEngine(), id))

    const reports = await Promise.all([recover({ graceMs: 0 }), recover({ graceMs: 0 }), recover({ graceMs: 0 }), recover({ graceMs: 0 })])
    expect(reports.flatMap((r) => r.failed)).toEqual([])
    expect(reports.flatMap((r) => r.republished)).toHaveLength(1) // exactly one worker published it
    expect(await durable(id, 'intent.committed')).toBe(1)
  })

  it('an invalid transition changes nothing', async () => {
    pg.requirePostgres('intent invalid transition')
    const id = await negotiatingIntent()
    const before = await prisma.intentEvent.count({ where: { intentId: id } })

    await expect(intentEngine.transition(id, 'FULFILLED', 'probe', 'intent.fulfilled', { intentId: id, settlementId: 's', outcome: null })).rejects.toThrow(/Invalid Intent transition/)
    expect(await status(id)).toBe('NEGOTIATING')
    expect(await prisma.intentEvent.count({ where: { intentId: id } })).toBe(before)
  })
})
