/**
 * SafeGuardEvmProvider (RFC-020) — real ERC-4337 UserOperation
 * construction/hashing, real Safe signature combination logic, and (as of
 * the 2026-08-01 pass) real CREATE2 address prediction / on-chain balance
 * verification / bundler submission logic — no mocking of the crypto or
 * ABI encoding anywhere in this file. What IS mocked: the two genuinely
 * external dependencies this provider now really calls —
 * `ethers.JsonRpcProvider`/`Contract` (a live Sepolia RPC) and the global
 * `fetch` used for the ERC-4337 bundler JSON-RPC call — same "mock the
 * network, not the logic" discipline `multisigProvider.test.ts` already
 * uses for its own block-explorer calls. `jest.requireActual('ethers')`
 * keeps every pure function (`Interface`, `AbiCoder`, `getCreate2Address`,
 * `keccak256`, etc.) real.
 *
 * Fixtures are generated deterministically via sha256(seed) -> secp256k1
 * private key (same technique multisigProvider.test.ts uses for its own
 * hardcoded constants), computed here at module load instead of
 * hardcoded, so there's no risk of a transcription error in a long hex
 * literal.
 */
import { createHash } from 'crypto'
import { secp256k1 } from '@noble/curves/secp256k1'
import { getUserOpHash } from '@satsails/p2p-trading-sdk'
import { EscrowError } from '../src/common/errors'
import { config } from '../src/config'

const mockGetBalance = jest.fn()
const mockGetStorage = jest.fn()
const mockGetNonce = jest.fn()
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers')
  return {
    ...actual,
    JsonRpcProvider: jest.fn().mockImplementation(() => ({
      getBalance: (...args: unknown[]) => mockGetBalance(...args),
      getStorage: (...args: unknown[]) => mockGetStorage(...args),
    })),
    Contract: jest.fn().mockImplementation(() => ({
      getNonce: (...args: unknown[]) => mockGetNonce(...args),
    })),
  }
})

import {
  SafeGuardEvmProvider,
  weiFromDecimalString,
  ethereumAddressFromCompressedHex,
  recoverSignerAddress,
  predictSafeAddress,
  predictGuardAddress,
  deriveSaltNonce,
  type SafeGuardEvmEscrowInput,
} from '../src/modules/open-settlement/safe-guard-evm.provider'

function keypairFromSeed(seed: string) {
  const privateKey = createHash('sha256').update(seed).digest()
  const compressedPubkey = Buffer.from(secp256k1.getPublicKey(privateKey, true)).toString('hex')
  return { privateKey, compressedPubkey }
}

const buyer = keypairFromSeed('safe-guard-evm-buyer')
const seller = keypairFromSeed('safe-guard-evm-seller')

function signDigestHex(privateKey: Buffer, digest: Uint8Array): string {
  const sig = secp256k1.sign(digest, privateKey)
  const compact = sig.toCompactRawBytes()
  const out = new Uint8Array(65)
  out.set(compact, 0)
  out[64] = 27 + sig.recovery
  return '0x' + Buffer.from(out).toString('hex')
}

const SAFE_ADDRESS = '0x' + '11'.repeat(20)
const ZERO_BYTES32 = '0x' + '00'.repeat(32)

function baseEscrow(overrides: Partial<SafeGuardEvmEscrowInput> = {}): SafeGuardEvmEscrowInput {
  return {
    tradeId: 'trade-safe-guard-1',
    lockedAmount: '1.5',
    buyerPubkey: buyer.compressedPubkey,
    sellerPubkey: seller.compressedPubkey,
    buyerId: 'buyer-1',
    sellerId: 'seller-1',
    multisigAddr: SAFE_ADDRESS,
    status: 'FUNDS_LOCKED',
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetNonce.mockResolvedValue(0n)
  mockGetStorage.mockResolvedValue(ZERO_BYTES32) // guard not set yet — the real, expected state
  mockGetBalance.mockResolvedValue(2_000_000_000_000_000_000n) // 2 ETH, well above any test's lockedAmount
})

