/**
 * G4: from data the client verified itself (the signed committed policy and T), the SDK reproduces, output by output,
 * the PSBT the MULTISIG provider actually builds, with and without break-even; checkFeeAwarePsbt derives the fee rate
 * from the PSBT and refuses a redirected or mis-sized fee output, an extra output, a wrong funding input, and a miner
 * fee above the client's cap even without break-even.
 */
export {}

const ecc = require('tiny-secp256k1')
const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const crypto = require('crypto')
bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const network = bitcoin.networks.testnet

const { buildExpectedFeeAwareOutputs, checkFeeAwarePsbt, dustSats, feeAwareEscrowFromPolicy } = require('../packages/sails-sdk/src/modules/fee-outputs')
const { dustThresholdSats } = require('../src/modules/open-settlement/bitcoin-dust-policy')

const BE = { fMaxSatPerVb: 25, vBytes: 43, dMaxSats: 330, collectionDustSats: 330, allowedPayoutTypes: ['P2WPKH', 'P2WSH', 'P2TR'] }
const RATE = '0.004'
const CAP = { maxFeeRateSatPerVb: 200 }
const key = (seed: string) => ECPair.fromPrivateKey(crypto.createHash('sha256').update(seed).digest(), { network })
const p2wpkh = (seed: string) => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key(seed).publicKey), network }).address
const p2tr = (seed: string) => bitcoin.payments.p2tr({ internalPubkey: Buffer.from(key(seed).publicKey).subarray(1, 33), network }).address

const ORIGINAL_ENV = process.env
function loadProvider(collection: string) {
  jest.resetModules()
  process.env = { ...ORIGINAL_ENV, MOCK_ESCROW: 'false', MULTISIG_SEED: 'seed-parity', TRUSTED_ARBITRATORS: 'arb-1', SAILS_PROTOCOL_FEE_COLLECTION_ADDRESS: collection }
  return require('../src/modules/open-settlement/multisig.provider')
}
afterAll(() => { process.env = ORIGINAL_ENV })
const fetchMock = jest.fn()
beforeEach(() => { fetchMock.mockReset(); (global as any).fetch = fetchMock })

const collection = p2wpkh('parity-collection')
const buyer = p2tr('parity-buyer')
const seller = p2wpkh('parity-seller')
const policyOf = (withBreakEven: boolean) => ({
  version: 2, protocolFeeRate: RATE, payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 2,
  smallTradeRule: withBreakEven ? { breakEven: BE } : {}, rail: 'MULTISIG', network: 'testnet',
  destination: { kind: 'address', value: collection }, validFrom: '2026-11-01T00:00:00.000Z', validUntil: null,
})

it("the SDK dust formula matches the node for every output type used here", () => {
  for (const a of [collection, buyer, seller]) {
    expect(dustSats(a, network)).toBe(dustThresholdSats(Buffer.from(bitcoin.address.toOutputScript(a, network))))
  }
})

it("the SDK recomputes the pre-funding waiver from the policy, never from a node flag", () => {
  expect(feeAwareEscrowFromPolicy(policyOf(true), 100_000n, network)).toMatchObject({ waivedPreFunding: true, collectionAddress: null })
  expect(feeAwareEscrowFromPolicy(policyOf(true), 2_000_000n, network)).toMatchObject({ waivedPreFunding: false, collectionAddress: collection })
  expect(feeAwareEscrowFromPolicy(policyOf(false), 100_000n, network)).toMatchObject({ waivedPreFunding: false, collectionAddress: collection })
})

describe("SDK expected outputs == the PSBT the provider builds", () => {
  for (const withBreakEven of [true, false]) {
    it(`${withBreakEven ? 'with' : 'without'} break-even: every outcome, size and fee rate`, async () => {
      const { multisigProvider } = loadProvider(collection)
      const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
      const bk = key('parity-buyer-key'); const sk = key('parity-seller-key')
      let checked = 0
      for (const T of [100_000, 351_250, 2_000_000]) {
        // The client's terms come only from the signed policy and T; the provider gets the node's frozen snapshot.
        const sdkEscrow = feeAwareEscrowFromPolicy(policyOf(withBreakEven), BigInt(T), network)
        const reserve = sdkEscrow.collectionAddress !== null
        const fmax = reserve ? Math.floor(T * Number(RATE)) : 0
        for (const market of [1, 7.5, 25, 60]) {
          const txid = crypto.createHash('sha256').update(`${withBreakEven}-${T}-${market}`).digest('hex')
          const escrow = {
            tradeId: `p-${T}-${market}`, buyerId: 'buyer-1', sellerId: 'seller-1', status: 'DISPUTED', triggeredBy: 'arb-1',
            buyerPubkey: Buffer.from(bk.publicKey).toString('hex'), sellerPubkey: Buffer.from(sk.publicKey).toString('hex'), arbiterPubkey,
            lockedAmount: (T / 1e8).toFixed(8), txLockId: txid, txLockVout: 0,
            feePolicyVersionId: 'policy-parity', snapshotProtocolFeeRate: RATE,
            snapshotFeeCollectionAddress: reserve ? collection : null, snapshotFeeCollectionWaivedPreFunding: !reserve,
            feeBreakEven: withBreakEven ? BE : null,
          }
          const R = T + fmax
          const fund = () => {
            if (withBreakEven) fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ halfHourFee: market }) })
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ txid, vout: 0, value: R, status: { confirmed: true } }] })
            if (!withBreakEven) fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ halfHourFee: market }) })
          }
          const outcomes = [
            { kind: 'RELEASE', buyer }, { kind: 'REFUND', seller },
            { kind: 'SPLIT', buyer, seller, buyerBps: 1000 }, { kind: 'SPLIT', buyer, seller, buyerBps: 5000 }, { kind: 'SPLIT', buyer, seller, buyerBps: 9000 },
          ]
          for (const o of outcomes) {
            fund()
            const built = o.kind === 'RELEASE' ? await multisigProvider.buildUnsignedRelease(escrow, buyer)
              : o.kind === 'REFUND' ? await multisigProvider.buildUnsignedRefund(escrow, seller)
              : await multisigProvider.buildUnsignedSplit(escrow, buyer, seller, (o as any).buyerBps)
            const psbt = bitcoin.Psbt.fromBase64(built.psbtBase64, { network })
            const actual = psbt.txOutputs.map((x: any) => ({ address: bitcoin.address.fromOutputScript(x.script, network), value: BigInt(x.value) }))
            const f = withBreakEven ? Math.min(market, BE.fMaxSatPerVb) : market
            expect(buildExpectedFeeAwareOutputs(sdkEscrow, o, f, network)).toEqual(actual)
            // The fee rate is derived from the PSBT itself; the node never tells it.
            expect(checkFeeAwarePsbt(built.psbtBase64, sdkEscrow, o, network, CAP)).toMatchObject({ ok: true })
            checked++
          }
        }
      }
      expect(checked).toBe(3 * 4 * 5)
    })
  }
})

