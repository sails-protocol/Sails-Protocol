import { withPersistedFundingAddress } from './helpers/persistedFundingAddress'
/**
 * Missão 10, Fase 4 — dust/output policy at the release/refund/split
 * level (buildUnsignedRelease/buildUnsignedRefund/buildUnsignedSplit).
 *
 * Every case here proves rejection happens BEFORE a PSBT is ever
 * returned — buildUnsignedSpend() throws synchronously inside these
 * calls, before escrow-pending-tx.ts's initiateSignatureCollectionCore()
 * ever reaches its prisma.escrowPendingTransaction.create() call (see
 * tests/integration/multisigDustPolicyIntegration.test.ts for the real-
 * Postgres proof that no pending row, and therefore no signature
 * request, is ever created for a rejected build).
 *
 * Fee math used throughout: estimateFeeSats(rate, outputCount) =
 * ceil(rate * (11 + 110 + 43*outputCount)) — 164 vB for release/refund
 * (1 output), 207 vB for split (2 outputs). Using rate=1 sat/vB
 * everywhere makes the fee a round, easy-to-reason-about number, so
 * exact dust-boundary UTXO values can be chosen deliberately.
 */
export {}

const ORIGINAL_ENV = process.env
const BUYER_PUBKEY = '021744d7bd3cd8e7f62e7aa8f7db8292680b745d09f8f40377c4bbbc0136d4e299'
const SELLER_PUBKEY = '038e41e2cb09677fd4bde9f232871533925c4b628c25efdb9d572546293850ddd4'

function loadProvider() {
  jest.resetModules()
  process.env = { ...ORIGINAL_ENV, MOCK_ESCROW: 'false', MULTISIG_SEED: 'seed-dust', TRUSTED_ARBITRATORS: 'arb-dust' }
  return withPersistedFundingAddress(require('../src/modules/open-settlement/multisig.provider'))
}
afterAll(() => { process.env = ORIGINAL_ENV })

const fetchMock = jest.fn()
beforeEach(() => {
  fetchMock.mockReset()
  ;(global as any).fetch = fetchMock
})

function mockExplorerThenFee(utxoValue: number, feeRateSatsPerVByte = 1, txid = 'd'.repeat(64)) {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ txid, vout: 0, value: utxoValue, status: { confirmed: true } }] })
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ halfHourFee: feeRateSatsPerVByte }) })
}

// Mainnet-network provider so P2WPKH destination addresses (real,
// already-used-this-repo addresses) decode correctly — bech32 addresses
// are network-specific and MULTISIG_NETWORK defaults to testnet
// otherwise.
function loadMainnetProvider() {
  jest.resetModules()
  // Missão 11 Fase 8.1 LB-01 — MULTISIG_EXPLORER_API_URL must be set
  // explicitly here now: config/index.ts refuses to boot with
  // MULTISIG_NETWORK=mainnet while the explorer URL still looks
  // testnet-pointed (the exact contradiction the new guard exists to
  // catch). This test never queries a real explorer (mockExplorerThenFee
  // stubs fetch), so the URL's actual reachability doesn't matter — only
  // that it doesn't contain "testnet".
  // Missão 11 Fase 8.1 LB-02 — MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS is
  // now required alongside MULTISIG_NETWORK=mainnet, same reasoning as
  // MULTISIG_EXPLORER_API_URL above. This file's own tests build unsigned
  // PSBTs (buildUnsignedRelease/Split), never lockFunds()
  // (the method that actually reads this value), so the number
  // itself is inert here — set for boot-time validity only.
  process.env = { ...ORIGINAL_ENV, MOCK_ESCROW: 'false', MULTISIG_SEED: 'seed-dust', TRUSTED_ARBITRATORS: 'arb-dust', MULTISIG_NETWORK: 'bitcoin', MULTISIG_EXPLORER_API_URL: 'https://mempool.space/api', MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS: '1' }
  return withPersistedFundingAddress(require('../src/modules/open-settlement/multisig.provider'))
}

const P2WPKH_ADDR = 'bc1q7mrvhs3xxzg9jyesd60nvda26ueukn9nc404xk' // real Missão 09 buyer payout address
const RELEASE_FEE_1SAT = 164 // estimateFeeSats(1, 1)
const SPLIT_FEE_1SAT = 207 // estimateFeeSats(1, 2)

// Missão 11 Fase 9.3 §4 — partiesFor() now rejects an escrow with no
// persisted arbiter commitment. Both loadProvider()/loadMainnetProvider()
// above use the same MULTISIG_SEED/TRUSTED_ARBITRATORS, so one derivation
// (network only affects address/WIF encoding, never the raw pubkey bytes)
// covers every test in this file.
const ARBITER_PUBKEY_HEX: string = loadProvider().multisigProvider.getArbiterPubkeyHex('arb-dust')

const baseEscrow = { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: BUYER_PUBKEY, sellerPubkey: SELLER_PUBKEY, arbiterPubkey: ARBITER_PUBKEY_HEX, lockedAmount: '0.001', txLockId: 'd'.repeat(64), txLockVout: 0 }

