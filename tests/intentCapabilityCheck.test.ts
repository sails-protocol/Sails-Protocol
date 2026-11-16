/**
 * RFC-014's first real capability-registry.ts caller: intentEngine.create()
 * for TradeIntent. Gated behind config.features.enforceCapabilities
 * (default false) — same "mock config with a mutable getter" pattern
 * tests/autoSettleHandler.test.ts already established for testing a
 * config-gated code path without needing a real env var per test. A
 * separate file from settlementCapabilityCheck.test.ts (not one combined
 * file) because jest.mock() calls are hoisted to module scope regardless
 * of which describe block they're written in — two conflicting mocks of
 * ../src/common/database in one file would silently collide.
 */
export {} // see chatUnification.test.ts's identical comment

let enforceCapabilities = false
jest.mock('../src/config', () => ({
  get config() {
    return { features: { enforceCapabilities } }
  },
}))

const mockCheck = jest.fn()
jest.mock('../src/core/capability-registry', () => ({
  capabilityRegistry: { check: (...args: unknown[]) => mockCheck(...args) },
  CAPABILITY_IMPLEMENTATIONS: { openp2p: 'trade-coordination', opensettlement: 'settlement' },
}))

const mockIntentCreate = jest.fn()
const mockIntentFindUnique = jest.fn()
const mockIntentUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
const mockIntentEventCreate = jest.fn()
const mockIntentEventFindFirst = jest.fn()

jest.mock('../src/common/database', () => {
  // Issue #253: transition() commits the CAS + IntentEvent in ONE prisma.$transaction (same client here).
  const prisma: any = {
    intent: {
      create: (...args: unknown[]) => mockIntentCreate(...args),
      findUnique: (...args: unknown[]) => mockIntentFindUnique(...args),
      findUniqueOrThrow: (...args: unknown[]) => mockIntentFindUnique(...args),
      // Robustness-audit fix (2026-07-20) — see intent-engine.ts's own
      // comment: transition() claims via an atomic updateMany() now.
      updateMany: (...args: unknown[]) => mockIntentUpdateMany(...args),
    },
    intentEvent: {
      create: async (...args: unknown[]) => (await mockIntentEventCreate(...args)) ?? { id: 'intent-event-1' },
      findFirst: (...args: unknown[]) => mockIntentEventFindFirst(...args),
      updateMany: async () => ({ count: 1 }),
    },
  }
  prisma.$transaction = (cb: (tx: unknown) => unknown) => cb(prisma)
  return { prisma }
})

const mockEmit = jest.fn().mockResolvedValue(undefined)
jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: (...args: unknown[]) => mockEmit(...args) },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { intentEngine } = require('../src/core/intent-engine')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OpenP2PTradeIntentHandler } = require('../src/modules/open-p2p/intent-handler')

// RFC-018 Phase 3 — validateStructure() delegates to whichever handler is
// registered for the Intent type; register the real one here the same
// way app.ts's buildApp() does at real boot.
intentEngine.registerHandler(OpenP2PTradeIntentHandler)

const payload = { asset: 'BTC', side: 'BUY' as const, maxValue: '0.5', minValue: '0.01' }

describe('intentEngine.create() — RFC-014 capability check (TradeIntent)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    enforceCapabilities = false
    mockIntentEventFindFirst.mockResolvedValue(null)
    mockIntentCreate.mockResolvedValue({
      id: 'intent-1', type: 'TradeIntent', participantId: 'user-1', moduleId: 'openp2p',
      status: 'CREATED', payload,
    })
    // Robustness-audit fix (2026-07-20): each transition() call now reads
    // Intent twice (claim + re-fetch, since updateMany() doesn't return
    // the row) — see intentFlow.test.ts's identical comment for the full
    // call-by-call breakdown.
    mockIntentFindUnique
      .mockResolvedValueOnce({ id: 'intent-1', status: 'CREATED', moduleId: 'openp2p', payload })
      .mockResolvedValueOnce({ id: 'intent-1', status: 'VALIDATED', moduleId: 'openp2p', payload })
      .mockResolvedValueOnce({ id: 'intent-1', status: 'VALIDATED', moduleId: 'openp2p', payload })
      .mockResolvedValueOnce({ id: 'intent-1', status: 'VALIDATED', moduleId: 'openp2p', payload })
      .mockResolvedValueOnce({ id: 'intent-1', status: 'COORDINATED', moduleId: 'openp2p', payload })
  })

  it('never calls capabilityRegistry.check when enforceCapabilities is false (the default)', async () => {
    enforceCapabilities = false
    await intentEngine.create('TradeIntent', payload, 'user-1')
    expect(mockCheck).not.toHaveBeenCalled()
    expect(mockIntentCreate).toHaveBeenCalled()
  })

  it('rejects with ForbiddenError, before ever calling Prisma, when enforcement is on and no grant covers it', async () => {
    enforceCapabilities = true
    mockCheck.mockResolvedValue(false)

    await expect(intentEngine.create('TradeIntent', payload, 'user-1')).rejects.toThrow(
      /no active 'trade-coordination' capability grant/
    )
    expect(mockCheck).toHaveBeenCalledWith('user-1', 'trade-coordination', 'intent.created')
    expect(mockIntentCreate).not.toHaveBeenCalled()
  })

  it('proceeds normally when enforcement is on and a grant covers it', async () => {
    enforceCapabilities = true
    mockCheck.mockResolvedValue(true)

    const intent = await intentEngine.create('TradeIntent', payload, 'user-1')
    expect(intent.status).toBe('COORDINATED')
    expect(mockCheck).toHaveBeenCalledWith('user-1', 'trade-coordination', 'intent.created')
    expect(mockIntentCreate).toHaveBeenCalled()
  })
})
