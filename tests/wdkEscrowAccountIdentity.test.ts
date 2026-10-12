/**
 * #235 R7G-F6A-1 — WDK escrow account identity (unit level).
 *
 * The real wallet is replaced by a fake whose address is a function of the derivation path, so what
 * is asserted is which path the provider derives — the persisted Escrow.wdkAccountPath, never a value
 * recomputed from the trade — and that a persisted address mismatch fails closed before anything is signed.
 * #235 R7G-F6C: outbound legs are signed through signEscrowTransaction(); transfer() is never used.
 * The real WDK/EVM proof (distinct addresses, balances, nonces) is the local-EVM evidence script.
 */
const derivedPaths: string[] = []
const mockTransfer = jest.fn()
const mockSign = jest.fn()
const accountFor = (path: string) => ({
  getAddress: async () => `addr:${path}`,
  transfer: (...a: unknown[]) => mockTransfer(path, ...a),
  signTransaction: async (tx: unknown) => mockSign(path, tx),
  getTransactionReceipt: async () => ({ status: 1 }),
})
jest.mock('@tetherto/wdk-wallet-evm', () => ({
  __esModule: true,
  default: class FakeWalletManagerEvm {
    async getAccount(i: number) { derivedPaths.push(`0'/0/${i}`); return accountFor(`0'/0/${i}`) }
    async getAccountByPath(p: string) { derivedPaths.push(p); return accountFor(p) }
  },
}))
jest.mock('../src/modules/open-settlement/wdk-execution-truth', () => ({
  decimalAmountsEqual: (a: string, b: string) => a === b,
}))
jest.mock('../src/modules/open-settlement/wdk-transfer-attempt-repository', () => ({
  wdkTransferAttemptRepository: { updateStatus: jest.fn(async () => undefined), findLatest: jest.fn(async () => null) },
}))

process.env.WDK_SEED_PHRASE = process.env.WDK_SEED_PHRASE || 'test only seed phrase for wdk escrow account identity unit tests'
process.env.WDK_USDT_CONTRACT = process.env.WDK_USDT_CONTRACT || '0x0000000000000000000000000000000000000001'

import * as provider from '../src/modules/open-settlement/wdk-settlement.provider'
import { escrowIndexFor, wdkEscrowAccountPath, wdkSettlementProvider } from '../src/modules/open-settlement/wdk-settlement.provider'
import { classifyWdkAccounts, legacyIndex } from '../scripts/wdk-escrow-account-preflight'

// Two distinct trade ids whose historical escrowIndexFor() is identical (found by R7G-F6A after
// 50,139 random ids) — NF-A.
const COLLIDING = ['b809d470-125c-4416-80cd-5ea321348d83', '2a1b60b4-6e28-4aa8-a064-013c62738223']

const TX = { to: '0x0000000000000000000000000000000000000002', value: 0n } // the signing seam's input; the fake account only records which path signed
const allocated = (n: number, extra: { multisigAddr?: string } = {}): provider.WdkEscrowInput => ({
  id: `escrow-${n}`, tradeId: COLLIDING[n % 2], lockedAmount: '5', wdkAccountScheme: 'ALLOCATED_V1', wdkAccountPath: `1'/0/${n}`, ...extra,
})

beforeEach(() => {
  derivedPaths.length = 0
  mockTransfer.mockReset()
  mockTransfer.mockImplementation(async () => ({ hash: '0xhash', fee: 1n }))
  mockSign.mockReset()
  mockSign.mockImplementation(async (path: string) => `signed-by:${path}`)
})

describe('NF-A — the historical derivation is not unique', () => {
  it('two distinct trade ids derive the same legacy index (and the preflight recomputes it identically)', () => {
    expect(COLLIDING[0]).not.toBe(COLLIDING[1])
    expect(escrowIndexFor(COLLIDING[0])).toBe(escrowIndexFor(COLLIDING[1]))
    expect(legacyIndex(COLLIDING[0])).toBe(escrowIndexFor(COLLIDING[0]))
  })
})