describe("checkFeeAwarePsbt refuses tampering", () => {
  const T = 2_000_000
  const psbtWith = (e: any, outputs: Array<{ address: string; value: bigint }>, inputValue?: bigint) => {
    const p = new bitcoin.Psbt({ network })
    const script = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key('in').publicKey), network }).output
    const fmax = e.waivedPreFunding ? 0n : (e.lockedSats * 400_000n) / 100_000_000n
    p.addInput({ hash: '00'.repeat(32), index: 0, witnessUtxo: { script, value: inputValue ?? e.lockedSats + fmax } })
    for (const x of outputs) p.addOutput({ address: x.address, value: x.value })
    return p.toBase64()
  }
  const withBE = feeAwareEscrowFromPolicy(policyOf(true), BigInt(T), network)
  const noBE = feeAwareEscrowFromPolicy(policyOf(false), BigInt(T), network)
  const o = { kind: 'RELEASE', buyer }
  const good = buildExpectedFeeAwareOutputs(withBE, o, 10, network)

  it("the honest PSBT passes, and the derived rate is reported", () => {
    expect(checkFeeAwarePsbt(psbtWith(withBE, good), withBE, o, network, CAP)).toMatchObject({ ok: true })
  })
  it("a fee output redirected to another address is refused", () => {
    expect(checkFeeAwarePsbt(psbtWith(withBE, [good[0], { ...good[1], address: p2wpkh('attacker') }]), withBE, o, network, CAP).ok).toBe(false)
  })
  it.each([1n, -1n])("a collected amount off by %s sat is refused", (d) => {
    expect(checkFeeAwarePsbt(psbtWith(withBE, [{ ...good[0], value: good[0].value - d }, { ...good[1], value: good[1].value + d }]), withBE, o, network, CAP).ok).toBe(false)
  })
  it("an extra output is refused", () => {
    expect(checkFeeAwarePsbt(psbtWith(withBE, [...good, { address: p2wpkh('extra'), value: 1000n }]), withBE, o, network, CAP).ok).toBe(false)
  })
  it("a funding input that is not T + Fmax is refused", () => {
    expect(checkFeeAwarePsbt(psbtWith(withBE, good, BigInt(T)), withBE, o, network, CAP).ok).toBe(false)
  })
  it("with break-even, a miner fee implying more than the committed cap is refused", () => {
    const high = buildExpectedFeeAwareOutputs({ ...withBE, breakEven: null }, o, 26, network)
    expect(checkFeeAwarePsbt(psbtWith(withBE, high), withBE, o, network, CAP).ok).toBe(false)
  })
  it("without break-even, the client's own cap still refuses an inflated miner fee", () => {
    const inflated = buildExpectedFeeAwareOutputs(noBE, o, 300, network)
    expect(checkFeeAwarePsbt(psbtWith(noBE, inflated), noBE, o, network, CAP)).toMatchObject({ ok: false })
    expect(checkFeeAwarePsbt(psbtWith(noBE, buildExpectedFeeAwareOutputs(noBE, o, 150, network)), noBE, o, network, CAP)).toMatchObject({ ok: true })
  })
  it.each([[Infinity], [NaN], [0], [-1]])("a client cap of %s is refused instead of switching the bound off", (cap) => {
    const honest = psbtWith(noBE, buildExpectedFeeAwareOutputs(noBE, o, 10, network))
    expect(checkFeeAwarePsbt(honest, noBE, o, network, { maxFeeRateSatPerVb: cap })).toMatchObject({ ok: false, reason: 'a finite, positive client fee-rate cap is required' })
  })
})
