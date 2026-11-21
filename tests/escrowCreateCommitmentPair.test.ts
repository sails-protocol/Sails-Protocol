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
jest.mock('../src/config', () => ({ get config() { return { isProduction: false, features: { mockEscrow: false, enforceCapabilities: false, requireDualApprovalForRelease: false }, trade: { defaultTimelockHours: 24 }, settlement: { trustedArbitrators: [] }, arkade: { seed: '' } } } }))
jest.mock('@tetherto/wdk-wallet-evm', () => ({ __esModule: true, default: class FakeWalletManagerEvm {} }))
jest.mock('@arkade-os/sdk', () => ({ SeedIdentity: { fromSeed: jest.fn() }, MultisigTapscript: { encode: jest.fn() }, CSVMultisigTapscript: { encode: jest.fn() }, VtxoScript: class {} }))
jest.mock('@scure/btc-signer', () => ({ Transaction: { fromPSBT: jest.fn() } }))

import { EscrowService } from '../src/modules/open-settlement/escrow.service'
import { EscrowError } from '../src/common/errors'

const trade = (extra: Record<string, unknown> = {}) => ({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null, ...extra })
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
    mockLock.mockImplementation(async () => { order.push('lock'); return { row: { id: 'pair-7' }, readiness: { ok: true }, t: new Date() } })
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
    mockLock.mockResolvedValue({ row: { id: 'p' }, readiness: { ok: false, code: 'E25_NOT_COMMITTED' }, t: new Date() })
    await expect(service.createEscrow(input('MULTISIG'), 'buyer-1')).rejects.toThrow(/E25_NOT_COMMITTED/)
    mockFindById.mockResolvedValue(trade()) // no tradeIntentId
    mockLock.mockClear()
    await expect(service.createEscrow(input('MULTISIG'), 'buyer-1')).rejects.toThrow(EscrowError)
    expect(mockLock).not.toHaveBeenCalled()
    expect(repoCreate).not.toHaveBeenCalled()
  })

  it('MOCK: takes the pair when there is one; with none it still goes to the repository WITHOUT a pair id (the database trigger decides, fail-closed in production)', async () => {
    mockFindById.mockResolvedValue(trade({ tradeIntentId: 'anchor-1' }))
    mockLock.mockResolvedValueOnce({ row: { id: 'pair-9' }, readiness: { ok: true }, t: new Date() })
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
