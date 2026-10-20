import { withPersistedFundingAddress } from './helpers/persistedFundingAddress'
/**
 * MultisigProvider — Missão 11 Fase 4/4.1, MANDATORY satoshi-conservation
 * gate.
 *
 * Proves, with real bitcoinjs-lib PSBT decoding (not approximated
 * arithmetic), that for every fee-aware settlement topology:
 *
 *   sum(outputs) + minerFee === input, EXACTLY — no tolerance, no
 *   floating-point approximation, no missing sat.
 *
 * And, more specifically than that bare identity (which is trivially true
 * of any valid Bitcoin transaction): that Sails' own output always equals
 * the independently-computed F(actual) exactly (never a residual), that
 * the buyer's contractual entitlement is never reduced by the Protocol
 * Fee, and that a waived fee never leaves a standalone sub-dust output.
 *
 * Fase 4.1 update: escrow fixtures now carry snapshotFeeCollectionAddress/
 * snapshotFeeCollectionWaivedPreFunding directly, simulating what
 * escrow-fee-snapshot.service.ts's computeSnapshotFields() would have
 * frozen onto the escrow at creation time (that service's own decision
 * logic is unit-tested separately, tests/escrowFeeSnapshotService.test.ts)
 * — multisig.provider.ts itself only ever trusts these frozen fields,
 * never live config, for construction.
 *
 * T is held at a fixed, comfortably large 100,000 sats across the
 * dust/rounding boundary matrix; the desired exact F value is engineered
 * via `rate = F/100000` (a clean, ≤5-decimal-place BTC rate), never via a
 * tiny T — this keeps the buyer's own leg (T−M) far from its own dust
 * boundary while still hitting Sails' fee at an exact sat value.
 * protocolFeeRate = 1 ("100%") used in the non-boundary tests is a
 * deliberately absurd, clearly-fixture-only test rate — never a proposed
 * production rate.
 */
export {}

const ecc = require('tiny-secp256k1')
const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const crypto = require('crypto')
bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const network = bitcoin.networks.testnet

const { dustThresholdSats } = require('../src/modules/open-settlement/bitcoin-dust-policy')

const ORIGINAL_ENV = process.env

const buyerKey = ECPair.fromPrivateKey(crypto.createHash('sha256').update('fase4-buyer').digest(), { network })
const sellerKey = ECPair.fromPrivateKey(crypto.createHash('sha256').update('fase4-seller').digest(), { network })
const buyerPubkeyHex = Buffer.from(buyerKey.publicKey).toString('hex')
const sellerPubkeyHex = Buffer.from(sellerKey.publicKey).toString('hex')

function p2wpkhAddressFor(seed: string): string {
  const key = ECPair.fromPrivateKey(crypto.createHash('sha256').update(seed).digest(), { network })
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key.publicKey), network }).address
}

// Distinct, real, deterministically-derived testnet P2WPKH addresses —
// buyer payout, split-seller payout, and the FROZEN Protocol Fee
// collection address every policy-aware fixture below carries directly
// (never live config). Using the same address for two roles previously
// caused a real test bug here (output.find() silently matched the wrong
// leg) — kept distinct on purpose.
const BUYER_ADDRESS = p2wpkhAddressFor('fase4-buyer-payout')
const SPLIT_SELLER_ADDRESS = p2wpkhAddressFor('fase4-split-seller-payout')
const REFUND_SELLER_ADDRESS = p2wpkhAddressFor('m8rf-refund-seller-payout')
const COLLECTION_ADDRESS = p2wpkhAddressFor('fase4-collection')
const P2WPKH_DUST_THRESHOLD = Number(dustThresholdSats(Buffer.from(bitcoin.address.toOutputScript(COLLECTION_ADDRESS, network))))

function loadProvider(env: Record<string, string | undefined> = {}) {
  jest.resetModules()
  process.env = {
    ...ORIGINAL_ENV,
    MOCK_ESCROW: 'false',
    MULTISIG_SEED: 'seed-fase4',
    TRUSTED_ARBITRATORS: 'arb-1',
    // Fase 4.1 — this env var is now used only as a decoy/live-config
    // value in the "collection destination mutation" test below; every
    // other test's real behavior comes from the frozen escrow field.
    SAILS_PROTOCOL_FEE_COLLECTION_ADDRESS: COLLECTION_ADDRESS,
    ...env,
  }
  return withPersistedFundingAddress(require('../src/modules/open-settlement/multisig.provider'))
}

