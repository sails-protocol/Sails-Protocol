/**
 * Missão 04 — TradeService.updateStatus()'s manual-transition guard, in
 * isolation. No HTTP, no shared rate-limit budget (this codebase's own
 * established lesson — see liquidityProposeForIntent.test.ts's identical
 * header note): a plain fake TradeRepository passed straight into
 * TradeService's constructor, same DI convention every service in this
 * codebase already supports.
 */
const mockUpdateStatus = jest.fn()
const mockFindById = jest.fn()
const mockEmit = jest.fn().mockResolvedValue(undefined)

jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: (...args: unknown[]) => mockEmit(...args) },
}))
jest.mock('../src/core/intent-engine', () => ({
  intentEngine: { transition: jest.fn().mockResolvedValue(undefined) },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TradeService } = require('../src/modules/open-p2p/trade.service')

function fakeRepo(overrides: Record<string, unknown> = {}) {
  return {
    findOfferById: jest.fn(),
    create: jest.fn(),
    findById: (...args: unknown[]) => mockFindById(...args),
    findByIdWithDetails: jest.fn(),
    findByIntentId: jest.fn(),
    findByIdWithEscrow: jest.fn(),
    findManyByParticipant: jest.fn(),
    countByParticipant: jest.fn(),
    findActiveTradeIdsBetween: jest.fn(),
    updateStatus: jest.fn(),
    // Issue #294 - manual transitions are CAS-guarded and refused once the Escrow governs the outcome.
    transitionManually: (...args: unknown[]) => mockUpdateStatus(...args),
    ...overrides,
  }
}

const trade = (status: string) => ({
  id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', status, intentId: null,
})

describe('TradeService.updateStatus() — manual-transition guard (Missão 04)', () => {
  beforeEach(() => {
    mockFindById.mockReset()
    mockUpdateStatus.mockReset()
    mockUpdateStatus.mockResolvedValue({ ok: true, trade: { id: 'trade-1', status: 'CANCELLED' } })
  })

  it('allows PENDING -> CANCELLED', async () => {
    mockFindById.mockResolvedValue(trade('PENDING'))
    const service = new TradeService(fakeRepo())
    await service.updateStatus('trade-1', 'CANCELLED', 'buyer-1')
    expect(mockUpdateStatus).toHaveBeenCalled()
  })

  it('allows PENDING -> ACTIVE', async () => {
    mockFindById.mockResolvedValue(trade('PENDING'))
    mockUpdateStatus.mockResolvedValue({ ok: true, trade: { id: 'trade-1', status: 'ACTIVE' } })
    const service = new TradeService(fakeRepo())
    await service.updateStatus('trade-1', 'ACTIVE', 'buyer-1')
    expect(mockUpdateStatus).toHaveBeenCalled()
  })

  it('allows ACTIVE -> CANCELLED', async () => {
    mockFindById.mockResolvedValue(trade('ACTIVE'))
    const service = new TradeService(fakeRepo())
    await service.updateStatus('trade-1', 'CANCELLED', 'buyer-1')
    expect(mockUpdateStatus).toHaveBeenCalled()
  })

  it('Issue #294: a manual cancel is refused once the Escrow already governs the outcome (ESCROW_GOVERNED)', async () => {
    mockFindById.mockResolvedValue(trade('ACTIVE'))
    mockUpdateStatus.mockResolvedValue({ ok: false, reason: 'ESCROW_GOVERNED', escrowStatus: 'DISPUTED' })
    const service = new TradeService(fakeRepo())
    await expect(service.updateStatus('trade-1', 'CANCELLED', 'buyer-1')).rejects.toThrow(/its escrow is DISPUTED and governs the outcome/)
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('Issue #294: a manual transition whose validated status changed concurrently is refused (STALE_STATUS), not applied', async () => {
    mockFindById.mockResolvedValue(trade('PENDING'))
    mockUpdateStatus.mockResolvedValue({ ok: false, reason: 'STALE_STATUS' })
    const service = new TradeService(fakeRepo())
    await expect(service.updateStatus('trade-1', 'CANCELLED', 'buyer-1')).rejects.toThrow(/changed concurrently/)
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('rejects COMPLETED -> CANCELLED — settlement already happened, the record cannot be rewritten', async () => {
    mockFindById.mockResolvedValue(trade('COMPLETED'))
    const service = new TradeService(fakeRepo())
    await expect(service.updateStatus('trade-1', 'CANCELLED', 'buyer-1')).rejects.toThrow(
      /cannot transition from COMPLETED to CANCELLED/
    )
    expect(mockUpdateStatus).not.toHaveBeenCalled()
  })

  it('rejects DISPUTED -> CANCELLED — must go through dispute resolution, not a unilateral status flip', async () => {
    mockFindById.mockResolvedValue(trade('DISPUTED'))
    const service = new TradeService(fakeRepo())
    await expect(service.updateStatus('trade-1', 'CANCELLED', 'seller-1')).rejects.toThrow(
      /cannot transition from DISPUTED to CANCELLED/
    )
    expect(mockUpdateStatus).not.toHaveBeenCalled()
  })

  it('rejects CANCELLED -> CANCELLED — idempotent duplicate, not silently accepted', async () => {
    mockFindById.mockResolvedValue(trade('CANCELLED'))
    const service = new TradeService(fakeRepo())
    await expect(service.updateStatus('trade-1', 'CANCELLED', 'buyer-1')).rejects.toThrow(/cannot transition/)
    expect(mockUpdateStatus).not.toHaveBeenCalled()
  })

  it('rejects CANCELLED -> ACTIVE — a cancelled trade cannot be revived', async () => {
    mockFindById.mockResolvedValue(trade('CANCELLED'))
    const service = new TradeService(fakeRepo())
    await expect(service.updateStatus('trade-1', 'ACTIVE', 'buyer-1')).rejects.toThrow(/cannot transition/)
    expect(mockUpdateStatus).not.toHaveBeenCalled()
  })

  it('rejects COMPLETED -> ACTIVE', async () => {
    mockFindById.mockResolvedValue(trade('COMPLETED'))
    const service = new TradeService(fakeRepo())
    await expect(service.updateStatus('trade-1', 'ACTIVE', 'buyer-1')).rejects.toThrow(/cannot transition/)
    expect(mockUpdateStatus).not.toHaveBeenCalled()
  })

  it('still rejects a non-party from transitioning the trade at all — ownership checked before the state guard', async () => {
    mockFindById.mockResolvedValue(trade('PENDING'))
    const service = new TradeService(fakeRepo())
    await expect(service.updateStatus('trade-1', 'CANCELLED', 'attacker')).rejects.toThrow(/is not a party/)
    expect(mockUpdateStatus).not.toHaveBeenCalled()
  })
})