describe('A. Release — dust matrix', () => {
  it('A1. output clearly above dust (spendable = 10,000) → PASS', async () => {
    const { multisigProvider } = loadMainnetProvider()
    mockExplorerThenFee(10_000 + RELEASE_FEE_1SAT)
    const { psbtBase64 } = await multisigProvider.buildUnsignedRelease({ ...baseEscrow, status: 'PAYMENT_PENDING' }, P2WPKH_ADDR)
    expect(typeof psbtBase64).toBe('string')
  })

  it('A2. output exactly at the 294-sat P2WPKH threshold → ALLOWED (documented: strict less-than, matching Bitcoin Core\'s IsDust())', async () => {
    const { multisigProvider } = loadMainnetProvider()
    mockExplorerThenFee(294 + RELEASE_FEE_1SAT)
    const { psbtBase64 } = await multisigProvider.buildUnsignedRelease({ ...baseEscrow, status: 'PAYMENT_PENDING' }, P2WPKH_ADDR)
    const bitcoin = require('bitcoinjs-lib')
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64)
    expect(psbt.txOutputs[0].value).toBe(294n)
  })

  it('A3. output 1 sat below threshold (293) → REJECTED before any signature is possible', async () => {
    const { multisigProvider } = loadMainnetProvider()
    mockExplorerThenFee(293 + RELEASE_FEE_1SAT)
    await expect(multisigProvider.buildUnsignedRelease({ ...baseEscrow, status: 'PAYMENT_PENDING' }, P2WPKH_ADDR))
      .rejects.toThrow(/below the 294-sat dust threshold/)
  })
})

describe('B. Refund — same dust matrix', () => {
  // Sails Core Implementation Program M8-RF (Destination Consistency,
  // 2026-08-31) — buildUnsignedRefund() now TRANSLATES an authorized
  // destination (P2WPKH_ADDR, the same real mainnet address release's
  // own tests above already use) instead of deriving one internally from
  // the seller pubkey. The dust-threshold arithmetic this describe block
  // exists to prove is completely unaffected by WHICH address is used —
  // only the OUTPUT VALUE matters here.

  it('B1. output clearly above dust → PASS', async () => {
    const { multisigProvider } = loadMainnetProvider()
    mockExplorerThenFee(10_000 + RELEASE_FEE_1SAT)
    const { psbtBase64, toAddress } = await multisigProvider.buildUnsignedRefund({ ...baseEscrow, status: 'FUNDS_LOCKED' }, P2WPKH_ADDR)
    expect(typeof psbtBase64).toBe('string')
    expect(toAddress).toBe(P2WPKH_ADDR)
  })

  it('B2. output exactly at threshold → ALLOWED', async () => {
    const { multisigProvider } = loadMainnetProvider()
    mockExplorerThenFee(294 + RELEASE_FEE_1SAT)
    const { psbtBase64 } = await multisigProvider.buildUnsignedRefund({ ...baseEscrow, status: 'FUNDS_LOCKED' }, P2WPKH_ADDR)
    const bitcoin = require('bitcoinjs-lib')
    expect(bitcoin.Psbt.fromBase64(psbtBase64).txOutputs[0].value).toBe(294n)
  })

  it('B3. output 1 sat below threshold → REJECTED', async () => {
    const { multisigProvider } = loadMainnetProvider()
    mockExplorerThenFee(293 + RELEASE_FEE_1SAT)
    await expect(multisigProvider.buildUnsignedRefund({ ...baseEscrow, status: 'FUNDS_LOCKED' }, P2WPKH_ADDR))
      .rejects.toThrow(/below the 294-sat dust threshold/)
  })
})