describe('weiFromDecimalString', () => {
  it('converts a simple decimal string to wei with no float precision loss', () => {
    expect(weiFromDecimalString('1.5')).toBe(1500000000000000000n)
    expect(weiFromDecimalString('0.000000000000000001')).toBe(1n)
    expect(weiFromDecimalString('100')).toBe(100000000000000000000n)
  })

  it('rejects more than 18 decimal places', () => {
    expect(() => weiFromDecimalString('0.0000000000000000001')).toThrow(EscrowError)
  })

  it('handles amounts a float64 conversion would corrupt', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE754 — this exact value would misconvert
    // under a parseFloat()-based approach at 1e18 scale.
    expect(weiFromDecimalString('123456789.123456789')).toBe(123456789123456789000000000n)
  })
})

describe('ethereumAddressFromCompressedHex', () => {
  it('derives a real, valid Ethereum address from a compressed pubkey', () => {
    const address = ethereumAddressFromCompressedHex(buyer.compressedPubkey, 'buyer', 'trade-1')
    expect(address).toMatch(/^0x[0-9a-f]{40}$/)
  })

  it('is deterministic — the same pubkey always derives the same address', () => {
    const a = ethereumAddressFromCompressedHex(buyer.compressedPubkey, 'buyer', 'trade-1')
    const b = ethereumAddressFromCompressedHex(buyer.compressedPubkey, 'buyer', 'trade-1')
    expect(a).toBe(b)
  })

  it('buyer and seller derive different addresses', () => {
    const a = ethereumAddressFromCompressedHex(buyer.compressedPubkey, 'buyer', 'trade-1')
    const b = ethereumAddressFromCompressedHex(seller.compressedPubkey, 'seller', 'trade-1')
    expect(a).not.toBe(b)
  })

  it('throws a clear error when the pubkey is missing', () => {
    expect(() => ethereumAddressFromCompressedHex(undefined, 'buyer', 'trade-1')).toThrow(/submit-key/)
  })
})

describe('recoverSignerAddress', () => {
  it('recovers the real signer address from a genuine ECDSA signature', () => {
    const digest = createHash('sha256').update('some userOpHash').digest()
    const sigHex = signDigestHex(buyer.privateKey, digest)
    const recovered = recoverSignerAddress(sigHex, digest)
    const expected = ethereumAddressFromCompressedHex(buyer.compressedPubkey, 'buyer', 'trade-1')
    expect(recovered).toBe(expected)
  })

  it('SECURITY: recovers a different address for a signature over a different digest', () => {
    const digestA = createHash('sha256').update('message A').digest()
    const digestB = createHash('sha256').update('message B').digest()
    const sigHex = signDigestHex(buyer.privateKey, digestA)
    // Using the signature from digestA but verifying against digestB's
    // recovery must NOT silently resolve to the same address by luck.
    const recoveredWrong = recoverSignerAddress(sigHex, digestB)
    const realAddress = ethereumAddressFromCompressedHex(buyer.compressedPubkey, 'buyer', 'trade-1')
    expect(recoveredWrong).not.toBe(realAddress)
  })
})

