/**
 * common/events/handlers.ts's dispute.evidence_submitted -> QVAC
 * auto-resolution reaction (RFC-021 D8) — verifies it's gated behind
 * config.settlement.qvacAutoResolutionEnabled (default false) rather than
 * running a real QVAC call on every evidence submission unconditionally,
 * same "config-gated handler reacting to an event, calling a service"
 * shape tests/socialEngineeringDetection.test.ts already established for
 * its own QVAC-backed handler.
 */
export {} // see autoSettleHandler.test.ts's identical comment

let qvacAutoResolutionEnabled = false
let qvacAutoResolutionConfidenceThreshold = 0.85
jest.mock('../src/config', () => ({
  get config() {
    return {
      features: { autoSettleOnMatch: false, socialEngineeringDetection: false },
      settlement: { qvacAutoResolutionEnabled, qvacAutoResolutionConfidenceThreshold },
    }
  },
}))

const mockAssessDisputeEvidence = jest.fn()
jest.mock('../src/modules/open-agents/qvac-agent.provider', () => ({
  qvacAgentProvider: { assessDisputeEvidence: (...args: unknown[]) => mockAssessDisputeEvidence(...args) },
}))

const mockProposeAutoResolution = jest.fn()
jest.mock('../src/modules/open-settlement/dispute.service', () => ({
  getDisputeService: () => ({ proposeAutoResolution: (...args: unknown[]) => mockProposeAutoResolution(...args) }),
}))

const mockDisputeFindUnique = jest.fn()
const mockTradeFindUnique = jest.fn()
jest.mock('../src/common/database', () => ({
  prisma: {
    trade: { update: jest.fn(), findUnique: (...args: unknown[]) => mockTradeFindUnique(...args) },
    dispute: { findFirst: jest.fn().mockResolvedValue(null), findUnique: (...args: unknown[]) => mockDisputeFindUnique(...args) },
    user: { update: jest.fn() },
  },
}))
jest.mock('../src/modules/open-settlement/settlement-orchestrator', () => ({
  executeSettlement: jest.fn(),
}))
jest.mock('../src/modules/open-settlement/wdk-settlement.provider', () => ({
  wdkSettlementProvider: { getAccountAddress: jest.fn() },
  buyerIndexFor: jest.fn(),
}))
jest.mock('../src/modules/open-p2p/reconciliation.service', () => ({
  reconciliationService: { reconcilePeerPair: jest.fn().mockResolvedValue([]) },
}))
jest.mock('../src/modules/open-p2p/chat-room-registry', () => ({
  broadcastToTrade: jest.fn(),
}))

