// tests/multisigFeeReorgSweep.test.ts
//
// Missão 11 Fase 8.1 LB-08 — sweepMultisigFeeReorgs() unit-level proof.
// The revert/flag decision itself (recordReorgAndRevert()) already had
// coverage before this file (feeCollectionRecognitionService.test.ts) —
// this file proves the DETECTION half: which obligations get re-checked,
// which are skipped as buried deep enough, and that the real chain
// (never the recorded evidence row) decides whether a reorg happened.
// Mocked Prisma + mocked explorer fetch, no real database or network.
// The candidate query itself (window bound, latest CONFIRMED generation)
// runs against real PostgreSQL in
// tests/integration/feeReleaseReorgIdempotency.test.ts; here it is
// answered with the rows it would return.

jest.mock('../src/config', () => ({
  config: {
    trade: { multisigReorgSafetyWindowBlocks: 100 },
    multisig: { explorerApiUrl: 'https://mempool.space/testnet/api' },
  },
}))

// The sweep asks two questions: does any COLLECTED/DISTRIBUTED MULTISIG
// obligation exist at all (EXISTS), then which ones are inside the window.
const mockAnyObligation = jest.fn()
const mockWindowCandidates = jest.fn()
jest.mock('../src/common/database', () => ({
  prisma: {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.join('?').includes('EXISTS') ? mockAnyObligation() : mockWindowCandidates(strings.join('?'), ...values),
  },
}))

const mockRecordReorgAndRevert = jest.fn()
jest.mock('../src/modules/open-settlement/fee-collection-recognition.service', () => ({
  feeCollectionRecognitionService: { recordReorgAndRevert: (...args: unknown[]) => mockRecordReorgAndRevert(...args) },
}))

const fetchMock = jest.fn()

import { sweepMultisigFeeReorgs } from '../src/modules/open-settlement/multisig-fee-reorg-sweep'

function candidate(overrides: Record<string, any> = {}) {
  return { feeObligationId: 'obligation-1', confirmationId: 'confirmed-1', txid: 'a'.repeat(64), confirmedAtHeight: 800_000, ...overrides }
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(global as any).fetch = fetchMock
  mockAnyObligation.mockResolvedValue([{ any: true }])
  mockWindowCandidates.mockResolvedValue([])
  mockRecordReorgAndRevert.mockResolvedValue({ reverted: true, outcome: 'REVERTED' })
})

function mockChain({ tipHeight, statusFor }: { tipHeight: number; statusFor?: Record<string, boolean> }) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/blocks/tip/height')) return Promise.resolve({ ok: true, text: async () => String(tipHeight) })
    if (url.includes('/status')) {
      const txid = url.split('/tx/')[1]?.split('/status')[0]
      const confirmed = statusFor?.[txid ?? ''] ?? true
      return Promise.resolve({ ok: true, json: async () => ({ confirmed, block_height: confirmed ? 800_000 : undefined }) })
    }
    return Promise.resolve({ ok: true, json: async () => [] })
  })
}

