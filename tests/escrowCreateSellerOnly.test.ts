/**
 * D7 (CTO 29 Despacho 005): only the seller creates a trade's escrow. In `enforce` the buyer is refused with the stable
 * code ESCROW_CREATE_SELLER_ONLY before any pair lock, write or event; in `warn` the buyer still creates and the caller
 * is told it is deprecated; a third party gets FORBIDDEN in every mode; the seller is unaffected.
 */
const mockLock = jest.fn()
jest.mock('../src/modules/open-p2p/commitment-pair.service', () => ({ lockPairForEffect: (...a: unknown[]) => mockLock(...a) }))
jest.mock('../src/common/database', () => ({ prisma: { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ marker: 'tx' }) } }))
const mockFindById = jest.fn()
jest.mock('../src/modules/open-p2p/trade-repository', () => ({ tradeRepository: { findById: (...a: unknown[]) => mockFindById(...a) } }))
jest.mock('../src/modules/open-settlement/escrow-fee-snapshot.service', () => ({ escrowFeeSnapshotService: { computeSnapshotFields: jest.fn(async () => null) } }))
const mockEmit = jest.fn(async () => undefined)
jest.mock('../src/common/events/event-bus', () => ({ eventBus: { emit: (...a: unknown[]) => (mockEmit as any)(...a) } }))
const mockConfig = {
  isProduction: false,
  features: { mockEscrow: false, enforceCapabilities: false, requireDualApprovalForRelease: false, escrowCreateSellerOnly: 'warn' as 'warn' | 'enforce' },
  trade: { defaultTimelockHours: 24 }, settlement: { trustedArbitrators: [] }, arkade: { seed: '' },
}
jest.mock('../src/config', () => ({ get config() { return mockConfig } }))
jest.mock('@tetherto/wdk-wallet-evm', () => ({ __esModule: true, default: class FakeWalletManagerEvm {} }))
jest.mock('@arkade-os/sdk', () => ({ SeedIdentity: { fromSeed: jest.fn() }, MultisigTapscript: { encode: jest.fn() }, CSVMultisigTapscript: { encode: jest.fn() }, VtxoScript: class {} }))
jest.mock('@scure/btc-signer', () => ({ Transaction: { fromPSBT: jest.fn() } }))

import { EscrowService } from '../src/modules/open-settlement/escrow.service'

const trade = { id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null, asset: 'BTC', amount: '0.001', tradeIntentId: 'anchor-1' }
const input = { tradeId: 'trade-1', type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' } as any

describe("createEscrow(): only the seller creates the escrow (D7)", () => {
  let repoCreate: jest.Mock
  let service: EscrowService
  beforeEach(() => {
    mockLock.mockReset(); mockFindById.mockReset(); mockEmit.mockClear()
    mockFindById.mockResolvedValue(trade)
    mockLock.mockResolvedValue({ row: { id: 'pair-1', rail: 'MULTISIG', trade: { asset: 'BTC', amount: '0.001' } }, readiness: { ok: true }, t: new Date() })
    repoCreate = jest.fn(async (data: any) => ({ id: 'escrow-1', tradeId: data.tradeId, type: data.type, asset: 'BTC', lockedAmount: '0.001' }))
    service = new EscrowService({ create: repoCreate } as any)
  })

  it("enforce: the buyer is refused with ESCROW_CREATE_SELLER_ONLY (403) before any lock, write or event", async () => {
    mockConfig.features.escrowCreateSellerOnly = 'enforce'
    const onBuyerDeprecated = jest.fn()
    await expect(service.createEscrow(input, 'buyer-1', { onBuyerDeprecated })).rejects.toMatchObject({ statusCode: 403, code: 'ESCROW_CREATE_SELLER_ONLY' })
    expect(mockLock).not.toHaveBeenCalled()
    expect(repoCreate).not.toHaveBeenCalled()
    expect(mockEmit).not.toHaveBeenCalled()
    expect(onBuyerDeprecated).not.toHaveBeenCalled()
  })

  it("warn: the buyer still creates the escrow and the caller is told it is deprecated", async () => {
    mockConfig.features.escrowCreateSellerOnly = 'warn'
    const onBuyerDeprecated = jest.fn()
    await service.createEscrow(input, 'buyer-1', { onBuyerDeprecated })
    expect(repoCreate).toHaveBeenCalledTimes(1)
    expect(onBuyerDeprecated).toHaveBeenCalledTimes(1)
  })

  it("a config without the mode fails closed: the buyer is refused", async () => {
    const saved = mockConfig.features.escrowCreateSellerOnly
    delete (mockConfig.features as { escrowCreateSellerOnly?: string }).escrowCreateSellerOnly
    try {
      await expect(service.createEscrow(input, 'buyer-1')).rejects.toMatchObject({ statusCode: 403, code: 'ESCROW_CREATE_SELLER_ONLY' })
      expect(repoCreate).not.toHaveBeenCalled()
    } finally {
      mockConfig.features.escrowCreateSellerOnly = saved
    }
  })

  it.each([['warn'], ['enforce']])("%s: the seller creates as before, with no deprecation", async (mode) => {
    mockConfig.features.escrowCreateSellerOnly = mode as 'warn' | 'enforce'
    const onBuyerDeprecated = jest.fn()
    await service.createEscrow(input, 'seller-1', { onBuyerDeprecated })
    expect(repoCreate).toHaveBeenCalledTimes(1)
    expect(onBuyerDeprecated).not.toHaveBeenCalled()
  })

  it.each([['warn'], ['enforce']])("%s: a third party gets the generic FORBIDDEN, never the seller-only code", async (mode) => {
    mockConfig.features.escrowCreateSellerOnly = mode as 'warn' | 'enforce'
    await expect(service.createEscrow(input, 'stranger')).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' })
    expect(mockLock).not.toHaveBeenCalled()
    expect(repoCreate).not.toHaveBeenCalled()
  })
})