const onDurableHandlers: Record<string, (event: unknown) => Promise<void> | void> = {}
const mockEmit = jest.fn().mockResolvedValue(undefined)
jest.mock('../src/common/events/event-bus', () => ({
  eventBus: {
    emit: (...args: unknown[]) => mockEmit(...args),
    on: jest.fn(),
    onDurable: (event: string, handler: (event: unknown) => Promise<void> | void) => {
      onDurableHandlers[event] = handler
    },
  },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerEventHandlers } = require('../src/common/events/handlers')

const evidenceSubmittedEvent = {
  eventId: 'evt-1',
  eventName: 'dispute.evidence_submitted',
  publishedAt: '2026-01-01T00:00:00.000Z',
  payload: { disputeId: 'dispute-1', settlementId: 'escrow-1', tradeId: 'trade-1', triggeredBy: 'buyer-1', evidenceGeneration: 3 },
}

function fireHandler() {
  return onDurableHandlers['dispute.evidence_submitted'](evidenceSubmittedEvent)
}

describe('dispute.evidence_submitted -> QVAC auto-resolution reaction (RFC-021 D8)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    qvacAutoResolutionEnabled = false
    qvacAutoResolutionConfidenceThreshold = 0.85
    registerEventHandlers()
    mockDisputeFindUnique.mockResolvedValue({
      id: 'dispute-1', status: 'EVIDENCE_SUBMITTED', reason: 'no payment received',
      evidence: [{ type: 'payment_receipt', note: 'a receipt', submittedBy: 'buyer-1' }], evidenceGeneration: 3,
    })
    mockTradeFindUnique.mockResolvedValue({
      id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', asset: 'BTC', amount: { toString: () => '0.01' },
      offer: { paymentMethod: 'BANK_TRANSFER' },
    })
  })

  it('does nothing when qvacAutoResolutionEnabled is false (the default)', async () => {
    await fireHandler()
    expect(mockAssessDisputeEvidence).not.toHaveBeenCalled()
    expect(mockProposeAutoResolution).not.toHaveBeenCalled()
  })

  it('assesses evidence and proposes an auto-resolution when confidence meets the threshold', async () => {
    qvacAutoResolutionEnabled = true
    mockAssessDisputeEvidence.mockResolvedValueOnce({ recommendation: 'RELEASE', confidence: 0.9, reasoning: 'clear match' })

    await fireHandler()

    expect(mockAssessDisputeEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMethod: 'BANK_TRANSFER',
        asset: 'BTC',
        amount: '0.01',
        reason: 'no payment received',
        evidence: [{ type: 'payment_receipt', note: 'a receipt', submittedBy: 'buyer' }],
      })
    )
    expect(mockProposeAutoResolution).toHaveBeenCalledWith('dispute-1', 'RELEASE', 0.9, 'clear match', 3)
  })

  it('drops a stale durable evidence event before invoking QVAC', async () => {
    qvacAutoResolutionEnabled = true
    mockDisputeFindUnique.mockResolvedValue({
      id: 'dispute-1', status: 'EVIDENCE_SUBMITTED', reason: 'r',
      evidenceGeneration: 4,
      evidence: [{ type: 'payment_receipt', note: 'newer evidence', submittedBy: 'buyer-1' }],
    })

    await fireHandler()

    expect(mockAssessDisputeEvidence).not.toHaveBeenCalled()
    expect(mockProposeAutoResolution).not.toHaveBeenCalled()
  })

  it('does NOT propose an auto-resolution when confidence is below the threshold', async () => {
    qvacAutoResolutionEnabled = true
    mockAssessDisputeEvidence.mockResolvedValueOnce({ recommendation: 'REFUND', confidence: 0.5, reasoning: 'weak match' })

    await fireHandler()

    expect(mockProposeAutoResolution).not.toHaveBeenCalled()
  })

  it('does NOT propose an auto-resolution for an INCONCLUSIVE recommendation, even at high confidence', async () => {
    qvacAutoResolutionEnabled = true
    mockAssessDisputeEvidence.mockResolvedValueOnce({ recommendation: 'INCONCLUSIVE', confidence: 0.95, reasoning: 'contradictory' })

    await fireHandler()

    expect(mockProposeAutoResolution).not.toHaveBeenCalled()
  })

  it('skips QVAC entirely when there is no evidence to assess yet', async () => {
    qvacAutoResolutionEnabled = true
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', status: 'OPENED', reason: 'r', evidence: [] })

    await fireHandler()

    expect(mockAssessDisputeEvidence).not.toHaveBeenCalled()
  })

  it('skips when the dispute has already moved past evidence-gathering (RESOLVED/AUTO_PROPOSED/APPEALED)', async () => {
    qvacAutoResolutionEnabled = true
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', reason: 'r', evidence: [{ type: 'x', submittedBy: 'buyer-1' }] })

    await fireHandler()

    expect(mockAssessDisputeEvidence).not.toHaveBeenCalled()
  })

  it('does not throw when QVAC fails — an automation failure must not break dispute evidence submission', async () => {
    qvacAutoResolutionEnabled = true
    mockAssessDisputeEvidence.mockRejectedValueOnce(new Error('QVAC unavailable'))

    await expect(fireHandler()).resolves.not.toThrow()
    expect(mockProposeAutoResolution).not.toHaveBeenCalled()
  })
})
