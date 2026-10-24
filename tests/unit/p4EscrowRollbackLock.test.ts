/**
 * P4 contract tests for EscrowRepository.revertStatus (mock level: ordering and shape only).
 * The real concurrency proof is tests/integration/signingRoundStateCompatibility.test.ts (P4-A, P4-B) on PostgreSQL.
 *
 * Adapted from the CTO branch's test of the same name: the rollback does NOT filter on txReleaseId. Once a
 * settlement result exists the status-frozen trigger (migration 20260921122000) is the backstop that refuses the
 * revert, and tests/integration/settlementResultIntegrity.test.ts pins that contract.
 */
import { escrowRepository } from '../../src/modules/open-settlement/escrow-repository'
import { prisma } from '../../src/common/database'

jest.mock('../../src/common/database', () => ({
  prisma: { $transaction: jest.fn(), escrow: { updateMany: jest.fn() } },
}))

describe('P4 escrow rollback serialization contract', () => {
  const transaction = prisma.$transaction as jest.Mock
  const updateMany = jest.fn()
  const executeRaw = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    transaction.mockImplementation((fn: (tx: any) => Promise<any>) =>
      fn({ $executeRaw: executeRaw, escrow: { updateMany } }))
    executeRaw.mockResolvedValue(0)
    updateMany.mockResolvedValue({ count: 1 })
  })

  it('acquires the escrow advisory lock before the conditional rollback, in one transaction', async () => {
    const order: string[] = []
    executeRaw.mockImplementation(async () => { order.push('E-lock'); return 0 })
    updateMany.mockImplementation(async () => { order.push('rollback'); return { count: 1 } })
    expect(await escrowRepository.revertStatus('escrow-p4', 'COMPLETED', 'FUNDS_LOCKED')).toBe(1)
    expect(order).toEqual(['E-lock', 'rollback'])
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it('reverts only while the claimed status is still owned (status-conditioned, no other filter)', async () => {
    await escrowRepository.revertStatus('escrow-p4', 'COMPLETED', 'FUNDS_LOCKED')
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'escrow-p4', status: 'COMPLETED' },
      data: { status: 'FUNDS_LOCKED' },
    })
  })

  it('only rolls back funding before a transaction id is persisted', async () => {
    await escrowRepository.revertStatus('escrow-p4', 'FUNDS_LOCKED', 'CREATED')
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'escrow-p4', status: 'FUNDS_LOCKED', txLockId: null },
      data: { status: 'CREATED' },
    })
  })

  it('reports a refused funding rollback rather than claiming success', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 })
    expect(await escrowRepository.revertStatus('escrow-p4', 'FUNDS_LOCKED', 'CREATED')).toBe(0)
  })

  it('propagates a database failure instead of reporting a successful revert', async () => {
    updateMany.mockRejectedValueOnce(new Error('rollback failed'))
    await expect(escrowRepository.revertStatus('escrow-p4', 'COMPLETED', 'FUNDS_LOCKED'))
      .rejects.toThrow('rollback failed')
  })
})