afterAll(() => {
  process.env = ORIGINAL_ENV
})

const fetchMock = jest.fn()
beforeEach(() => {
  fetchMock.mockReset()
  ;(global as any).fetch = fetchMock
})

/** Funds the mocked explorer with a UTXO of EXACTLY `valueSats` (the
 *  exact-funding model, Fase 3.4) and a controlled, known miner fee rate
 *  so the resulting minerFee is deterministic and independently
 *  recomputable in each assertion. */
function mockExactFunding(txid: string, valueSats: number, feeRateSatsPerVByte = 5) {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ txid, vout: 0, value: valueSats, status: { confirmed: true } }] })
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ halfHourFee: feeRateSatsPerVByte }) })
}

function btcOf(sats: number): string {
  return (sats / 1e8).toFixed(8)
}

/** rate string such that T_sats * rate === targetFeeSats exactly, for the
 *  fixed T=100,000 sats used throughout the boundary matrix below. */
function rateForExactFee(targetFeeSats: number): string {
  return (targetFeeSats / 100_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, '.0')
}

/** 64-hex-char (32-byte) txid, deterministic per test — bitcoinjs-lib
 *  requires a real hex string here. */
function hexId(seed: string): string {
  return crypto.createHash('sha256').update(seed).digest('hex')
}

// Missão 11 Fase 9.3 §4 — every fixture below now needs a persisted
// arbiter commitment (partiesFor() rejects one that doesn't — see
// multisig.provider.ts's own comment). loadProvider() always uses the
// same fixed MULTISIG_SEED/TRUSTED_ARBITRATORS for this whole file, so
// this derivation is stable across every test regardless of which
// freshly-`require()`'d provider instance computes it.
const ARBITER_PUBKEY_HEX: string = loadProvider().multisigProvider.getArbiterPubkeyHex('arb-1')

/** A policy-aware escrow fixture carrying the FROZEN Fase 4.1 snapshot
 *  fields by default (collectible against COLLECTION_ADDRESS) — override
 *  snapshotFeeCollectionAddress/snapshotFeeCollectionWaivedPreFunding
 *  directly to simulate what computeSnapshotFields() would have decided
 *  for a pre-funding-waived escrow. */
function policyAwareEscrow(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    tradeId: 't-fase4', buyerId: 'buyer-1', sellerId: 'seller-1',
    buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey: ARBITER_PUBKEY_HEX,
    status: 'PAYMENT_PENDING',
    feePolicyVersionId: 'policy-fixture-fase4',
    snapshotProtocolFeeRate: '1', // 100% — deliberately absurd, fixture-only, see file header
    snapshotFeeCollectionAddress: COLLECTION_ADDRESS,
    snapshotFeeCollectionWaivedPreFunding: false,
    ...overrides,
  }
}

function decode(psbtBase64: string) {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network })
  const inputValue = Number(psbt.data.inputs[0].witnessUtxo.value)
  const outputs = psbt.txOutputs.map((o: any) => ({ address: o.address, value: Number(o.value) }))
  const outputTotal = outputs.reduce((sum: number, o: any) => sum + o.value, 0)
  const minerFee = inputValue - outputTotal
  return { inputValue, outputs, outputTotal, minerFee }
}

function assertConservation(psbtBase64: string) {
  const { inputValue, outputs, outputTotal, minerFee } = decode(psbtBase64)
  // The mandatory identity itself — exact, integer, no tolerance.
  expect(outputTotal + minerFee).toBe(inputValue)
  expect(Number.isInteger(outputTotal)).toBe(true)
  expect(Number.isInteger(minerFee)).toBe(true)
  return { inputValue, outputs, outputTotal, minerFee }
}

