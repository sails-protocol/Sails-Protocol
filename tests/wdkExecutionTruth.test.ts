/**
 * WDK execution truth (unit level).
 *
 * #235 R7G-F6C — the provider no longer moves funds through WDK transfer(): its release / refund / split refuse,
 * and every outbound leg is signed, persisted and broadcast by wdk-outbound-authority.ts. The properties the
 * earlier transfer()-path tests in this file demonstrated (an ambiguous outcome never becomes a blind retry, a
 * bare hash is never success, a split never replays a completed leg) are now proven against that authority on
 * real PostgreSQL in tests/integration/wdkOutboundAuthority.test.ts. What remains of wdk-execution-truth.ts
 * serves the read-only reconciliation of legacy transfer() attempts, and is tested here.
 */
jest.mock('../src/config', () => ({ config: { wdk: { seedPhrase: 'test-seed', rpcUrl: 'http://localhost', usdtContract: '0xtoken' } } }))

const mockTransfer = jest.fn()
const fakeAccount = { getAddress: async () => '0xescrow', transfer: (...a: unknown[]) => mockTransfer(...a), getTransactionReceipt: async () => null }
jest.mock('@tetherto/wdk-wallet-evm', () => ({
  __esModule: true,
  default: class FakeWalletManagerEvm {
    async getAccount() { return fakeAccount }
    async getAccountByPath() { return fakeAccount }
  },
}))
jest.mock('../src/common/database', () => ({ prisma: {} }))

import { WdkSettlementProvider } from '../src/modules/open-settlement/wdk-settlement.provider'
import { decimalAmountsEqual, receiptStatusOf } from '../src/modules/open-settlement/wdk-execution-truth'

const provider = new WdkSettlementProvider()
const escrow = { id: 'escrow-1', tradeId: 'trade-1', lockedAmount: '5', wdkAccountScheme: 'ALLOCATED_V1', wdkAccountPath: "1'/0/7" }

describe('#235 R7G-F6C — the provider never moves WDK funds through transfer()', () => {
  it.each([
    ['releaseFunds', () => provider.releaseFunds(escrow)],
    ['refundFunds', () => provider.refundFunds(escrow)],
    ['splitFunds', () => provider.splitFunds(escrow)],
  ])('%s refuses (UNAVAILABLE) and never calls transfer()', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ reason: 'UNAVAILABLE' })
    await expect(call()).rejects.toThrow(/executed only by the signed outbound authority/)
    expect(mockTransfer).not.toHaveBeenCalled()
  })
})

describe('decimalAmountsEqual() — exact, never through a float', () => {
  it.each([['5', '5.00000000', true], ['5.1', '5.10', true], ['05.0', '5', true], ['5', '5.000001', false], ['0.1', '0.10000001', false]])('%s vs %s -> %s', (a, b, equal) => {
    expect(decimalAmountsEqual(a, b)).toBe(equal)
  })
})

describe('receiptStatusOf() — NF2: only 1 and 0 decide', () => {
  it.each([[{ status: 1 }, 1], [{ status: 0 }, 0], [{ status: null }, null], [{ status: 2 }, null], [{ status: '0x1' }, null], [null, null], [undefined, null]])('%j -> %s', (receipt, status) => {
    expect(receiptStatusOf(receipt)).toBe(status)
  })
})