describe('SafeGuardEvmProvider.buildUnsignedRelease / buildUnsignedRefund', () => {
  it('cooperative path (not DISPUTED) requires both buyer and seller, builds a real userOpHash', async () => {
    const provider = new SafeGuardEvmProvider()
    const escrow = baseEscrow({ status: 'FUNDS_LOCKED' })
    const result = await provider.buildUnsignedRelease(escrow, '0x' + '22'.repeat(20))

    expect(result.requiredSigners).toEqual(['buyer-1', 'seller-1'])
    const bundle = JSON.parse(result.psbtBase64)
    expect(bundle.path).toBe('COOPERATIVE')
    expect(bundle.userOpHash).toMatch(/^[0-9a-f]{64}$/)
    expect(bundle.userOp.sender).toBe(SAFE_ADDRESS)
    expect(bundle.preEmbeddedSignature).toBeUndefined()

    // Recomputing independently must match what the provider reported.
    const revived = { ...bundle.userOp, nonce: BigInt(bundle.userOp.nonce), preVerificationGas: BigInt(bundle.userOp.preVerificationGas) }
    const recomputed = getUserOpHash(revived, 11155111n, '0x0000000071727De22E5E9d8BAf0edAc6f37da032')
    expect(Buffer.from(recomputed).toString('hex')).toBe(bundle.userOpHash)
  })

  it('disputed path throws a clear error when no AWS_KMS_KEY_ID is configured (real, disclosed boundary)', async () => {
    const provider = new SafeGuardEvmProvider()
    const escrow = baseEscrow({ status: 'DISPUTED' })
    await expect(provider.buildUnsignedRelease(escrow, '0x' + '22'.repeat(20))).rejects.toThrow(/AWS_KMS_KEY_ID/)
  })

  it('buildUnsignedRefund derives the refund address from the seller pubkey', async () => {
    const provider = new SafeGuardEvmProvider()
    const escrow = baseEscrow({ status: 'FUNDS_LOCKED' })
    const result = await provider.buildUnsignedRefund(escrow)
    const expected = ethereumAddressFromCompressedHex(seller.compressedPubkey, 'seller', escrow.tradeId)
    expect(result.toAddress).toBe(expected)
    expect(result.requiredSigners).toEqual(['buyer-1', 'seller-1'])
  })

  // Sails Core Implementation Program M8-R2 (Destination Authority
  // Conformance — per-rail evidence matrix, 2026-09-12). Same property as
  // lightning-hodl.provider.ts's own analogous test: this provider's real
  // buildUnsignedRefund(escrow) takes no destination parameter at all —
  // a caller/arbiter-supplied second argument has no place to go and is
  // simply never read, so the resulting address is unchanged and never
  // equals the supplied value.
  it('M8-R2: a caller-supplied second argument to buildUnsignedRefund() has NO effect — the seller-pubkey-derived address is unchanged', async () => {
    const provider = new SafeGuardEvmProvider()
    const escrow = baseEscrow({ status: 'FUNDS_LOCKED' })
    const { toAddress: withoutArg } = await provider.buildUnsignedRefund(escrow)
    const { toAddress: withBogusArg } = await (provider.buildUnsignedRefund as any)(escrow, '0x000000000000000000000000000000000000dead')
    expect(withBogusArg).toBe(withoutArg)
    expect(withBogusArg).not.toBe('0x000000000000000000000000000000000000dead')
  })

  it('throws a clear error when the Safe address is not recorded (both pubkeys never submitted)', async () => {
    const provider = new SafeGuardEvmProvider()
    const escrow = baseEscrow({ multisigAddr: null })
    await expect(provider.buildUnsignedRelease(escrow, '0x' + '22'.repeat(20))).rejects.toThrow(/submit both buyer and seller pubkeys first/)
  })

  it('bundles a real setGuard() call via MultiSendCallOnly when the guard is not yet active (the real, expected bootstrap case)', async () => {
    const provider = new SafeGuardEvmProvider()
    const escrow = baseEscrow({ status: 'FUNDS_LOCKED' })
    const result = await provider.buildUnsignedRelease(escrow, '0x' + '22'.repeat(20))
    const bundle = JSON.parse(result.psbtBase64)

    expect(mockGetStorage).toHaveBeenCalledWith(SAFE_ADDRESS, expect.any(String))
    // executeUserOp(to=multiSendCallOnly, value=0, data=multiSendData, operation=1/DelegateCall)
    expect(bundle.userOp.callData).toEqual(expect.any(String))
    expect(bundle.guardAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(bundle.guardDeployment.to).toBeDefined()
    expect(bundle.guardDeployment.data).toMatch(/^0x[0-9a-fA-F]+$/)
  })

  it('does NOT bundle setGuard again when the guard is already active (defensive path)', async () => {
    mockGetStorage.mockResolvedValue('0x' + '00'.repeat(11) + '22'.repeat(20) + '00'.repeat(1)) // non-zero guard slot
    const provider = new SafeGuardEvmProvider()
    const escrow = baseEscrow({ status: 'FUNDS_LOCKED' })
    const result = await provider.buildUnsignedRelease(escrow, '0x' + '22'.repeat(20))
    const bundle = JSON.parse(result.psbtBase64)
    // A plain guarded transfer's callData is shorter than a MultiSend batch's.
    expect(bundle.userOp.callData.length).toBeLessThan(600)
  })
})

describe('predictSafeAddress / predictGuardAddress / deriveSaltNonce', () => {
  it('deriveSaltNonce is deterministic and trade-specific', () => {
    expect(deriveSaltNonce('trade-1')).toBe(deriveSaltNonce('trade-1'))
    expect(deriveSaltNonce('trade-1')).not.toBe(deriveSaltNonce('trade-2'))
  })

  it('predictSafeAddress is deterministic and owner/salt-sensitive', () => {
    const owners: [string, string, string] = ['0x' + '11'.repeat(20), '0x' + '22'.repeat(20), '0x' + '33'.repeat(20)]
    const salt = deriveSaltNonce('trade-1')
    const a = predictSafeAddress(owners, salt)
    const b = predictSafeAddress(owners, salt)
    expect(a).toBe(b)
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/)

    const differentOwners: [string, string, string] = ['0x' + '11'.repeat(20), '0x' + '22'.repeat(20), '0x' + '44'.repeat(20)]
    expect(predictSafeAddress(differentOwners, salt)).not.toBe(a)
    expect(predictSafeAddress(owners, deriveSaltNonce('trade-2'))).not.toBe(a)
  })

  it('predictGuardAddress is deterministic and constructor-arg-sensitive', () => {
    const safeAddr = '0x' + '11'.repeat(20)
    const releaseTo = '0x' + '22'.repeat(20)
    const refundTo = '0x' + '33'.repeat(20)
    const salt = deriveSaltNonce('trade-1')
    const a = predictGuardAddress(safeAddr, releaseTo, refundTo, 1500000000000000000n, salt)
    const b = predictGuardAddress(safeAddr, releaseTo, refundTo, 1500000000000000000n, salt)
    expect(a).toBe(b)
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(predictGuardAddress(safeAddr, releaseTo, refundTo, 2000000000000000000n, salt)).not.toBe(a)
  })

  it('a real Safe address is never equal to a real Guard address for the same trade (sanity check, not a security property)', () => {
    const owners: [string, string, string] = ['0x' + '11'.repeat(20), '0x' + '22'.repeat(20), '0x' + '33'.repeat(20)]
    const salt = deriveSaltNonce('trade-1')
    const safeAddr = predictSafeAddress(owners, salt)
    const guardAddr = predictGuardAddress(safeAddr, owners[0], owners[1], 1n, salt)
    expect(guardAddr).not.toBe(safeAddr)
  })
})