describe('Fase 4.1 — RELEASE satoshi conservation (normal, collectible fee)', () => {
  it('T=100,000, F=100,000 (rate=1): Sails gets exactly F, buyer gets T-M, conservation holds exactly', async () => {
    const { multisigProvider } = loadProvider()
    const T = 100_000
    const escrow = policyAwareEscrow({ lockedAmount: btcOf(T), txLockId: hexId('release-normal') })
    const R = T + T // Fmax = T at rate=1
    mockExactFunding(escrow.txLockId, R)

    const { psbtBase64, feeCollection } = await multisigProvider.buildUnsignedRelease(escrow, BUYER_ADDRESS)
    const { outputs, minerFee } = assertConservation(psbtBase64)

    expect(feeCollection.waived).toBe(false)
    expect(feeCollection.feeSats).toBe(T) // Fmax = F for a plain release
    const sailsOutput = outputs.find((o: any) => o.address === COLLECTION_ADDRESS)
    const buyerOutput = outputs.find((o: any) => o.address === BUYER_ADDRESS)
    expect(sailsOutput.value).toBe(T) // Sails output === independently-computed F(actual), never a residual
    expect(buyerOutput.value).toBe(T - minerFee) // buyer never loses Protocol Fee, only miner fee
    expect(outputs).toHaveLength(2)
  })
})

describe('Fase 4.1 — RELEASE satoshi conservation (PRE-FUNDING waived)', () => {
  it('snapshotFeeCollectionWaivedPreFunding=true: Fmax=0, R=T, single legacy-shaped output — no reserve ever funded, nothing to refund', async () => {
    const { multisigProvider } = loadProvider()
    const T = 100_000
    // rate=1 would normally produce a huge Fmax — the frozen pre-funding
    // decision overrides it to 0 regardless, proving the flag (not the
    // raw rate) is authoritative for maxFeeSats().
    const escrow = policyAwareEscrow({
      lockedAmount: btcOf(T), txLockId: hexId('release-prefunding-waived'),
      snapshotFeeCollectionAddress: null, snapshotFeeCollectionWaivedPreFunding: true,
    })
    mockExactFunding(escrow.txLockId, T) // R = T exactly, no reserve

    const { psbtBase64, feeCollection } = await multisigProvider.buildUnsignedRelease(escrow, BUYER_ADDRESS)
    const { outputs, minerFee } = assertConservation(psbtBase64)

    expect(feeCollection.feeSats).toBe(0)
    expect(feeCollection.waived).toBe(true)
    expect(outputs).toHaveLength(1) // no seller-refund leg, no Sails leg — nothing to attempt
    expect(outputs[0].address).toBe(BUYER_ADDRESS)
    expect(outputs[0].value).toBe(T - minerFee)
  })
})

describe('Fase 4.1 — GAP CLOSED: what used to be sub-dust-Fmax now resolves BEFORE funding, never at settlement', () => {
  // Fase 4's own real, CTO-flagged gap: a nonzero Fmax that turned out
  // sub-dust at settlement time had no valid way to construct either the
  // Sails leg or a standalone seller-refund leg, and buildUnsignedRelease()
  // threw unconditionally — a genuine "funds could get stuck" bug for any
  // escrow whose Fmax fell under ~294 sats. Fase 4.1 closes this by moving
  // the collectibility check BEFORE funding (escrow-fee-snapshot.service.ts):
  // these same Fmax-candidate values now simply never get a reserve funded
  // at all (snapshotFeeCollectionWaivedPreFunding=true, simulating that
  // decision), so RELEASE never has a sub-dust reserve to fail on.
  it('what would have been Fmax=293 (below dust): pre-funding-waived, single output, no throw', async () => {
    const { multisigProvider } = loadProvider()
    const T = 100_000
    const escrow = policyAwareEscrow({
      lockedAmount: btcOf(T), txLockId: hexId('gap-closed-293'),
      snapshotFeeCollectionAddress: null, snapshotFeeCollectionWaivedPreFunding: true,
    })
    mockExactFunding(escrow.txLockId, T)

    const { psbtBase64, feeCollection } = await multisigProvider.buildUnsignedRelease(escrow, BUYER_ADDRESS)
    assertConservation(psbtBase64)
    expect(feeCollection.waived).toBe(true)
  })

  it('what would have been Fmax=1 sat: same closure, confirmed at the most extreme boundary', async () => {
    const { multisigProvider } = loadProvider()
    const T = 100_000
    const escrow = policyAwareEscrow({
      lockedAmount: btcOf(T), txLockId: hexId('gap-closed-1sat'),
      snapshotFeeCollectionAddress: null, snapshotFeeCollectionWaivedPreFunding: true,
    })
    mockExactFunding(escrow.txLockId, T)

    const { psbtBase64, feeCollection } = await multisigProvider.buildUnsignedRelease(escrow, BUYER_ADDRESS)
    assertConservation(psbtBase64)
    expect(feeCollection.waived).toBe(true)
  })
})

