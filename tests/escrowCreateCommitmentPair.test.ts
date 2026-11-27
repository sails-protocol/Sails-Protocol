/**
 * F4 / invariant 3b, A1 (CTO Despacho 021): createEscrow() binds the new escrow to the COMMITTED pair of the trade's OWN Intent, in the
 * transaction that takes the pair lock FIRST. Every type but MOCK refuses without a ready pair; MOCK takes a pair when there is one and
 * otherwise leaves the decision to the database trigger. Unit level (mocks); the database side is proven in the F4 integration suites.
 */
const mockLock = jest.fn()
jest.mock('../src/modules/open-p2p/commitment-pair.service', () => ({ lockPairForEffect: (...a: unknown[]) => mockLock(...a) }))

const order: string[] = []
const txMarker = { marker: 'tx' }
jest.mock('../src/common/database', () => ({
  prisma: { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => { order.push('tx:open'); const r = await fn(txMarker); order.push('tx:close'); return r } },
}))

const mockFindById = jest.fn()
jest.mock('../src/modules/open-p2p/trade-repository', () => ({ tradeRepository: { findById: (...a: unknown[]) => mockFindById(...a) } }))
jest.mock('../src/modules/open-settlement/escrow-fee-snapshot.service', () => ({ escrowFeeSnapshotService: { computeSnapshotFields: jest.fn(async () => null) } }))
jest.mock('../src/common/events/event-bus', () => ({ eventBus: { emit: jest.fn(async () => undefined) } }))
jest.mock('../src/config', () => ({ get config() { return { isProduction: false, features: { mockEscrow: false, enforceCapabilities: false, requireDualApprovalForRelease: false, escrowCreateSellerOnly: 'warn' }, trade: { defaultTimelockHours: 24 }, settlement: { trustedArbitrators: [] }, arkade: { seed: '' } } } }))
jest.mock('@tetherto/wdk-wallet-evm', () => ({ __esModule: true, default: class FakeWalletManagerEvm {} }))
jest.mock('@arkade-os/sdk', () => ({ SeedIdentity: { fromSeed: jest.fn() }, MultisigTapscript: { encode: jest.fn() }, CSVMultisigTapscript: { encode: jest.fn() }, VtxoScript: class {} }))
jest.mock('@scure/btc-signer', () => ({ Transaction: { fromPSBT: jest.fn() } }))

import { EscrowService } from '../src/modules/open-settlement/escrow.service'
import { EscrowError } from '../src/common/errors'

const trade = (extra: Record<string, unknown> = {}) => ({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null, asset: 'BTC', amount: '0.001', ...extra })
// A committed pair row whose stored terms match input(): asset/amount of the trade, rail of the resolved escrow type.
const pair = (id: string, rail: string, terms: Record<string, unknown> = {}) => ({ id, rail, trade: { asset: 'BTC', amount: '0.001', ...terms } })
const input = (type: string) => ({ tradeId: 'trade-1', type, lockedAmount: '0.001', asset: 'BTC' }) as any

