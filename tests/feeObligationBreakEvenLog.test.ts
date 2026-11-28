/**
 * Break-even (CTO 38 §14): the obligation records the collected amount, the nominal fee net of its own output's cost.
 * The "computedFee disagrees" alarm is exempted only for that difference, bounded by vBytes * fMaxSatPerVb of the
 * committed policy; anything else still raises it.
 */
const mockError = jest.fn()
jest.mock('../src/common/logger', () => ({ childLogger: () => ({ error: mockError, info: jest.fn(), warn: jest.fn() }) }))

import { FeeObligationService } from '../src/modules/open-settlement/fee-obligation.service'

const breakEven = { fMaxSatPerVb: 25, vBytes: 43, dMaxSats: 330, collectionDustSats: 330, allowedPayoutTypes: ['P2WPKH', 'P2WSH', 'P2TR'] }
// T = 1,000,000 sats at 0.40% => nominal F = 4000 sats; the output costs at most 43 * 25 = 1075 sats.
const escrow = { id: 'escrow-1', lockedAmount: '0.01', asset: 'BTC' as const, feePolicyVersionId: 'policy-1', snapshotProtocolFeeRate: '0.004' }

function service(smallTradeRule: unknown) {
  const repo = {
    createOwed: jest.fn(async (input: any) => ({ id: 'ob-1', collectionStatus: 'PENDING_COLLECTION', ...input })),
    createNotApplicable: jest.fn(), findByEscrowId: jest.fn(async () => null), findById: jest.fn(async () => null),
    claimCollectionStatusTransition: jest.fn(async () => 1),
  }
  const policyRepo = { findById: jest.fn(async () => ({ id: 'policy-1', smallTradeRule })), create: jest.fn(), findPublishedForRail: jest.fn(), publish: jest.fn(), retire: jest.fn() }
  return { svc: new FeeObligationService(repo as any, policyRepo as any), repo }
}
const disagreed = () => mockError.mock.calls.some((c) => /computedFee disagrees/.test(String(c[0]?.msg)))

beforeEach(() => mockError.mockReset())

it.each([
  ['net of the full cap (4000 - 1075)', { breakEven }, 2925, false],
  ['net of a smaller cost', { breakEven }, 3800, false],
  ['one sat more than the cap allows', { breakEven }, 2924, true],
  ['above the nominal fee', { breakEven }, 4001, true],
  ['any difference without breakEven', {}, 3800, true],
])('%s: alarm raised = %s', async (_name, rule, builtSats, alarm) => {
  const { svc, repo } = service(rule)
  await svc.recordObligationForEscrowSettlement(escrow, 'RELEASE', undefined, { feeSats: builtSats as number, waived: false })
  expect(disagreed()).toBe(alarm)
  expect(String(repo.createOwed.mock.calls[0][0].computedFee)).toBe(String((builtSats as number) / 1e8)) // the built amount is recorded
})