describe('Fase 4.1 — collection destination freeze: a live config change after snapshot cannot redirect an escrow\'s fee', () => {
  it('the frozen snapshotFeeCollectionAddress is used, never the live SAILS_PROTOCOL_FEE_COLLECTION_ADDRESS at construction time', async () => {
    const DIFFERENT_LIVE_ADDRESS = p2wpkhAddressFor('fase4-1-attacker-or-just-a-later-config-change')
    // Live config now points somewhere ELSE — simulating an operator
    // changing SAILS_PROTOCOL_FEE_COLLECTION_ADDRESS after this escrow
    // was already created and snapshotted against COLLECTION_ADDRESS.
    const { multisigProvider } = loadProvider({ SAILS_PROTOCOL_FEE_COLLECTION_ADDRESS: DIFFERENT_LIVE_ADDRESS })
    const T = 100_000
    const escrow = policyAwareEscrow({ lockedAmount: btcOf(T), txLockId: hexId('destination-freeze') }) // snapshotFeeCollectionAddress = COLLECTION_ADDRESS (frozen)
    mockExactFunding(escrow.txLockId, T + T)

    const { psbtBase64 } = await multisigProvider.buildUnsignedRelease(escrow, BUYER_ADDRESS)
    const { outputs } = assertConservation(psbtBase64)

    expect(outputs.some((o: any) => o.address === COLLECTION_ADDRESS)).toBe(true) // the FROZEN destination
    expect(outputs.some((o: any) => o.address === DIFFERENT_LIVE_ADDRESS)).toBe(false) // never the live one
  })
})

describe('Fase 4.1 — legacy escrow (no fee policy) — byte-for-byte unchanged topology', () => {
  it('produces a single-output release, no Sails/seller-refund leg at all', async () => {
    const { multisigProvider } = loadProvider()
    const T = 100_000
    const escrow = { tradeId: 't-legacy', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey: ARBITER_PUBKEY_HEX, status: 'PAYMENT_PENDING', lockedAmount: btcOf(T), txLockId: hexId('release-legacy') }
    mockExactFunding(escrow.txLockId, T) // legacy funding is still >= T, here exactly T

    const { psbtBase64, feeCollection } = await multisigProvider.buildUnsignedRelease(escrow, BUYER_ADDRESS)
    const { outputs, minerFee } = assertConservation(psbtBase64)
    expect(feeCollection ?? null).toBeNull()
    expect(outputs).toHaveLength(1)
    expect(outputs[0].value).toBe(T - minerFee)
  })
})

describe('Fase 4.1 — REFUND satoshi conservation (Sails always 0, entire reserve to seller)', () => {
  it('Sails receives nothing; seller receives the full R minus miner fee', async () => {
    const { multisigProvider } = loadProvider()
    const T = 100_000
    const escrow = policyAwareEscrow({ lockedAmount: btcOf(T), txLockId: hexId('refund') })
    const R = T + T
    mockExactFunding(escrow.txLockId, R)

    const { psbtBase64, toAddress } = await multisigProvider.buildUnsignedRefund(escrow, REFUND_SELLER_ADDRESS)
    const { outputs, minerFee } = assertConservation(psbtBase64)

    expect(outputs).toHaveLength(1)
    expect(outputs.some((o: any) => o.address === COLLECTION_ADDRESS)).toBe(false)
    expect(outputs[0].address).toBe(toAddress)
    expect(toAddress).toBe(REFUND_SELLER_ADDRESS) // M8-RF: translated, never derived
    expect(outputs[0].value).toBe(R - minerFee) // the ENTIRE reserve, unconditionally
  })
})