describe('wdkEscrowAccountPath() — the persisted identity, validated, is the only authority', () => {
  it('accepts an allocated path and a legacy path with their own scheme', () => {
    expect(wdkEscrowAccountPath({ id: 'e', wdkAccountScheme: 'ALLOCATED_V1', wdkAccountPath: "1'/0/0" })).toBe("1'/0/0")
    expect(wdkEscrowAccountPath({ id: 'e', wdkAccountScheme: 'ALLOCATED_V1', wdkAccountPath: "1'/0/2147483647" })).toBe("1'/0/2147483647")
    expect(wdkEscrowAccountPath({ id: 'e', wdkAccountScheme: 'LEGACY_TRADE_HASH_V0', wdkAccountPath: "0'/0/1235383240" })).toBe("0'/0/1235383240")
  })

  it.each([
    ['no identity at all', null, null],
    ['path without scheme', null, "1'/0/1"],
    ['scheme without path', 'ALLOCATED_V1', null],
    ['allocated scheme on the legacy branch', 'ALLOCATED_V1', "0'/0/5"],
    ['legacy scheme on the allocated branch', 'LEGACY_TRADE_HASH_V0', "1'/0/5"],
    ['the treasury account', 'LEGACY_TRADE_HASH_V0', "0'/0/0"],
    ['beyond the non-hardened range', 'ALLOCATED_V1', "1'/0/2147483648"],
    ['a hardened leaf', 'ALLOCATED_V1', "1'/0/5'"],
    ['a leading zero (non-canonical)', 'ALLOCATED_V1', "1'/0/05"],
    ['an extra component', 'ALLOCATED_V1', "1'/0/5/1"],
    ['an unknown scheme', 'TRADE_HASH', "1'/0/5"],
  ])('fails closed on %s', (_label, scheme, path) => {
    expect(() => wdkEscrowAccountPath({ id: 'e', wdkAccountScheme: scheme, wdkAccountPath: path })).toThrow(/no valid persisted account identity/)
  })
})