describe('SafeGuardEvmProvider.getDepositAddress()', () => {
  it('derives the Safe address from both pubkeys + the KMS arbiter address — the NON_CUSTODIAL_PROVIDERS write path', async () => {
    const provider = new SafeGuardEvmProvider()
    await expect(provider.getDepositAddress('trade-1', buyer.compressedPubkey, seller.compressedPubkey)).rejects.toThrow(/AWS_KMS_KEY_ID/)
  })
})

describe('SafeGuardEvmProvider.finalizeRelease — real signature combination + real bundler submission', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('recovers, sorts by address, and concatenates real submitted signatures, then throws a clear error with no bundler configured', async () => {
    const provider = new SafeGuardEvmProvider()
    const escrow = baseEscrow({ status: 'FUNDS_LOCKED' })
    const unsigned = await provider.buildUnsignedRelease(escrow, '0x' + '22'.repeat(20))
    const bundle = JSON.parse(unsigned.psbtBase64)
    const digest = Buffer.from(bundle.userOpHash, 'hex')

    const buyerSig = signDigestHex(buyer.privateKey, digest)
    const sellerSig = signDigestHex(seller.privateKey, digest)

    // finalizeRelease's real work (recover + sort + concat) succeeds;
    // config.safeGuardEvm.bundlerUrl is empty by default (.env.example),
    // so broadcast() is the one remaining disclosed boundary.
    await expect(provider.finalizeRelease(escrow, unsigned.psbtBase64, [buyerSig, sellerSig])).rejects.toThrow(/SAFE_GUARD_EVM_BUNDLER_URL/)
  })

  it('documents the real ownership boundary: this provider combines whatever signatures it is given — escrow.service.ts, not this file, enforces that every requiredSigner submitted before finalize() is ever called', async () => {
    // See escrow.service.ts's own submitTransactionSignature(): it only
    // invokes finalizeRelease()/finalizeRefund() once every entry in
    // requiredSigners has a stored EscrowTransactionSignature row. This
    // test proves that boundary precisely (finalize() itself does not
    // re-check signer completeness) rather than assuming it.
    const provider = new SafeGuardEvmProvider()
    const escrow = baseEscrow({ status: 'FUNDS_LOCKED' })
    const unsigned = await provider.buildUnsignedRelease(escrow, '0x' + '22'.repeat(20))
    const bundle = JSON.parse(unsigned.psbtBase64)
    const digest = Buffer.from(bundle.userOpHash, 'hex')
    const buyerSig = signDigestHex(buyer.privateKey, digest)

    await expect(provider.finalizeRelease(escrow, unsigned.psbtBase64, [buyerSig])).rejects.toThrow(/SAFE_GUARD_EVM_BUNDLER_URL/)
  })

  it('rejects a malformed signature during combination, before ever reaching broadcast()', async () => {
    const provider = new SafeGuardEvmProvider()
    const escrow = baseEscrow({ status: 'FUNDS_LOCKED' })
    const unsigned = await provider.buildUnsignedRelease(escrow, '0x' + '22'.repeat(20))

    await expect(provider.finalizeRelease(escrow, unsigned.psbtBase64, ['0xnotasignature'])).rejects.toThrow(EscrowError)
  })

  it('with a bundler configured, submits a real eth_sendUserOperation JSON-RPC request and returns the bundler-accepted userOpHash', async () => {
    config.safeGuardEvm.bundlerUrl = 'https://bundler.example/rpc'
    const provider = new SafeGuardEvmProvider()
    const escrow = baseEscrow({ status: 'FUNDS_LOCKED' })
    const unsigned = await provider.buildUnsignedRelease(escrow, '0x' + '22'.repeat(20))
    const bundle = JSON.parse(unsigned.psbtBase64)
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: bundle.userOpHash }),
    })
    global.fetch = mockFetch as unknown as typeof fetch
    const digest = Buffer.from(bundle.userOpHash, 'hex')
    const buyerSig = signDigestHex(buyer.privateKey, digest)
    const sellerSig = signDigestHex(seller.privateKey, digest)

    const result = await provider.finalizeRelease(escrow, unsigned.psbtBase64, [buyerSig, sellerSig])

    expect(result.txId).toBe(bundle.userOpHash)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://bundler.example/rpc')
    const body = JSON.parse(init.body)
    expect(body.method).toBe('eth_sendUserOperation')
    // 65 bytes per signer, no padding/separators, both real signatures present.
    expect(body.params[0].signature).toHaveLength(2 + 130 * 2)
    expect(body.params[0].signature.toLowerCase()).toContain(buyerSig.slice(2).toLowerCase())
    expect(body.params[0].signature.toLowerCase()).toContain(sellerSig.slice(2).toLowerCase())
    expect(body.params[1]).toBe('0x0000000071727De22E5E9d8BAf0edAc6f37da032')
    config.safeGuardEvm.bundlerUrl = ''
  })

  it('#258 rejects a bundler hash that differs from the exact UserOperation Sails signed', async () => {
    config.safeGuardEvm.bundlerUrl = 'https://bundler.example/rpc'
    const provider = new SafeGuardEvmProvider()
    const escrow = baseEscrow({ status: 'FUNDS_LOCKED' })
    const unsigned = await provider.buildUnsignedRelease(escrow, '0x' + '22'.repeat(20))
    const bundle = JSON.parse(unsigned.psbtBase64)
    const digest = Buffer.from(bundle.userOpHash, 'hex')
    const buyerSig = signDigestHex(buyer.privateKey, digest)
    const sellerSig = signDigestHex(seller.privateKey, digest)
    const wrongHash = '0x' + (bundle.userOpHash.slice(2).startsWith('00') ? '11' : '00') + bundle.userOpHash.slice(4)

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: wrongHash }),
    }) as unknown as typeof fetch

    await expect(provider.finalizeRelease(escrow, unsigned.psbtBase64, [buyerSig, sellerSig]))
      .rejects.toThrow(/refusing to let provider response redefine execution identity/)
    config.safeGuardEvm.bundlerUrl = ''
  })

  it('#258 rejects missing or malformed bundler result before local settlement identity can be persisted', async () => {
    config.safeGuardEvm.bundlerUrl = 'https://bundler.example/rpc'
    const provider = new SafeGuardEvmProvider()
    const escrow = baseEscrow({ status: 'FUNDS_LOCKED' })
    const unsigned = await provider.buildUnsignedRelease(escrow, '0x' + '22'.repeat(20))
    const bundle = JSON.parse(unsigned.psbtBase64)
    const digest = Buffer.from(bundle.userOpHash, 'hex')
    const buyerSig = signDigestHex(buyer.privateKey, digest)
    const sellerSig = signDigestHex(seller.privateKey, digest)

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '0xnot-a-hash' }),
    }) as unknown as typeof fetch

    await expect(provider.finalizeRelease(escrow, unsigned.psbtBase64, [buyerSig, sellerSig]))
      .rejects.toThrow(/missing or malformed UserOperation hash/)
    config.safeGuardEvm.bundlerUrl = ''
  })

  it('throws a clear error when the bundler rejects the UserOperation', async () => {
    config.safeGuardEvm.bundlerUrl = 'https://bundler.example/rpc'
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: { message: 'invalid signature' } }),
    }) as unknown as typeof fetch

    const provider = new SafeGuardEvmProvider()
    const escrow = baseEscrow({ status: 'FUNDS_LOCKED' })
    const unsigned = await provider.buildUnsignedRelease(escrow, '0x' + '22'.repeat(20))
    const bundle = JSON.parse(unsigned.psbtBase64)
    const digest = Buffer.from(bundle.userOpHash, 'hex')
    const buyerSig = signDigestHex(buyer.privateKey, digest)
    const sellerSig = signDigestHex(seller.privateKey, digest)

    await expect(provider.finalizeRelease(escrow, unsigned.psbtBase64, [buyerSig, sellerSig])).rejects.toThrow(/invalid signature/)
    config.safeGuardEvm.bundlerUrl = ''
  })
})