describe('createEscrow() A1: bound to the COMMITTED pair of the trade\'s own Intent, pair lock first', () => {
  let repoCreate: jest.Mock
  let service: EscrowService
  beforeEach(() => {
    order.length = 0
    mockLock.mockReset(); mockFindById.mockReset()
    repoCreate = jest.fn(async (data: any) => { order.push('repo.create'); return { id: 'escrow-1', tradeId: data.tradeId, type: data.type, asset: 'BTC', lockedAmount: '0.001' } })
    service = new EscrowService({ create: repoCreate } as any)
  })

  it('a ready pair: the escrow is created in the SAME transaction, AFTER the pair lock, carrying the pair id', async () => {
    mockFindById.mockResolvedValue(trade({ tradeIntentId: 'anchor-1' }))
    mockLock.mockImplementation(async () => { order.push('lock'); return { row: pair('pair-7', 'MULTISIG'), readiness: { ok: true }, t: new Date() } })
    await service.createEscrow(input('MULTISIG'), 'buyer-1')
    expect(mockLock).toHaveBeenCalledWith(txMarker, { anchorRef: 'anchor-1' })
    expect(order).toEqual(['tx:open', 'lock', 'repo.create', 'tx:close'])
    expect(repoCreate.mock.calls[0][0]).toMatchObject({ type: 'MULTISIG', commitmentPairId: 'pair-7' })
    expect(repoCreate.mock.calls[0][1]).toBe(txMarker) // the INSERT runs on the transaction that holds the lock
  })

  it('a real type refuses when the pair is not ready (any readiness code), and when the trade has no anchor: nothing is created', async () => {
    mockFindById.mockResolvedValue(trade({ tradeIntentId: 'anchor-1' }))
    mockLock.mockResolvedValue({ row: null, readiness: { ok: false, code: 'E25_COMMITMENT_MISSING' }, t: new Date() })
    await expect(service.createEscrow(input('MULTISIG'), 'buyer-1')).rejects.toThrow(/no executable commitment pair \(E25_COMMITMENT_MISSING\)/)
    mockLock.mockResolvedValue({ row: pair('p', 'MULTISIG'), readiness: { ok: false, code: 'E25_NOT_COMMITTED' }, t: new Date() })
    await expect(service.createEscrow(input('MULTISIG'), 'buyer-1')).rejects.toThrow(/E25_NOT_COMMITTED/)
    mockFindById.mockResolvedValue(trade()) // no tradeIntentId
    mockLock.mockClear()
    await expect(service.createEscrow(input('MULTISIG'), 'buyer-1')).rejects.toThrow(EscrowError)
    expect(mockLock).not.toHaveBeenCalled()
    expect(repoCreate).not.toHaveBeenCalled()
  })

  it('MOCK: takes the pair when there is one; with none it still goes to the repository WITHOUT a pair id (the database trigger decides, fail-closed in production)', async () => {
    mockFindById.mockResolvedValue(trade({ tradeIntentId: 'anchor-1' }))
    mockLock.mockResolvedValueOnce({ row: pair('pair-9', 'MOCK'), readiness: { ok: true }, t: new Date() })
    await service.createEscrow(input('MOCK'), 'buyer-1')
    expect(repoCreate.mock.calls[0][0].commitmentPairId).toBe('pair-9')
    mockLock.mockResolvedValueOnce({ row: null, readiness: { ok: false, code: 'E25_COMMITMENT_MISSING' }, t: new Date() })
    await service.createEscrow(input('MOCK'), 'buyer-1')
    expect(repoCreate.mock.calls[1][0].commitmentPairId).toBeUndefined()
  })

  it('a trade the caller is not a party to is refused BEFORE any pair lock (no lock without authorization)', async () => {
    mockFindById.mockResolvedValue(trade({ tradeIntentId: 'anchor-1' }))
    await expect(service.createEscrow(input('MULTISIG'), 'stranger')).rejects.toThrow(/not a counterparty/)
    expect(mockLock).not.toHaveBeenCalled()
  })
})

