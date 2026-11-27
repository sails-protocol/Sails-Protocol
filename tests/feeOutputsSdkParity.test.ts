/**
 * G4: the SDK's buildExpectedFeeAwareOutputs reproduces, output by output, the PSBT the MULTISIG provider actually
 * builds, with and without break-even; and checkFeeAwarePsbt refuses a redirected or mis-sized fee output, an extra
 * output, and a declared rate above the committed cap.
 */
export {}

const ecc = require('tiny-secp256k1')
const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const crypto = require('crypto')
bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const network = bitcoin.networks.testnet

const { buildExpectedFeeAwareOutputs, checkFeeAwarePsbt, dustSats } = require('../packages/sails-sdk/src/modules/fee-outputs')
const { dustThresholdSats } = require('../src/modules/open-settlement/bitcoin-dust-policy')

const BE = { fMaxSatPerVb: 25, vBytes: 43, dMaxSats: 330, collectionDustSats: 330, allowedPayoutTypes: ['P2WPKH', 'P2WSH', 'P2TR'] }
const RATE = '0.004'
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

it('the SDK dust formula matches the node for every output type used here', () => {
  for (const a of [collection, buyer, seller]) {
    expect(dustSats(a, network)).toBe(dustThresholdSats(Buffer.from(bitcoin.address.toOutputScript(a, network))))
  }
})

describe('SDK expected outputs == the PSBT the provider builds', () => {
  for (const withBreakEven of [true, false]) {
    it(`${withBreakEven ? 'with' : 'without'} break-even: every outcome, size and fee rate`, async () => {
      const { multisigProvider } = loadProvider(collection)
      const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
      const bk = key('parity-buyer-key'); const sk = key('parity-seller-key')
      let checked = 0
      for (const T of [100_000, 351_250, 2_000_000]) {
        const fmaxCandidate = Math.floor(T * Number(RATE))
        const reserve = withBreakEven ? fmaxCandidate >= BE.dMaxSats + BE.vBytes * BE.fMaxSatPerVb : fmaxCandidate >= Number(dustSats(collection, network))
        for (const market of [1, 7.5, 25, 60]) {
          const f = withBreakEven ? Math.min(market, BE.fMaxSatPerVb) : market
          const txid = crypto.createHash('sha256').update(`${withBreakEven}-${T}-${market}`).digest('hex')
          const escrow = {
            tradeId: `p-${T}-${market}`, buyerId: 'buyer-1', sellerId: 'seller-1', status: 'DISPUTED', triggeredBy: 'arb-1',
            buyerPubkey: Buffer.from(bk.publicKey).toString('hex'), sellerPubkey: Buffer.from(sk.publicKey).toString('hex'), arbiterPubkey,
            lockedAmount: (T / 1e8).toFixed(8), txLockId: txid, txLockVout: 0,
            feePolicyVersionId: 'policy-parity', snapshotProtocolFeeRate: RATE,
            snapshotFeeCollectionAddress: reserve ? collection : null, snapshotFeeCollectionWaivedPreFunding: !reserve,
            feeBreakEven: withBreakEven ? BE : null,
          }
          const sdkEscrow = { lockedSats: BigInt(T), protocolFeeRate: RATE, waivedPreFunding: !reserve, collectionAddress: reserve ? collection : null, breakEven: withBreakEven ? BE : null }
          const R = T + (reserve ? fmaxCandidate : 0)
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
            expect(buildExpectedFeeAwareOutputs(sdkEscrow, o, f, network)).toEqual(actual)
            expect(checkFeeAwarePsbt(built.psbtBase64, sdkEscrow, o, f, network)).toEqual({ ok: true })
            checked++
          }
        }
      }
      expect(checked).toBe(3 * 4 * 5)
    })
  }
})

describe('checkFeeAwarePsbt refuses tampering', () => {
  const T = 2_000_000
  const fmax = Math.floor(T * Number(RATE))
  const e = { lockedSats: BigInt(T), protocolFeeRate: RATE, waivedPreFunding: false, collectionAddress: collection, breakEven: BE }
  const o = { kind: 'RELEASE', buyer }
  function psbtWith(outputs: Array<{ address: string; value: bigint }>) {
    const p = new bitcoin.Psbt({ network })
    const script = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key('in').publicKey), network }).output
    p.addInput({ hash: '00'.repeat(32), index: 0, witnessUtxo: { script, value: BigInt(T + fmax) } })
    for (const x of outputs) p.addOutput({ address: x.address, value: x.value })
    return p.toBase64()
  }
  const good = buildExpectedFeeAwareOutputs(e, o, 10, network)

  it('the honest PSBT passes', () => {
    expect(checkFeeAwarePsbt(psbtWith(good), e, o, 10, network)).toEqual({ ok: true })
  })
  it('a fee output redirected to another address is refused', () => {
    expect(checkFeeAwarePsbt(psbtWith([good[0], { ...good[1], address: p2wpkh('attacker') }]), e, o, 10, network).ok).toBe(false)
  })
  it.each([1n, -1n])('a collected amount off by %s sat is refused', (d) => {
    expect(checkFeeAwarePsbt(psbtWith([{ ...good[0], value: good[0].value - d }, { ...good[1], value: good[1].value + d }]), e, o, 10, network).ok).toBe(false)
  })
  it('an extra output is refused', () => {
    expect(checkFeeAwarePsbt(psbtWith([...good, { address: p2wpkh('extra'), value: 1000n }]), e, o, 10, network).ok).toBe(false)
  })
  it('a declared fee rate above the committed cap is refused', () => {
    expect(checkFeeAwarePsbt(psbtWith(good), e, o, 26, network)).toMatchObject({ ok: false })
  })
})
