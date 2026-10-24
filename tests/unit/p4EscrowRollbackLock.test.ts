/** P4 contract tests. These are mock-level ordering/guard tests, NOT a PostgreSQL concurrency proof. */
import { escrowRepository } from '../../src/modules/open-settlement/escrow-repository'
import { prisma } from '../../src/common/database'

jest.mock('../../src/common/database', () => ({
  prisma: { $transaction: jest.fn(), escrow: { updateMany: jest.fn(), update: jest.fn() } },
}))

describe('P4 escrow rollback serialization contract', () => {
  const transaction = prisma.$transaction as jest.Mock
  const updateMany = jest.fn()
  const executeRaw = jest.fn()
  const claimUpdateMany = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    transaction.mockImplementation((fn: (tx: any) => Promise<any>) =>
      fn({ $executeRaw: executeRaw, escrow: { updateMany } }))
    executeRaw.mockResolvedValue(0)
    updateMany.mockResolvedValue({ count: 1 })
  })

  it('uses the caller transaction for the funding claim, not a separate Prisma write', async () => {
    claimUpdateMany.mockResolvedValueOnce({ count: 1 })
    const tx = { escrow: { updateMany: claimUpdateMany } } as any
    await expect(escrowRepository.claimTransition('escrow-p4', 'CREATED', 'FUNDS_LOCKED', tx))
      .resolves.toBe(1)
    expect(claimUpdateMany).toHaveBeenCalledWith({
      where: { id: 'escrow-p4', status: 'CREATED' },
      data: { status: 'FUNDS_LOCKED' },
    })
    expect(transaction).not.toHaveBeenCalled()
    expect(prisma.escrow.updateMany).not.toHaveBeenCalled()
  })

  it('returns a lost-race result from the caller transaction', async () => {
    claimUpdateMany.mockResolvedValueOnce({ count: 0 })
    const tx = { escrow: { updateMany: claimUpdateMany } } as any
    await expect(escrowRepository.claimTransition('escrow-p4', 'CREATED', 'FUNDS_LOCKED', tx))
      .resolves.toBe(0)
    expect(transaction).not.toHaveBeenCalled()
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

  it('guards funding rollback against an already persisted txLockId', async () => {
    await escrowRepository.revertStatus('escrow-p4', 'FUNDS_LOCKED', 'CREATED')
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'escrow-p4', status: 'FUNDS_LOCKED', txLockId: null },
      data: { status: 'CREATED' },
    })
  })

  it('propagates database failure instead of reporting a successful revert', async () => {
    updateMany.mockRejectedValueOnce(new Error('rollback failed'))
    await expect(escrowRepository.revertStatus('escrow-p4', 'COMPLETED', 'FUNDS_LOCKED'))
      .rejects.toThrow('rollback failed')
  })
  it('returns zero without claiming a rollback when another writer won', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(escrowRepository.revertStatus('escrow-p4', 'COMPLETED', 'FUNDS_LOCKED'))
      .resolves.toBe(0)
    expect(executeRaw).toHaveBeenCalledTimes(1)
    expect(updateMany).toHaveBeenCalledTimes(1)
  })

  it('does not touch the escrow row when acquiring E lock fails', async () => {
    executeRaw.mockRejectedValueOnce(new Error('advisory lock unavailable'))
    await expect(escrowRepository.revertStatus('escrow-p4', 'COMPLETED', 'FUNDS_LOCKED'))
      .rejects.toThrow('advisory lock unavailable')
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('writes funding evidence only under an unrecorded FUNDS_LOCKED claim', async () => {
    const update = prisma.escrow.update as jest.Mock
    update.mockResolvedValueOnce({ id: 'escrow-p4', status: 'FUNDS_LOCKED' })
    const funding = {
      txLockId: 'tx-p4', txLockVout: 0, multisigAddr: 'addr-p4',
      lockedAt: new Date('2026-10-23T12:00:00Z'),
      expiresAt: new Date('2026-10-24T12:00:00Z'),
    }
    await escrowRepository.updateLockResult('escrow-p4', funding)
    expect(update).toHaveBeenCalledWith({
      where: { id: 'escrow-p4', status: 'FUNDS_LOCKED', txLockId: null },
      data: funding,
    })
  })

  it('fails closed on stale funding result after claim changed', async () => {
    const update = prisma.escrow.update as jest.Mock
    update.mockRejectedValueOnce({ code: 'P2025' })
    await expect(escrowRepository.updateLockResult('escrow-p4', {
      txLockId: 'tx-p4', txLockVout: 0, multisigAddr: 'addr-p4',
      lockedAt: new Date('2026-10-23T12:00:00Z'),
      expiresAt: new Date('2026-10-24T12:00:00Z'),
    })).rejects.toThrow('Reconcile authoritative evidence')
  })

})
