/** P4 contract tests. These are mock-level ordering/guard tests, NOT a PostgreSQL concurrency proof. */
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

  it('acquires escrow advisory lock before the conditional rollback', async () => {
    const order: string[] = []
    executeRaw.mockImplementation(async () => { order.push('E-lock'); return 0 })
    updateMany.mockImplementation(async () => { order.push('rollback'); return { count: 1 } })
    expect(await escrowRepository.revertStatus('escrow-p4', 'COMPLETED', 'FUNDS_LOCKED')).toBe(1)
    expect(order).toEqual(['E-lock', 'rollback'])
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it('does not roll back a status when settlement evidence exists', async () => {
    await escrowRepository.revertStatus('escrow-p4', 'COMPLETED', 'FUNDS_LOCKED')
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'escrow-p4', status: 'COMPLETED', txReleaseId: null },
      data: { status: 'FUNDS_LOCKED' },
    })
  })

  it('propagates database failure instead of reporting a successful revert', async () => {
    updateMany.mockRejectedValueOnce(new Error('rollback failed'))
    await expect(escrowRepository.revertStatus('escrow-p4', 'COMPLETED', 'FUNDS_LOCKED'))
      .rejects.toThrow('rollback failed')
  })
})