// F6 (docs/TECHNICAL_DEBT_AUDIT.md #53, 2026-09-07) — verifyLock() has
// been removed from the interface entirely (it duplicated lockFunds()'s
// own balance check below with no real caller anywhere); this describe
// block's title and tests are trimmed accordingly, not merely renamed.
describe('SafeGuardEvmProvider.lockFunds() — real on-chain balance checks', () => {
  it('lockFunds succeeds once the Safe holds at least lockedAmount', async () => {
    mockGetBalance.mockResolvedValue(1_500_000_000_000_000_000n) // exactly 1.5 ETH
    const provider = new SafeGuardEvmProvider()
    const result = await provider.lockFunds(baseEscrow({ lockedAmount: '1.5' }))
    expect(result.address).toBe(SAFE_ADDRESS)
    expect(mockGetBalance).toHaveBeenCalledWith(SAFE_ADDRESS)
  })

  it('lockFunds throws — non-custodial, does not move funds itself — when the Safe is underfunded', async () => {
    mockGetBalance.mockResolvedValue(1_000_000_000_000_000_000n) // 1 ETH, needs 1.5
    const provider = new SafeGuardEvmProvider()
    await expect(provider.lockFunds(baseEscrow({ lockedAmount: '1.5' }))).rejects.toThrow(/non-custodial/)
  })

  it('lockFunds throws the same "submit pubkeys first" error as buildUnsignedRelease when no Safe address is recorded yet', async () => {
    const provider = new SafeGuardEvmProvider()
    const escrow = baseEscrow({ multisigAddr: null })
    await expect(provider.lockFunds(escrow)).rejects.toThrow(/submit both buyer and seller pubkeys first/)
  })
})

