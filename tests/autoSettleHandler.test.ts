/**
 * common/events/handlers.ts's openp2p.trade.created -> executeSettlement()
 * reaction — verifies it's gated behind config.features.autoSettleOnMatch
 * (default false) rather than firing unconditionally for every real trade,
 * per that handler's own doc comment (auto-releasing funds on every match
 * with no dispute-window step would be a dangerous default).
 */
export {} // see chatUnification.test.ts's identical comment — no top-level
// import/export otherwise leaks this file's top-level `const`s into the
// global scope, colliding with other require()-only test files.

let autoSettleOnMatch = false
jest.mock('../src/config', () => ({
  get config() {
    return { features: { autoSettleOnMatch } }
  },
}))

const mockExecuteSettlement = jest.fn().mockResolvedValue({})
jest.mock('../src/modules/open-settlement/settlement-orchestrator', () => ({
  executeSettlement: (...args: unknown[]) => mockExecuteSettlement(...args),
}))

const mockGetAccountAddress = jest.fn().mockResolvedValue('0xresolved-buyer-address')
jest.mock('../src/modules/open-settlement/wdk-settlement.provider', () => ({
  wdkSettlementProvider: { getAccountAddress: (...args: unknown[]) => mockGetAccountAddress(...args) },
  buyerIndexFor: (buyerId: string) => `index-for-${buyerId}`,
}))

jest.mock('../src/common/database', () => ({
  prisma: {
    trade: { update: jest.fn() },
    dispute: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { update: jest.fn() },
  },
}))

const handlers: Record<string, (payload: unknown) => Promise<void> | void> = {}
jest.mock('../src/common/events/event-bus', () => ({
  eventBus: {
    emit: jest.fn().mockResolvedValue(undefined),
    on: (event: string, handler: (payload: unknown) => Promise<void> | void) => {
      handlers[event] = handler
    },
    onDurable: jest.fn(),
  },
}))

jest.mock('../src/modules/open-p2p/reconciliation.service', () => ({
  reconciliationService: { reconcilePeerPair: jest.fn().mockResolvedValue([]) },
}))

jest.mock('../src/modules/open-p2p/chat-room-registry', () => ({
  broadcastToTrade: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerEventHandlers } = require('../src/common/events/handlers')

const tradeCreatedPayload = {
  tradeId: 'trade-1',
  offerId: 'offer-1',
  buyerId: 'buyer-1',
  sellerId: 'seller-1',
  asset: 'USDT_ERC20',
  amount: '20.5',
  priceUsd: '5.45',
}

describe('openp2p.trade.created -> executeSettlement (config-gated auto-settle)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    autoSettleOnMatch = false
    registerEventHandlers()
  })

  it('does nothing when autoSettleOnMatch is false (the default)', async () => {
    autoSettleOnMatch = false
    await handlers['openp2p.trade.created'](tradeCreatedPayload)

    expect(mockExecuteSettlement).not.toHaveBeenCalled()
    expect(mockGetAccountAddress).not.toHaveBeenCalled()
  })

  it('calls executeSettlement with the trade only when autoSettleOnMatch is true — never derives a buyer account (#235 R7G NF-B1)', async () => {
    autoSettleOnMatch = true
    await handlers['openp2p.trade.created'](tradeCreatedPayload)

    expect(mockGetAccountAddress).not.toHaveBeenCalled()
    expect(mockExecuteSettlement).toHaveBeenCalledWith({ tradeId: 'trade-1' })
  })

  it('does not throw when executeSettlement fails — a settlement failure must not crash the event dispatcher', async () => {
    autoSettleOnMatch = true
    mockExecuteSettlement.mockRejectedValueOnce(new Error('WDK provider unavailable'))

    await expect(handlers['openp2p.trade.created'](tradeCreatedPayload)).resolves.not.toThrow()
  })
})