describe('every WDK operation derives the persisted path (WDK_ESCROW_ACCOUNT_STABILITY_V1)', () => {
  it('lock, outbound signing and reconciliation all use exactly wdkAccountPath — two escrows of colliding trades get two accounts', async () => {
    const a = allocated(4)
    const b = allocated(9)
    // #235 R7G-F6B - the LOCK recipient (signed by wdk-lock-authority.ts) is escrowAddress()
    expect([await wdkSettlementProvider.escrowAddress(a), await wdkSettlementProvider.escrowAddress(b)]).toEqual(["addr:1'/0/4", "addr:1'/0/9"])
    derivedPaths.length = 0
    // #235 R7G-F6C - every outbound leg (release / refund / split leg) is signed by the persisted account
    expect([await wdkSettlementProvider.signEscrowTransaction(a, TX), await wdkSettlementProvider.signEscrowTransaction(b, TX)]).toEqual(["signed-by:1'/0/4", "signed-by:1'/0/9"])
    expect(derivedPaths).toEqual(["1'/0/4", "1'/0/9"])
    expect(mockTransfer).not.toHaveBeenCalled()
  })

  it('M14/M20: replacing the historical trade-hash derivation changes nothing — it is not consulted', async () => {
    const legacyPath = `0'/0/${escrowIndexFor(COLLIDING[0])}`
    const spy = jest.spyOn(provider, 'escrowIndexFor').mockReturnValue(123)
    try {
      await wdkSettlementProvider.escrowAddress(allocated(4))
      await wdkSettlementProvider.signEscrowTransaction(allocated(4), TX)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
    expect(derivedPaths).toContain("1'/0/4")
    expect(derivedPaths).not.toContain(legacyPath)
  })

  it('a legacy escrow keeps exactly its persisted historical account', async () => {
    const legacyPath = `0'/0/${escrowIndexFor(COLLIDING[1])}`
    await wdkSettlementProvider.signEscrowTransaction({ id: 'legacy-1', wdkAccountScheme: 'LEGACY_TRADE_HASH_V0', wdkAccountPath: legacyPath }, TX)
    expect(mockSign.mock.calls[0][0]).toBe(legacyPath)
  })

  it('an escrow without a persisted identity is refused before any wallet derivation or transfer', async () => {
    await expect(wdkSettlementProvider.escrowAddress({ id: 'bare' })).rejects.toThrow(/no valid persisted account identity/)
    await expect(wdkSettlementProvider.signEscrowTransaction({ id: 'bare' }, TX)).rejects.toThrow(/no valid persisted account identity/)
    expect(derivedPaths.filter((p) => p !== "0'/0/0")).toEqual([])
    expect([mockTransfer.mock.calls.length, mockSign.mock.calls.length]).toEqual([0, 0])
  })
})

describe('#235 R7G-F6B / R7G-F6C — the provider no longer moves funds through transfer()', () => {
  it('lockFunds() refuses: a WDK LOCK is signed and persisted by the LOCK authority only', async () => {
    await expect(wdkSettlementProvider.lockFunds(allocated(4))).rejects.toThrow(/executed only by the signed-transaction LOCK authority/)
    expect(mockTransfer).not.toHaveBeenCalled()
  })

  it('releaseFunds() / refundFunds() / splitFunds() refuse: WDK outbound is signed and persisted by the outbound authority only', async () => {
    await expect(wdkSettlementProvider.releaseFunds(allocated(4))).rejects.toThrow(/RELEASE .* executed only by the signed outbound authority/)
    await expect(wdkSettlementProvider.refundFunds(allocated(4))).rejects.toThrow(/REFUND .* executed only by the signed outbound authority/)
    await expect(wdkSettlementProvider.splitFunds(allocated(4))).rejects.toThrow(/SPLIT .* executed only by the signed outbound authority/)
    expect([mockTransfer.mock.calls.length, mockSign.mock.calls.length, derivedPaths.length]).toEqual([0, 0, 0])
  })
})

describe('address assertion — a persisted economic address must be what the path derives', () => {
  it('matching address: proceeds', async () => {
    await wdkSettlementProvider.signEscrowTransaction(allocated(4, { multisigAddr: "addr:1'/0/4" }), TX)
    expect(mockSign).toHaveBeenCalledTimes(1)
  })

  it('mismatch: fails closed before transfer(), neither side corrected', async () => {
    const e = allocated(4, { multisigAddr: "addr:1'/0/5" })
    await expect(wdkSettlementProvider.signEscrowTransaction(e, TX)).rejects.toThrow(/derives addr:1'\/0\/4, not its persisted address addr:1'\/0\/5/)
    await expect(wdkSettlementProvider.escrowAddress(e)).rejects.toThrow(/not its persisted address/)
    expect([mockTransfer.mock.calls.length, mockSign.mock.calls.length]).toEqual([0, 0])
    expect(e.multisigAddr).toBe("addr:1'/0/5")
    expect(e.wdkAccountPath).toBe("1'/0/4")
  })
})

describe('read-only preflight classification', () => {
  const row = (id: string, tradeId: string, extra: Record<string, unknown> = {}) => ({ id, tradeId, status: 'CREATED', scheme: null, path: null, economicActivity: false, ...extra })

  it('M25: the real colliding pair is a blocking SHARED_LEGACY_ACCOUNT before the migration', () => {
    const f = classifyWdkAccounts([row('e1', COLLIDING[0]), row('e2', COLLIDING[1], { status: 'COMPLETED', economicActivity: true })], [], false)
    expect(f).toEqual([expect.objectContaining({ kind: 'SHARED_LEGACY_ACCOUNT', blocking: true, index: escrowIndexFor(COLLIDING[0]) })])
    expect(f[0].escrows!.map((e) => e.id).sort()).toEqual(['e1', 'e2'])
  })

  it('after the migration, allocated escrows of colliding trades are not legacy collisions', () => {
    const f = classifyWdkAccounts([
      row('e1', COLLIDING[0], { scheme: 'ALLOCATED_V1', path: "1'/0/0" }),
      row('e2', COLLIDING[1], { scheme: 'ALLOCATED_V1', path: "1'/0/1" }),
    ], [], true)
    expect(f).toEqual([])
  })

  it('treasury, buyer and persisted-identity findings', () => {
    const index = (s: string) => (s === 'T0' ? 0 : s === 'TB' || s === 'buyer:u1' ? 77 : s === 'buyer:u2' || s === 'buyer:u3' ? 88 : s === 'buyer:u4' ? 0 : 5)
    const f = classifyWdkAccounts([
      row('e0', 'T0', { scheme: 'LEGACY_TRADE_HASH_V0', path: "0'/0/0" }),
      row('eb', 'TB', { scheme: 'LEGACY_TRADE_HASH_V0', path: "0'/0/77" }),
      row('ex', 'TX', { scheme: 'LEGACY_TRADE_HASH_V0', path: "0'/0/6" }),
      row('ea', 'TA', { scheme: 'ALLOCATED_V1', path: "1'/0/01" }),
    ], ['u1', 'u2', 'u3', 'u4'], true, index)
    const kinds = f.map((x) => `${x.kind}:${x.blocking}`).sort()
    expect(kinds).toEqual([
      'ESCROW_BUYER_ACCOUNT:false', 'ESCROW_BUYER_ACCOUNT:false', 'PERSISTED_IDENTITY:true', 'PERSISTED_IDENTITY:true', 'PERSISTED_IDENTITY:true',
      'SHARED_BUYER_ACCOUNT:false', 'TREASURY_BUYER_ACCOUNT:false', 'TREASURY_LEGACY_ACCOUNT:true',
    ])
  })
})