describe('Fase 4.1 — SPLIT satoshi conservation, buyerBps sweep (Fmax collectible, F also collectible)', () => {
  // Large enough that even the most extreme ratio here (1 bps = 0.01%)
  // produces a comfortably non-dust buyer share: 200,000,000 * 0.0001 =
  // 20,000 sats. A smaller T (200,000 was tried first) made buyerBps=1
  // itself hit the pre-existing extreme-ratio dust limit this sweep isn't
  // meant to probe (that's the dedicated buyerBps=0/10000 block below).
  const T = 200_000_000
  const cases = [1, 4999, 5000, 5001, 9999]

  it.each(cases)('buyerBps=%d: buyer entitlement untouched by F, Sails gets exact F on seller-only basis, seller absorbs unused reserve', async (buyerBps) => {
    const { multisigProvider } = loadProvider()
    const escrow = policyAwareEscrow({ lockedAmount: btcOf(T), txLockId: hexId(`split-${buyerBps}`), status: 'DISPUTED' })
    const Fmax = T // rate = 1
    const R = T + Fmax
    mockExactFunding(escrow.txLockId, R)

    const { psbtBase64, feeCollection } = await multisigProvider.buildUnsignedSplit(escrow, BUYER_ADDRESS, SPLIT_SELLER_ADDRESS, buyerBps)
    const { outputs, minerFee } = assertConservation(psbtBase64)

    const sellerBasisSats = Math.floor((T * (10000 - buyerBps)) / 10000)
    const expectedF = sellerBasisSats // rate = 1
    const buyerPool = T - minerFee
    const expectedBuyer = Math.floor((buyerPool * buyerBps) / 10000)
    const expectedSellerBase = buyerPool - expectedBuyer

    const buyerOutput = outputs.find((o: any) => o.address === BUYER_ADDRESS)
    const sellerOutput = outputs.find((o: any) => o.address === SPLIT_SELLER_ADDRESS)
    expect(buyerOutput.value).toBe(expectedBuyer) // NEVER reduced by F — arbiter's ruling is untouched by fee logic

    if (feeCollection.waived) {
      expect(outputs).toHaveLength(2)
      expect(sellerOutput.value).toBe(expectedSellerBase + Fmax) // entire reserve, since F(actual)=0
    } else {
      expect(outputs).toHaveLength(3)
      const sailsOutput = outputs.find((o: any) => o.address === COLLECTION_ADDRESS)
      expect(sailsOutput.value).toBe(expectedF) // fixed by formula, never a residual
      expect(sellerOutput.value).toBe(expectedSellerBase + Fmax - expectedF) // base share + unused reserve
    }
  })
})

describe('Fase 4.1 — SPLIT settlement-time waiver (Fase 4.1 §2/§8): Fmax collectible pre-funding, but actual F sub-dust for THIS ruling', () => {
  it('a real, distinct waiver moment from pre-funding: fee folds into the seller\'s own output, buyerBps untouched, conservation holds', async () => {
    const { multisigProvider } = loadProvider()
    const T = 10_000_000 // 0.1 BTC — Fmax sized against this full T
    const rate = '0.0001' // 0.01% — Fmax = 1,000 sats, comfortably collectible pre-funding
    const escrow = policyAwareEscrow({ lockedAmount: btcOf(T), snapshotProtocolFeeRate: rate, txLockId: hexId('split-settlement-waiver'), status: 'DISPUTED' })
    const Fmax = 1000
    expect(Fmax).toBeGreaterThanOrEqual(P2WPKH_DUST_THRESHOLD) // confirms Fmax itself really is pre-funding-collectible
    mockExactFunding(escrow.txLockId, T + Fmax)

    // At buyerBps=9990, the seller's own bps-portion of T is only 0.1% of
    // T = 10,000 sats — F = floor(10,000 * 0.0001) = 1 sat, sub-dust for
    // THIS specific ruling even though Fmax (sized against the FULL T)
    // cleared dust easily. This is the real, distinct SETTLEMENT-TIME
    // waiver Fase 4.1 §2 describes — never reachable for a plain RELEASE.
    const buyerBps = 9990
    const { psbtBase64, feeCollection } = await multisigProvider.buildUnsignedSplit(escrow, BUYER_ADDRESS, SPLIT_SELLER_ADDRESS, buyerBps)
    const { outputs, minerFee } = assertConservation(psbtBase64)

    expect(feeCollection.waived).toBe(true) // settlement-time waiver, distinct from a pre-funding one
    expect(outputs).toHaveLength(2) // no Sails leg — folded into the seller's own output, never a standalone sub-dust attempt
    expect(outputs.some((o: any) => o.address === COLLECTION_ADDRESS)).toBe(false)

    const tSats = T
    const sellerBasisSats = Math.floor((tSats * (10000 - buyerBps)) / 10000)
    expect(Math.floor(sellerBasisSats * 0.0001)).toBeLessThan(P2WPKH_DUST_THRESHOLD) // confirms F really is sub-dust here
    const buyerPool = tSats - minerFee
    const expectedBuyer = Math.floor((buyerPool * buyerBps) / 10000)
    const expectedSellerBase = buyerPool - expectedBuyer
    const buyerOutput = outputs.find((o: any) => o.address === BUYER_ADDRESS)
    const sellerOutput = outputs.find((o: any) => o.address === SPLIT_SELLER_ADDRESS)
    expect(buyerOutput.value).toBe(expectedBuyer) // buyerBps ruling itself untouched by the waiver
    expect(sellerOutput.value).toBe(expectedSellerBase + Fmax) // entire unused reserve folds in, F(actual)=0 collected
  })
})

