/**
 * P4 #527: characterize current funding evidence decision boundary.
 *
 * These are regression/characterization tests, NOT acceptance of the empty-log behavior.
 * Modern funding provenance is not yet available to this service.
 */
import { EscrowFundingEvidenceService } from '../../src/modules/open-settlement/escrow-funding-evidence.service'
import type { EscrowFundingEvidenceRepository } from '../../src/modules/open-settlement/escrow-funding-evidence-repository'

describe('P4 funding evidence classification contract (pre-provenance)', () => {
  const escrowId = 'p4-funding-evidence-contract'
  const record = jest.fn()
  const listForEscrow = jest.fn()
  const repo = { record, listForEscrow } as unknown as EscrowFundingEvidenceRepository
  const service = new EscrowFundingEvidenceService(repo)

  beforeEach(() => jest.clearAllMocks())

  it('characterizes legacy compatibility: an empty evidence log is currently accepted (known gap for modern partial writes)', async () => {
    listForEscrow.mockResolvedValue([])
    expect(await service.isFundingUncertain(escrowId)).toBe(false)
    expect(listForEscrow).toHaveBeenCalledWith(escrowId, undefined)
    expect(record).not.toHaveBeenCalled()
  })

  it.each(['REORGED_INVALIDATED', 'REPLACEMENT_OBSERVED', 'AMBIGUOUS'])(
    'fails closed on the latest %s observation, even after earlier confirmation',
    async (kind) => {
      listForEscrow.mockResolvedValue([{ kind: 'OBSERVED_CONFIRMED' }, { kind }])
      expect(await service.isFundingUncertain(escrowId)).toBe(true)
      expect(record).not.toHaveBeenCalled()
    },
  )

  it('trusts only a later independently recorded reconfirmation after reorg', async () => {
    listForEscrow.mockResolvedValue([{ kind: 'OBSERVED_CONFIRMED' }, { kind: 'REORGED_INVALIDATED' }, { kind: 'RECONFIRMED' }])
    expect(await service.isFundingUncertain(escrowId)).toBe(false)
  })

  it('passes a caller-held transaction to the evidence read (no separate unlocked read)', async () => {
    const tx = { escrowFundingEvidence: {} } as any
    listForEscrow.mockResolvedValue([{ kind: 'AMBIGUOUS' }])
    expect(await service.isFundingUncertain(escrowId, tx)).toBe(true)
    expect(listForEscrow).toHaveBeenCalledWith(escrowId, tx)
  })

  it('propagates evidence read failure rather than silently treating it as trustworthy', async () => {
    listForEscrow.mockRejectedValue(new Error('evidence storage unavailable'))
    await expect(service.isFundingUncertain(escrowId)).rejects.toThrow('evidence storage unavailable')
  })
})