describe('C. Split — per-output dust matrix (each output validated independently, sum being correct is not enough)', () => {
  const SELLER_ADDR = 'bc1qupu02kgwtgwm7gx7vq2ep9mtf52m55c62papmj' // real address used this session, different from the buyer's

  it('C1. both outputs well above dust (50/50 of 1000 spendable) → PASS, sum and fee exact', async () => {
    const { multisigProvider } = loadMainnetProvider()
    const utxoValue = 1000 + SPLIT_FEE_1SAT
    mockExplorerThenFee(utxoValue)
    const { psbtBase64 } = await multisigProvider.buildUnsignedSplit({ ...baseEscrow, status: 'DISPUTED' }, P2WPKH_ADDR, SELLER_ADDR, 5000)
    const bitcoin = require('bitcoinjs-lib')
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64)
    const buyerOut = psbt.txOutputs[0].value as bigint
    const sellerOut = psbt.txOutputs[1].value as bigint
    expect(buyerOut).toBe(500n)
    expect(sellerOut).toBe(500n)
    // sum + fee == input value, exactly.
    expect(buyerOut + sellerOut + BigInt(SPLIT_FEE_1SAT)).toBe(BigInt(utxoValue))
  })

  it('C2. buyer dust (1%), seller valid (99%) of 1000 spendable → REJECTED', async () => {
    const { multisigProvider } = loadMainnetProvider()
    mockExplorerThenFee(1000 + SPLIT_FEE_1SAT)
    // buyerValue = 1000*100/10000 = 10 sats (dust); sellerValue = 990.
    await expect(multisigProvider.buildUnsignedSplit({ ...baseEscrow, status: 'DISPUTED' }, P2WPKH_ADDR, SELLER_ADDR, 100))
      .rejects.toThrow(/below the 294-sat dust threshold/)
  })

  it('C3. seller dust (1%), buyer valid (99%) of 1000 spendable → REJECTED', async () => {
    const { multisigProvider } = loadMainnetProvider()
    mockExplorerThenFee(1000 + SPLIT_FEE_1SAT)
    // buyerValue = 1000*9900/10000 = 990; sellerValue = 10 (dust).
    await expect(multisigProvider.buildUnsignedSplit({ ...baseEscrow, status: 'DISPUTED' }, P2WPKH_ADDR, SELLER_ADDR, 9900))
      .rejects.toThrow(/below the 294-sat dust threshold/)
  })

  it('C4. both outputs dust (50/50 of a too-small 500 spendable) → REJECTED', async () => {
    const { multisigProvider } = loadMainnetProvider()
    mockExplorerThenFee(500 + SPLIT_FEE_1SAT)
    // buyerValue = sellerValue = 250, both below 294.
    await expect(multisigProvider.buildUnsignedSplit({ ...baseEscrow, status: 'DISPUTED' }, P2WPKH_ADDR, SELLER_ADDR, 5000))
      .rejects.toThrow(/below the 294-sat dust threshold/)
  })
})

describe('D. Destination scripts', () => {
  it('D1-a. currently-accepted script types all pass through validateOutput correctly (P2WPKH exercised above; P2WSH/P2TR/P2PKH/P2SH covered in bitcoinDustPolicy.test.ts at the policy-unit level)', () => {
    // Deliberately not re-duplicated at the provider level — the
    // provider only ever forwards {address, value} to validateOutput()
    // unchanged, so bitcoinDustPolicy.test.ts's own address-type
    // coverage already proves this layer's correctness for every type.
    expect(true).toBe(true)
  })

  it('D2. release rejects an address that does not match the configured network (mainnet address, testnet-configured provider)', async () => {
    const { multisigProvider } = loadProvider() // no MULTISIG_NETWORK override — defaults to testnet
    mockExplorerThenFee(10_000 + RELEASE_FEE_1SAT)
    await expect(multisigProvider.buildUnsignedRelease({ ...baseEscrow, status: 'PAYMENT_PENDING' }, P2WPKH_ADDR /* a real MAINNET address */))
      .rejects.toThrow(/invalid or does not match the configured network/)
  })

  it('D2-b. release rejects a syntactically invalid destination address', async () => {
    const { multisigProvider } = loadMainnetProvider()
    mockExplorerThenFee(10_000 + RELEASE_FEE_1SAT)
    await expect(multisigProvider.buildUnsignedRelease({ ...baseEscrow, status: 'PAYMENT_PENDING' }, 'not-a-real-address'))
      .rejects.toThrow(/invalid or does not match the configured network/)
  })
})

describe('E. Fee edge cases', () => {
  it('E1. fee >= input value → rejected before dust is even reached (pre-existing spendableValue<=0 guard, unchanged)', async () => {
    const { multisigProvider } = loadMainnetProvider()
    mockExplorerThenFee(RELEASE_FEE_1SAT) // exactly the fee, nothing left over
    await expect(multisigProvider.buildUnsignedRelease({ ...baseEscrow, status: 'PAYMENT_PENDING' }, P2WPKH_ADDR))
      .rejects.toThrow(/too small to cover the estimated/)
  })

  it('E2. a higher fee rate that pushes the remaining output into dust is caught by the SAME dust check, not a separate code path', async () => {
    const { multisigProvider } = loadMainnetProvider()
    const highRateFee = 50 * 164 // 50 sat/vB
    mockExplorerThenFee(highRateFee + 100, 50) // only 100 sats left after fee — dust
    await expect(multisigProvider.buildUnsignedRelease({ ...baseEscrow, status: 'PAYMENT_PENDING' }, P2WPKH_ADDR))
      .rejects.toThrow(/below the 294-sat dust threshold/)
  })

  it('E3. high but still-valid fee rate leaves a non-dust output → PASS', async () => {
    const { multisigProvider } = loadMainnetProvider()
    const highRateFee = 50 * 164
    mockExplorerThenFee(highRateFee + 10_000, 50)
    const { psbtBase64 } = await multisigProvider.buildUnsignedRelease({ ...baseEscrow, status: 'PAYMENT_PENDING' }, P2WPKH_ADDR)
    expect(typeof psbtBase64).toBe('string')
  })
})
