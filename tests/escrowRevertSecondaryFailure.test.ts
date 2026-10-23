/**
 * P4 / Gate 3 - a failed claim rollback is recorded, never silent and never masking:
 * revertEscrowStatus() swallows a secondary revert failure (the caller rethrows the ORIGINAL error), but logs it
 * together with the original error and whether that error came from a broadcast request whose outcome is unknown.
 */
const mockRevertStatus = jest.fn()
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }

jest.mock('../src/common/logger', () => ({
  logger: { ...mockLog, child: () => mockLog },
  childLogger: () => mockLog,
}))
jest.mock('../src/common/database', () => ({ prisma: {} }))
jest.mock('../src/modules/open-settlement/escrow-repository', () => ({
  escrowRepository: { revertStatus: (...args: unknown[]) => mockRevertStatus(...args) },
}))

import { revertEscrowStatus } from '../src/modules/open-settlement/escrow-lifecycle'
import { markBroadcastAttempted, isBroadcastOutcomeUnknown } from '../src/modules/open-settlement/broadcast-outcome'

beforeEach(() => jest.clearAllMocks())

describe('revertEscrowStatus - secondary rollback failure', () => {
  it('a failing revert does not throw (the original error stays the one surfaced) and is logged with both errors', async () => {
    mockRevertStatus.mockRejectedValue(new Error('connection terminated'))
    const original = markBroadcastAttempted(new Error('broadcast failed with 502'))

    await expect(revertEscrowStatus('escrow-1', 'REFUNDED', 'FUNDS_LOCKED', original)).resolves.toBeUndefined()

    expect(mockLog.error).toHaveBeenCalledWith(expect.objectContaining({
      escrowId: 'escrow-1', claimedStatus: 'REFUNDED', fromStatus: 'FUNDS_LOCKED',
      cause: 'broadcast failed with 502', broadcastOutcome: 'UNKNOWN', revertError: 'connection terminated',
    }))
  })

  it('a definite pre-broadcast cause is classified NOT_BROADCAST', async () => {
    mockRevertStatus.mockRejectedValue(new Error('db down'))
    await revertEscrowStatus('escrow-1', 'COMPLETED', 'PAYMENT_PENDING', new Error('Signature on input 0 is not valid'))
    expect(mockLog.error).toHaveBeenCalledWith(expect.objectContaining({ broadcastOutcome: 'NOT_BROADCAST' }))
  })

  it('a revert that matches nothing (claim already converged or reverted) is a warning, not an error', async () => {
    mockRevertStatus.mockResolvedValue(0)
    await revertEscrowStatus('escrow-1', 'REFUNDED', 'FUNDS_LOCKED', new Error('x'))
    expect(mockLog.warn).toHaveBeenCalledWith(expect.objectContaining({ escrowId: 'escrow-1' }))
    expect(mockLog.error).not.toHaveBeenCalled()
  })

  it('a successful revert logs nothing', async () => {
    mockRevertStatus.mockResolvedValue(1)
    await revertEscrowStatus('escrow-1', 'REFUNDED', 'FUNDS_LOCKED', new Error('x'))
    expect(mockLog.warn).not.toHaveBeenCalled()
    expect(mockLog.error).not.toHaveBeenCalled()
  })
})

describe('broadcast outcome marker', () => {
  it('marks the same error object and leaves it otherwise unchanged; unmarked and non-object causes are not "unknown"', () => {
    const err = new Error('lost')
    expect(markBroadcastAttempted(err)).toBe(err)
    expect(err.message).toBe('lost')
    expect(isBroadcastOutcomeUnknown(err)).toBe(true)
    expect(isBroadcastOutcomeUnknown(new Error('lost'))).toBe(false)
    expect(isBroadcastOutcomeUnknown('string cause')).toBe(false)
    expect(isBroadcastOutcomeUnknown(undefined)).toBe(false)
    expect(markBroadcastAttempted('string cause')).toBe('string cause')
  })
})
