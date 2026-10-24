/**
 * P4 funding-claim transaction contract. Mock-level only; real PG race remains a release gate.
 */
import { escrowRepository } from '../../src/modules/open-settlement/escrow-repository'
import { prisma } from '../../src/common/database'

jest.mock('../../src/common/database', () => ({
  prisma: { escrow: { updateMany: jest.fn() } },
}))

describe('P4 funding claim uses caller transaction', () => {
  beforeEach(() => jest.clearAllMocks())

  it('routes CAS to the supplied interactive transaction, not the global Prisma client', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 })
    const tx = { escrow: { updateMany } }
    const count = await escrowRepository.claimTransition('escrow-p4', 'CREATED', 'FUNDS_LOCKED', tx as any)
    expect(count).toBe(1)
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'escrow-p4', status: 'CREATED' },
      data: { status: 'FUNDS_LOCKED' },
    })
    expect(prisma.escrow.updateMany).not.toHaveBeenCalled()
  })

  it('retains the existing standalone CAS path when no transaction is supplied', async () => {
    const globalUpdate = prisma.escrow.updateMany as jest.Mock
    globalUpdate.mockResolvedValueOnce({ count: 0 })
    expect(await escrowRepository.claimTransition('escrow-p4', 'CREATED', 'FUNDS_LOCKED')).toBe(0)
    expect(globalUpdate).toHaveBeenCalledTimes(1)
  })

  it('propagates transactional failures without falling back to a global write', async () => {
    const tx = { escrow: { updateMany: jest.fn().mockRejectedValue(new Error('transaction aborted')) } }
    await expect(escrowRepository.claimTransition('escrow-p4', 'CREATED', 'FUNDS_LOCKED', tx as any))
      .rejects.toThrow('transaction aborted')
    expect(prisma.escrow.updateMany).not.toHaveBeenCalled()
  })
})