describe("createEscrow(): its asset/amount are the trade's and its committed pair's, never the caller's own (ESCROW_TERMS_MISMATCH)", () => {
  let repoCreate: jest.Mock
  let service: EscrowService
  beforeEach(() => {
    mockLock.mockReset(); mockFindById.mockReset()
    repoCreate = jest.fn(async (data: any) => ({ id: 'escrow-1', tradeId: data.tradeId, type: data.type, asset: data.asset, lockedAmount: data.lockedAmount }))
    service = new EscrowService({ create: repoCreate } as any)
    mockLock.mockResolvedValue({ row: pair('pair-1', 'MULTISIG'), readiness: { ok: true }, t: new Date() })
  })

  it('refuses an input asset different from the trade asset, before any pair lock: nothing is created', async () => {
    mockFindById.mockResolvedValue(trade({ tradeIntentId: 'anchor-1', asset: 'USDT' }))
    await expect(service.createEscrow(input('MULTISIG'), 'buyer-1')).rejects.toMatchObject({ code: 'ESCROW_TERMS_MISMATCH' })
    expect(mockLock).not.toHaveBeenCalled()
    expect(repoCreate).not.toHaveBeenCalled()
  })

  it('refuses an input lockedAmount different from the trade amount (0.002 vs 0.001): nothing is created', async () => {
    mockFindById.mockResolvedValue(trade({ tradeIntentId: 'anchor-1' }))
    await expect(service.createEscrow({ ...input('MULTISIG'), lockedAmount: '0.002' }, 'buyer-1')).rejects.toMatchObject({ code: 'ESCROW_TERMS_MISMATCH' })
    expect(repoCreate).not.toHaveBeenCalled()
  })

  it('refuses when the committed pair amount differs from the input even though the trade matches: nothing is created', async () => {
    mockFindById.mockResolvedValue(trade({ tradeIntentId: 'anchor-1' }))
    mockLock.mockResolvedValue({ row: pair('pair-1', 'MULTISIG', { amount: '0.002' }), readiness: { ok: true }, t: new Date() })
    await expect(service.createEscrow(input('MULTISIG'), 'buyer-1')).rejects.toMatchObject({ code: 'ESCROW_TERMS_MISMATCH' })
    expect(repoCreate).not.toHaveBeenCalled()
  })

  it('refuses when the committed pair rail differs from the resolved escrow type: nothing is created', async () => {
    mockFindById.mockResolvedValue(trade({ tradeIntentId: 'anchor-1' }))
    mockLock.mockResolvedValue({ row: pair('pair-1', 'LIGHTNING_HODL'), readiness: { ok: true }, t: new Date() })
    await expect(service.createEscrow(input('MULTISIG'), 'buyer-1')).rejects.toMatchObject({ code: 'ESCROW_TERMS_MISMATCH' })
    expect(repoCreate).not.toHaveBeenCalled()
  })

  it('refuses when the committed pair ASSET differs from the input even though the trade matches: nothing is created', async () => {
    mockFindById.mockResolvedValue(trade({ tradeIntentId: 'anchor-1' }))
    mockLock.mockResolvedValue({ row: pair('pair-1', 'MULTISIG', { asset: 'USDT_ERC20' }), readiness: { ok: true }, t: new Date() })
    await expect(service.createEscrow(input('MULTISIG'), 'buyer-1')).rejects.toMatchObject({ code: 'ESCROW_TERMS_MISMATCH' })
    expect(repoCreate).not.toHaveBeenCalled()
  })

  // The trade check alone: the input equals the committed pair (0.002) but not the trade (0.001).
  it('refuses an input that matches the committed pair amount but not the trade amount: nothing is created', async () => {
    mockFindById.mockResolvedValue(trade({ tradeIntentId: 'anchor-1' }))
    mockLock.mockResolvedValue({ row: pair('pair-1', 'MULTISIG', { amount: '0.002' }), readiness: { ok: true }, t: new Date() })
    await expect(service.createEscrow({ ...input('MULTISIG'), lockedAmount: '0.002' }, 'buyer-1')).rejects.toMatchObject({ code: 'ESCROW_TERMS_MISMATCH' })
    expect(repoCreate).not.toHaveBeenCalled()
  })

  it('refuses one satoshi less than the trade amount (0.00099999 vs 0.001): nothing is created', async () => {
    mockFindById.mockResolvedValue(trade({ tradeIntentId: 'anchor-1' }))
    await expect(service.createEscrow({ ...input('MULTISIG'), lockedAmount: '0.00099999' }, 'buyer-1')).rejects.toMatchObject({ code: 'ESCROW_TERMS_MISMATCH' })
    expect(repoCreate).not.toHaveBeenCalled()
  })

  it('refuses the trade amount written in satoshis instead of BTC (100000 vs 0.001, a 1e8 scale error): nothing is created', async () => {
    mockFindById.mockResolvedValue(trade({ tradeIntentId: 'anchor-1' }))
    await expect(service.createEscrow({ ...input('MULTISIG'), lockedAmount: '100000' }, 'buyer-1')).rejects.toMatchObject({ code: 'ESCROW_TERMS_MISMATCH' })
    expect(repoCreate).not.toHaveBeenCalled()
  })

  it('accepts amounts equal as decimals but written differently (0.00100000 vs 0.001)', async () => {
    mockFindById.mockResolvedValue(trade({ tradeIntentId: 'anchor-1' }))
    await service.createEscrow({ ...input('MULTISIG'), lockedAmount: '0.00100000' }, 'buyer-1')
    expect(repoCreate.mock.calls[0][0]).toMatchObject({ type: 'MULTISIG', commitmentPairId: 'pair-1', lockedAmount: '0.00100000' })
  })
})