describe('sweepMultisigFeeReorgs() — Missão 11 Fase 8.1 LB-08', () => {
  it('a still-confirmed obligation within the safety window is re-checked and left alone', async () => {
    mockWindowCandidates.mockResolvedValue([candidate()])
    mockChain({ tipHeight: 800_010, statusFor: { ['a'.repeat(64)]: true } })

    const result = await sweepMultisigFeeReorgs()

    expect(result.stillGood).toEqual(['obligation-1'])
    expect(result.reverted).toEqual([])
    expect(mockRecordReorgAndRevert).not.toHaveBeenCalled()
  })

  it('a COLLECTED obligation whose confirming txid is no longer confirmed gets reverted via the pre-existing recordReorgAndRevert(), naming the generation it observed', async () => {
    mockWindowCandidates.mockResolvedValue([candidate()])
    mockChain({ tipHeight: 800_010, statusFor: { ['a'.repeat(64)]: false } })
    mockRecordReorgAndRevert.mockResolvedValue({ reverted: true, outcome: 'REVERTED' })

    const result = await sweepMultisigFeeReorgs()

    expect(mockRecordReorgAndRevert).toHaveBeenCalledWith('obligation-1', 'a'.repeat(64), 'confirmed-1')
    expect(result.reverted).toEqual(['obligation-1'])
    expect(result.flaggedDistributed).toEqual([])
  })

  it('a DISTRIBUTED obligation whose confirming txid disappears is flagged, not reverted — recordReorgAndRevert()\'s own pre-existing refusal', async () => {
    mockWindowCandidates.mockResolvedValue([candidate()])
    mockChain({ tipHeight: 800_010, statusFor: { ['a'.repeat(64)]: false } })
    mockRecordReorgAndRevert.mockResolvedValue({ reverted: false, outcome: 'FLAGGED_DISTRIBUTED' })

    const result = await sweepMultisigFeeReorgs()

    expect(mockRecordReorgAndRevert).toHaveBeenCalledWith('obligation-1', 'a'.repeat(64), 'confirmed-1')
    expect(result.flaggedDistributed).toEqual(['obligation-1'])
    expect(result.reverted).toEqual([])
  })

  it('a reorg already recorded for this generation, or a generation superseded meanwhile, is reported as such — never as a new revert or flag', async () => {
    mockWindowCandidates.mockResolvedValue([candidate({ feeObligationId: 'already' }), candidate({ feeObligationId: 'stale' })])
    mockChain({ tipHeight: 800_010, statusFor: { ['a'.repeat(64)]: false } })
    mockRecordReorgAndRevert.mockImplementation(async (id: string) => (id === 'already' ? { reverted: false, outcome: 'ALREADY_RECORDED' } : { reverted: false, outcome: 'SUPERSEDED' }))

    const result = await sweepMultisigFeeReorgs()

    expect(result.alreadyRecorded).toEqual(['already'])
    expect(result.superseded).toEqual(['stale'])
    expect(result.reverted).toEqual([])
    expect(result.flaggedDistributed).toEqual([])
  })

  it('selects only generations still inside the safety window — the query bound is tip - window + 1, and nothing buried reaches the explorer', async () => {
    mockWindowCandidates.mockResolvedValue([]) // an obligation confirmed at 700_000 (100_011 deep) is not returned by the window query
    mockChain({ tipHeight: 800_010 })

    const result = await sweepMultisigFeeReorgs()

    const [sql, lowestInWindow] = mockWindowCandidates.mock.calls[0]
    expect(sql).toMatch(/"confirmedAtHeight" >= \?/)
    expect(lowestInWindow).toBe(800_010 - 100 + 1)
    expect(mockRecordReorgAndRevert).not.toHaveBeenCalled()
    // Only the one tip-height call was made — never a /status call.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.stillGood).toEqual([])
  })

  it('does not fetch the chain tip at all when there is nothing to re-check', async () => {
    mockAnyObligation.mockResolvedValue([{ any: false }])

    const result = await sweepMultisigFeeReorgs()

    expect(result.stillGood).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockWindowCandidates).not.toHaveBeenCalled()
  })

  it('flags (fails) an obligation with no usable CONFIRMED evidence rather than guessing', async () => {
    mockWindowCandidates.mockResolvedValue([candidate({ confirmationId: null, txid: null, confirmedAtHeight: null })]) // should never happen, but must not crash silently
    mockChain({ tipHeight: 800_010 })

    const result = await sweepMultisigFeeReorgs()

    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].error).toMatch(/no usable CONFIRMED evidence/)
  })

  it('one obligation that throws lands in failed and does not stop the rest of the pass', async () => {
    mockWindowCandidates.mockResolvedValue([candidate({ feeObligationId: 'broken' }), candidate({ feeObligationId: 'ok' })])
    mockChain({ tipHeight: 800_010, statusFor: { ['a'.repeat(64)]: false } })
    mockRecordReorgAndRevert.mockImplementation(async (id: string) => {
      if (id === 'broken') throw new Error('lock timeout')
      return { reverted: true, outcome: 'REVERTED' }
    })

    const result = await sweepMultisigFeeReorgs()

    expect(result.failed).toEqual([{ feeObligationId: 'broken', error: 'lock timeout' }])
    expect(result.reverted).toEqual(['ok'])
  })
})
