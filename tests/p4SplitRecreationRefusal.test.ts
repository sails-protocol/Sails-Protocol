/**
 * P4 Gate 3, option B1 (docs/p4-gate3-unknown-outcome-contract.md 6.11): a lost SPLIT round is never re-created automatically.
 * Mocked Prisma, chain and config: the refusal must come from the guard itself and must happen BEFORE any external read.
 * The settle window stays unset/off in production; here it is set only to prove SPLIT is refused even when everything else would pass.
 */
export {}

const mockFindMany = jest.fn()
const mockFindUnique = jest.fn()
const mockExistence = jest.fn()
const mockOutpoint = jest.fn()

jest.mock('../src/common/database', () => ({
  prisma: {
    economicDispositionAuthorization: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    escrowPendingTransaction: { findUnique: (...a: unknown[]) => mockFindUnique(...a) },
  },
}))
jest.mock('../src/config', () => ({ config: { trade: { disputedRecreationSettleWindowMs: 1000 } } }))
jest.mock('../src/modules/open-settlement/multisig.provider', () => ({
  fetchTransactionExistence: (...a: unknown[]) => mockExistence(...a),
  multisigProvider: { canonicalOutpointState: (...a: unknown[]) => mockOutpoint(...a) },
}))
jest.mock('../src/modules/open-settlement/economic-disposition-authority', () => ({
  economicIntentDigest: (i: { kind: string; buyerBps: number | null }) => `intent:${i.kind}:${i.buyerBps}`,
}))

import { assessDisputedRecreation } from '../src/modules/open-settlement/disputed-recreation-guard'

const generation = { id: 'd1', appealRound: 0, arbiterId: 'a1', ruling: 'SPLIT', authoritySignature: 'sig' }
const lostEda = (kind: string, bps: number | null) => ({
  id: 'eda1', pendingOperationId: 'p1', unsignedTxid: 'tx1', intentDigest: `intent:${kind}:${bps}`, authorizedAt: new Date(Date.now() - 60_000),
})
const assess = (kind: string, buyerBps: number | null) => assessDisputedRecreation({ escrowId: 'e1', escrowRecord: {}, generation, kind, buyerBps })

beforeEach(() => {
  jest.clearAllMocks()
  mockFindUnique.mockResolvedValue(null) // the pending operation is lost
  mockExistence.mockResolvedValue({ exists: false })
  mockOutpoint.mockResolvedValue('UNSPENT')
})

describe('B1: SPLIT is refused explicitly', () => {
  it('a lost SPLIT round is refused with SPLIT_UNSUPPORTED, and the network is never asked', async () => {
    mockFindMany.mockResolvedValue([lostEda('split', 7000)])
    await expect(assess('split', 7000)).rejects.toThrow(/DISPUTED_RECREATION_REFUSED\[SPLIT_UNSUPPORTED\]/)
    expect(mockExistence).not.toHaveBeenCalled()
    expect(mockOutpoint).not.toHaveBeenCalled()
  })

  it('is refused whatever the window, the txid state or the outpoint: all other checks would have passed', async () => {
    mockFindMany.mockResolvedValue([lostEda('split', 1)])
    await expect(assess('split', 1)).rejects.toThrow(/SPLIT_UNSUPPORTED/)
  })

  it('CONTROL: the same state for a RELEASE is cleared (the refusal is specific to SPLIT, nothing else changed)', async () => {
    mockFindMany.mockResolvedValue([lostEda('release', null)])
    await expect(assess('release', null)).resolves.toMatchObject({ authorizationId: 'eda1', pendingOperationId: 'p1' })
  })

  it('CONTROL: a REFUND is cleared too, and with no lost authorization a SPLIT is not touched (pre-existing rules apply)', async () => {
    mockFindMany.mockResolvedValue([lostEda('refund', null)])
    await expect(assess('refund', null)).resolves.toMatchObject({ authorizationId: 'eda1' })
    mockFindMany.mockResolvedValue([])
    await expect(assess('split', 7000)).resolves.toBeNull()
  })
})