describe('Fase 4.1 — SPLIT boundary buyerBps (0 and 10000) — pre-existing topology limitation, not a Fase 4/4.1 regression', () => {
  // Report, not silently clamp (Fase 4's own explicit instruction, still
  // in force). This limitation PRE-DATES Fase 4 entirely: a buyerBps of
  // exactly 0 or 10000 already produced a zero-value output for the
  // losing side before any Protocol Fee logic existed
  // (spendableValue * 0 / 10000 = 0) — the real, pre-existing guard
  // against it lives one layer up, in escrow.service.ts's splitFunds() /
  // escrow-pending-tx.ts's initiateSplit() ("buyerBps must be strictly
  // between 0 and 10000"), never inside the provider itself.
  it('buyerBps=0 at the provider level throws via dust rejection (zero-value buyer output), unrelated to Protocol Fee', async () => {
    const { multisigProvider } = loadProvider()
    const T = 200_000
    const escrow = policyAwareEscrow({ lockedAmount: btcOf(T), txLockId: hexId('split-bps-0'), status: 'DISPUTED' })
    mockExactFunding(escrow.txLockId, T + T)

    await expect(multisigProvider.buildUnsignedSplit(escrow, BUYER_ADDRESS, SPLIT_SELLER_ADDRESS, 0)).rejects.toThrow(/below the .*-sat dust threshold/)
  })

  it('buyerBps=10000 at the provider level throws via dust rejection (zero-value seller-base output), unrelated to Protocol Fee', async () => {
    const { multisigProvider } = loadProvider()
    const T = 200_000
    const escrow = policyAwareEscrow({ lockedAmount: btcOf(T), txLockId: hexId('split-bps-10000'), status: 'DISPUTED' })
    mockExactFunding(escrow.txLockId, T + T)

    // At buyerBps=10000 the seller's BASE share is 0, but Fmax-F(actual)
    // still folds in (F itself is 0 here since the seller basis is 0) —
    // seller's final output = 0 + Fmax - 0 = Fmax, which is NOT dust (Fmax=T
    // here). So this specific boundary does NOT throw under the fee-aware
    // topology, unlike buyerBps=0 above — a genuinely different outcome
    // from the legacy (no-fee) topology, reported explicitly rather than
    // assumed symmetric.
    const { psbtBase64 } = await multisigProvider.buildUnsignedSplit(escrow, BUYER_ADDRESS, SPLIT_SELLER_ADDRESS, 10000)
    const { outputs } = assertConservation(psbtBase64)
    const sellerOutput = outputs.find((o: any) => o.address === SPLIT_SELLER_ADDRESS)
    expect(sellerOutput.value).toBe(T) // = Fmax, the entire reserve, buyer's base share being 0
  })
})