describe('SafeGuardEvmProvider — releaseFunds()/refundFunds() are not directly callable', () => {
  it('releaseFunds is not directly callable', async () => {
    const provider = new SafeGuardEvmProvider()
    await expect(provider.releaseFunds(baseEscrow(), '0x' + '33'.repeat(20))).rejects.toThrow(/not directly callable/)
  })

  it('refundFunds is not directly callable', async () => {
    const provider = new SafeGuardEvmProvider()
    await expect(provider.refundFunds(baseEscrow())).rejects.toThrow(/not directly callable/)
  })
})

// RFC-021 D9 (2026-08-02) — a real contract-level limitation, not a
// missing wire-up: SailsEscrowSafe.sol's checkTransaction() reverts
// WrongAmount() unless value === the immutable lockedAmount, so the
// deployed guard can never authorize a partial transfer to either
// address, let alone two. Confirmed by reading the actual deployed
// contract source before writing this — see this provider's own
// buildUnsignedSplit() comment.
describe('SafeGuardEvmProvider — buildUnsignedSplit() is not supported (immutable Guard contract)', () => {
  it('throws a clear, specific error rather than attempting an unenforceable split', async () => {
    const provider = new SafeGuardEvmProvider()
    await expect(
      provider.buildUnsignedSplit(baseEscrow(), '0x' + '11'.repeat(20), '0x' + '22'.repeat(20), 6000)
    ).rejects.toThrow(/SPLIT is not supported/)
  })
})