describe('Fase 4.1 — precision/rounding/dust boundary matrix (T fixed at 100,000 sats; F engineered via rate)', () => {
  const T = 100_000

  it('rate=0 (genuine zero-rate policy, distinct from pre-funding-waived): single-output release, no zero-value leg attempted', async () => {
    const { multisigProvider } = loadProvider()
    const escrow = policyAwareEscrow({
      lockedAmount: btcOf(T), snapshotProtocolFeeRate: '0', txLockId: hexId('boundary-rate-0'),
      // A zero-rate policy still gets a real snapshotFeeCollectionAddress
      // (computeSnapshotFields never evaluates collectibility at rate=0)
      // — waivedPreFunding stays false, proving Fmax=0 here comes from
      // the rate math itself, not the pre-funding flag.
      snapshotFeeCollectionWaivedPreFunding: false,
    })
    mockExactFunding(escrow.txLockId, T) // Fmax=0, so required funding = T exactly

    const { psbtBase64, feeCollection } = await multisigProvider.buildUnsignedRelease(escrow, BUYER_ADDRESS)
    const { outputs, minerFee } = assertConservation(psbtBase64)
    expect(feeCollection.feeSats).toBe(0)
    expect(feeCollection.waived).toBe(true)
    expect(outputs).toHaveLength(1) // no seller-refund-of-a-zero-reserve leg attempted
    expect(outputs[0].address).toBe(BUYER_ADDRESS)
    expect(outputs[0].value).toBe(T - minerFee)
  })

  it(`dust boundary exactly (F=${P2WPKH_DUST_THRESHOLD}): collectible (Bitcoin Core's IsDust() is strict less-than — AT the threshold is standard)`, async () => {
    const { multisigProvider } = loadProvider()
    const target = P2WPKH_DUST_THRESHOLD
    const escrow = policyAwareEscrow({ lockedAmount: btcOf(T), snapshotProtocolFeeRate: rateForExactFee(target), txLockId: hexId('boundary-dust-exact') })
    mockExactFunding(escrow.txLockId, T + target)
    const { psbtBase64, feeCollection } = await multisigProvider.buildUnsignedRelease(escrow, BUYER_ADDRESS)
    assertConservation(psbtBase64)
    expect(feeCollection.waived).toBe(false)
    expect(feeCollection.feeSats).toBe(target)
  })

  it(`dust boundary + 1 (F=${P2WPKH_DUST_THRESHOLD + 1}): collectible`, async () => {
    const { multisigProvider } = loadProvider()
    const target = P2WPKH_DUST_THRESHOLD + 1
    const escrow = policyAwareEscrow({ lockedAmount: btcOf(T), snapshotProtocolFeeRate: rateForExactFee(target), txLockId: hexId('boundary-dust-plus-1') })
    mockExactFunding(escrow.txLockId, T + target)
    const { feeCollection } = await multisigProvider.buildUnsignedRelease(escrow, BUYER_ADDRESS)
    expect(feeCollection.waived).toBe(false)
    expect(feeCollection.feeSats).toBe(target)
  })

  it('small T (near-minimum real trade, Fmax comfortably above dust): conservation holds exactly', async () => {
    const { multisigProvider } = loadProvider()
    const smallT = 10_000
    const escrow = policyAwareEscrow({ lockedAmount: btcOf(smallT), snapshotProtocolFeeRate: '0.05', txLockId: hexId('boundary-small-t') })
    const fmax = Math.floor(smallT * 0.05) // 500
    mockExactFunding(escrow.txLockId, smallT + fmax)
    const { psbtBase64, feeCollection } = await multisigProvider.buildUnsignedRelease(escrow, BUYER_ADDRESS)
    const { outputs, minerFee } = assertConservation(psbtBase64)
    expect(feeCollection.feeSats).toBe(fmax)
    expect(feeCollection.waived).toBe(false)
    const buyerOutput = outputs.find((o: any) => o.address === BUYER_ADDRESS)
    expect(buyerOutput.value).toBe(smallT - minerFee)
  })

  it('large T: conservation holds exactly at a whole-BTC-scale trade', async () => {
    const { multisigProvider } = loadProvider()
    const largeT = 50_000_000 // 0.5 BTC
    const escrow = policyAwareEscrow({ lockedAmount: btcOf(largeT), snapshotProtocolFeeRate: '0.004', txLockId: hexId('boundary-large-t') })
    const fmax = Math.floor(largeT * 0.004) // 200,000
    mockExactFunding(escrow.txLockId, largeT + fmax)
    const { psbtBase64, feeCollection } = await multisigProvider.buildUnsignedRelease(escrow, BUYER_ADDRESS)
    const { outputs, minerFee } = assertConservation(psbtBase64)
    expect(feeCollection.feeSats).toBe(fmax)
    const sailsOutput = outputs.find((o: any) => o.address === COLLECTION_ADDRESS)
    expect(sailsOutput.value).toBe(fmax)
    const buyerOutput = outputs.find((o: any) => o.address === BUYER_ADDRESS)
    expect(buyerOutput.value).toBe(largeT - minerFee)
  })

  it('fee rounding boundary: a rate that does not divide evenly into whole sats floors down, never rounds up', async () => {
    const { multisigProvider } = loadProvider()
    // 100_000 * 0.0033333 = 333.33 sats — must floor to 333, never 334.
    const escrow = policyAwareEscrow({ lockedAmount: btcOf(T), snapshotProtocolFeeRate: '0.0033333', txLockId: hexId('boundary-rounding') })
    const fmax = 333
    mockExactFunding(escrow.txLockId, T + fmax)
    const { feeCollection } = await multisigProvider.buildUnsignedRelease(escrow, BUYER_ADDRESS)
    expect(feeCollection.feeSats).toBe(333) // floored, not 334
  })

  it('Fmax > F (SPLIT): the unused-reserve residual is computed correctly and folds into the seller output exactly', async () => {
    const { multisigProvider } = loadProvider()
    const splitT = 200_000
    const escrow = policyAwareEscrow({ lockedAmount: btcOf(splitT), snapshotProtocolFeeRate: '0.5', txLockId: hexId('boundary-fmax-gt-f'), status: 'DISPUTED' })
    const Fmax = Math.floor(splitT * 0.5) // 100,000 — sized against the FULL T
    mockExactFunding(escrow.txLockId, splitT + Fmax)
    const buyerBps = 3000
    const { psbtBase64, feeCollection } = await multisigProvider.buildUnsignedSplit(escrow, BUYER_ADDRESS, SPLIT_SELLER_ADDRESS, buyerBps)
    const { outputs, minerFee } = assertConservation(psbtBase64)

    const sellerBasisSats = Math.floor((splitT * (10000 - buyerBps)) / 10000) // 140,000
    const expectedF = Math.floor(sellerBasisSats * 0.5) // 70,000 — strictly less than Fmax (100,000)
    expect(feeCollection.feeSats).toBe(expectedF)
    expect(expectedF).toBeLessThan(Fmax) // Fmax > F confirmed, not a degenerate equal case

    const buyerPool = splitT - minerFee
    const expectedBuyer = Math.floor((buyerPool * buyerBps) / 10000)
    const expectedSellerBase = buyerPool - expectedBuyer
    const sellerOutput = outputs.find((o: any) => o.address === SPLIT_SELLER_ADDRESS)
    expect(sellerOutput.value).toBe(expectedSellerBase + Fmax - expectedF) // includes the (Fmax - F) = 30,000 unused reserve
  })

  it('Fmax = F (RELEASE, the degenerate equal case): unused reserve is exactly 0, no residual leaks anywhere', async () => {
    const { multisigProvider } = loadProvider()
    const escrow = policyAwareEscrow({ lockedAmount: btcOf(T), txLockId: hexId('boundary-fmax-eq-f') }) // rate=1 => Fmax=F=T always for release
    mockExactFunding(escrow.txLockId, T + T)
    const { psbtBase64, feeCollection } = await multisigProvider.buildUnsignedRelease(escrow, BUYER_ADDRESS)
    const { outputs } = assertConservation(psbtBase64)
    expect(feeCollection.feeSats).toBe(T)
    const sailsOutput = outputs.find((o: any) => o.address === COLLECTION_ADDRESS)
    expect(sailsOutput.value).toBe(T) // Fmax === F here — Sails gets the whole reserve, seller gets nothing extra (no seller leg exists in a normal release at all)
    expect(outputs).toHaveLength(2)
  })
})
