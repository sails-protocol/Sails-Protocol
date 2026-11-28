/**
 * Fee break-even (CTO 38 §14): strict parameter validation, the creation rule, and a property test over the transaction
 * actually built (signed and finalized), covering a market fee rate above the committed cap and every allowed payout type.
 * Fixture parameters: fMax 25 sat/vB, V 43 vB, Dmax 330, Dc 330, rate 0.40%.
 */
export {}

const ecc = require('tiny-secp256k1')
const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const crypto = require('crypto')
bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const network = bitcoin.networks.testnet

const { parseBreakEven, reserveRequired, effectiveFeeRate, assertPayoutTypeAllowed, PAYOUT_TYPES } = require('../src/modules/open-settlement/fee-break-even')
const { dustThresholdSats } = require('../src/modules/open-settlement/bitcoin-dust-policy')
const { estimatedVBytesForOutputCount } = require('../src/modules/open-settlement/execution-cost-policy')

const BE = { fMaxSatPerVb: 25, vBytes: 43, dMaxSats: 330, collectionDustSats: 330, allowedPayoutTypes: ['P2WPKH', 'P2WSH', 'P2TR'] }
const RATE = 0.004

describe('smallTradeRule.breakEven: strict validation', () => {
  it('absent => null (earlier behavior); the Day-0 parameters parse; fixtureOnlyMinimum alongside it is untouched', () => {
    expect(parseBreakEven({})).toBeNull()
    expect(parseBreakEven({ fixtureOnlyMinimum: '0.001' })).toBeNull()
    expect(parseBreakEven({ breakEven: BE })).toEqual(BE)
    const both = { fixtureOnlyMinimum: '0.001', breakEven: BE }
    expect(parseBreakEven(both)).toEqual(BE)
    expect(both.fixtureOnlyMinimum).toBe('0.001')
  })

  it.each([
    ['unknown key', { ...BE, extra: 1 }, /unknown keys extra/],
    ['fMax 0', { ...BE, fMaxSatPerVb: 0 }, /fMaxSatPerVb must be a positive integer/],
    ['fractional V', { ...BE, vBytes: 43.5 }, /vBytes must be a positive integer/],
    ['string Dmax', { ...BE, dMaxSats: '330' }, /dMaxSats must be a positive integer/],
    ['negative Dc', { ...BE, collectionDustSats: -1 }, /collectionDustSats must be a positive integer/],
    ['P2PKH allowed', { ...BE, allowedPayoutTypes: ['P2WPKH', 'P2PKH'] }, /allowedPayoutTypes/],
    ['empty types', { ...BE, allowedPayoutTypes: [] }, /allowedPayoutTypes/],
    ['duplicate types', { ...BE, allowedPayoutTypes: ['P2TR', 'P2TR'] }, /allowedPayoutTypes/],
    ['Dmax below P2WSH dust', { ...BE, dMaxSats: 329 }, /dMaxSats is below the dust/],
    ['V below the output size', { ...BE, vBytes: 42 }, /vBytes is below the size/],
    ['V below the construction weight even for P2WPKH only', { ...BE, vBytes: 31, dMaxSats: 294, collectionDustSats: 294, allowedPayoutTypes: ['P2WPKH'] }, /vBytes is below the size/],
    ['Dc above Dmax', { ...BE, collectionDustSats: 331 }, /collectionDustSats must not exceed dMaxSats/],
    ['not an object', [1], /must be an object/],
  ])('refuses %s', (_name, breakEven, message) => {
    expect(() => parseBreakEven({ breakEven })).toThrow(message)
  })

  it('P2WPKH-only: Dmax 294 is enough when V covers the construction weight', () => {
    expect(parseBreakEven({ breakEven: { ...BE, dMaxSats: 294, collectionDustSats: 294, allowedPayoutTypes: ['P2WPKH'] } })).not.toBeNull()
  })

  it('creation rule: a reserve only from Fmax = Dmax + V * fMax (1405 sats); f_eff never exceeds the cap', () => {
    expect(reserveRequired(BE, 1404)).toBe(false)
    expect(reserveRequired(BE, 1405)).toBe(true)
    expect(effectiveFeeRate(BE, 80)).toBe(25)
    expect(effectiveFeeRate(BE, 12.5)).toBe(12.5)
    expect(effectiveFeeRate(null, 80)).toBe(80)
  })
})

it("settlement reads the break-even of the escrow's own (committed) policy by id, never a live lookup", async () => {
  const { committedBreakEven } = require('../src/modules/open-settlement/fee-break-even')
  const findUnique = jest.fn(async () => ({ smallTradeRule: { breakEven: BE } }))
  expect(await committedBreakEven({ feePolicyVersion: { findUnique } }, 'committed-1')).toEqual(BE)
  expect(findUnique).toHaveBeenCalledWith({ where: { id: 'committed-1' }, select: { smallTradeRule: true } })
  expect(await committedBreakEven({ feePolicyVersion: { findUnique } }, null)).toBeNull()
  expect(findUnique).toHaveBeenCalledTimes(1)
})

// ── addresses of each allowed type ──
function key(seed: string) {
  return ECPair.fromPrivateKey(crypto.createHash('sha256').update(seed).digest(), { network })
}
function addressOf(type: string, seed: string): string {
  const pub = Buffer.from(key(seed).publicKey)
  if (type === 'P2WPKH') return bitcoin.payments.p2wpkh({ pubkey: pub, network }).address
  if (type === 'P2WSH') return bitcoin.payments.p2wsh({ hash: crypto.createHash('sha256').update(seed).digest(), network }).address
  if (type === 'P2TR') return bitcoin.payments.p2tr({ internalPubkey: pub.subarray(1, 33), network }).address
  return bitcoin.payments.p2pkh({ pubkey: pub, network }).address
}
const dustOf = (address: string) => Number(dustThresholdSats(Buffer.from(bitcoin.address.toOutputScript(address, network))))

it('escrow creation: a payout address outside the allowed types is refused (P2PKH), allowed types pass', () => {
  for (const t of Object.keys(PAYOUT_TYPES)) expect(() => assertPayoutTypeAllowed(BE, addressOf(t, 'ok-' + t), network)).not.toThrow()
  expect(() => assertPayoutTypeAllowed(BE, addressOf('P2PKH', 'legacy'), network)).toThrow(/PAYOUT_TYPE_NOT_ALLOWED|outside the committed/)
})

// ── property test over the built transaction ──
const ORIGINAL_ENV = process.env
const buyerKey = key('be-buyer')
const sellerKey = key('be-seller')
function loadProvider(collectionAddress: string) {
  jest.resetModules()
  process.env = { ...ORIGINAL_ENV, MOCK_ESCROW: 'false', MULTISIG_SEED: 'seed-be', TRUSTED_ARBITRATORS: 'arb-1', SAILS_PROTOCOL_FEE_COLLECTION_ADDRESS: collectionAddress }
  return require('../src/modules/open-settlement/multisig.provider')
}
afterAll(() => { process.env = ORIGINAL_ENV })
const fetchMock = jest.fn()
beforeEach(() => { fetchMock.mockReset(); (global as any).fetch = fetchMock })

const ceilFee = (rate: number, outputs: number) => Math.ceil(rate * estimatedVBytesForOutputCount(outputs))

/** Signs with buyer and seller (2-of-3), finalizes, and returns the real transaction. */
function finalize(psbtBase64: string) {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network })
  psbt.signInput(0, buyerKey)
  psbt.signInput(0, sellerKey)
  psbt.finalizeAllInputs()
  return psbt.extractTransaction()
}

describe('break-even property over the transaction actually built', () => {
  const T_VALUES = [100_000, 351_250, 1_000_000, 25_000_000]
  const MARKET = [1, 2.5, 12, 25, 26, 80, 150]
  const TYPES = ['P2WPKH', 'P2WSH', 'P2TR']
  const BPS = [1000, 5000, 9000]

  for (const collectionType of TYPES) {
    it(`collection ${collectionType}: conservation, dust, rate <= fMax, seller refund and buyer neutrality in every branch`, async () => {
      const collection = addressOf(collectionType, 'collection-' + collectionType)
      const { multisigProvider } = loadProvider(collection)
      const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
      let checked = 0
      let maxRealRate = 0
      for (const T of T_VALUES) {
        const fmaxCandidate = Math.floor(T * RATE)
        const reserve = reserveRequired(BE, fmaxCandidate) && dustOf(collection) <= BE.collectionDustSats
        const fmax = reserve ? fmaxCandidate : 0
        for (const market of MARKET) {
          const f = Math.min(market, BE.fMaxSatPerVb)
          for (const [i, buyerType] of TYPES.entries()) {
            const sellerType = TYPES[(i + 1) % 3]
            const buyerAddress = addressOf(buyerType, `buyer-${T}-${market}-${buyerType}`)
            const sellerAddress = addressOf(sellerType, `seller-${T}-${market}-${sellerType}`)
            const escrow = {
              tradeId: `t-${T}-${market}`, buyerId: 'buyer-1', sellerId: 'seller-1', status: 'DISPUTED', triggeredBy: 'arb-1',
              buyerPubkey: Buffer.from(buyerKey.publicKey).toString('hex'), sellerPubkey: Buffer.from(sellerKey.publicKey).toString('hex'), arbiterPubkey,
              lockedAmount: (T / 1e8).toFixed(8), txLockId: crypto.createHash('sha256').update(`${T}-${market}-${buyerType}`).digest('hex'), txLockVout: 0,
              feePolicyVersionId: 'policy-be', snapshotProtocolFeeRate: String(RATE),
              snapshotFeeCollectionAddress: reserve ? collection : null, snapshotFeeCollectionWaivedPreFunding: !reserve,
              feeBreakEven: BE,
            }
            const R = T + fmax
            const fund = () => {
              fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ halfHourFee: market }) })
              fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ txid: escrow.txLockId, vout: 0, value: R, status: { confirmed: true } }] })
            }
            const check = (psbtBase64: string) => {
              const tx = finalize(psbtBase64)
              const outs = tx.outs.map((o: any) => ({ address: bitcoin.address.fromOutputScript(o.script, network), value: Number(o.value) }))
              const total = outs.reduce((s: number, o: any) => s + o.value, 0)
              const miner = R - total
              expect(total + miner).toBe(R) // (a) T + Fmax, exact
              for (const o of outs) expect(o.value).toBeGreaterThanOrEqual(dustOf(o.address)) // (b)
              // (c) the miner fee is f_eff on the construction's weight reference, never more than fMax on it, and that
              // reference covers the real signed size (so the rate on the real size is f_eff * estimate / vsize).
              expect(miner).toBe(ceilFee(f, outs.length))
              expect(miner).toBeLessThanOrEqual(ceilFee(BE.fMaxSatPerVb, outs.length))
              expect(tx.virtualSize()).toBeLessThanOrEqual(estimatedVBytesForOutputCount(outs.length))
              maxRealRate = Math.max(maxRealRate, miner / tx.virtualSize())
              checked++
              return outs
            }

            // RELEASE: buyer gets exactly the 1-output no-fee spend; the collection output pays its own vbytes.
            fund()
            const rel = await multisigProvider.buildUnsignedRelease(escrow, buyerAddress)
            const relOuts = check(rel.psbtBase64)
            expect(relOuts.find((o: any) => o.address === buyerAddress).value).toBe(T - ceilFee(f, 1)) // (e)
            if (fmax > 0) {
              const collected = fmax - (ceilFee(f, 2) - ceilFee(f, 1))
              expect(rel.feeCollection).toEqual({ feeSats: collected, waived: false })
              expect(relOuts.find((o: any) => o.address === collection).value).toBe(collected)
              expect(collected).toBeGreaterThanOrEqual(BE.dMaxSats)
            } else {
              expect(relOuts).toHaveLength(1)
            }

            // REFUND: no fee; the whole reserve stays in the seller's output. (d)
            fund()
            const ref = await multisigProvider.buildUnsignedRefund(escrow, sellerAddress)
            expect(check(ref.psbtBase64)).toEqual([{ address: sellerAddress, value: R - ceilFee(f, 1) }])

            // SPLIT: buyer as in the 2-output no-fee split; seller gets Fmax - F (collected) or the whole reserve (waived).
            for (const bps of BPS) {
              fund()
              const sp = await multisigProvider.buildUnsignedSplit(escrow, buyerAddress, sellerAddress, bps)
              const outs = check(sp.psbtBase64)
              const pool = T - ceilFee(f, 2)
              const buyerValue = Math.floor((pool * bps) / 10000)
              expect(outs.find((o: any) => o.address === buyerAddress).value).toBe(buyerValue) // (e)
              const seller = outs.find((o: any) => o.address === sellerAddress).value
              const gross = Math.floor(Math.floor((T * (10000 - bps)) / 10000) * RATE)
              const net = gross - (ceilFee(f, 3) - ceilFee(f, 2))
              if (fmax > 0 && !sp.feeCollection.waived) {
                expect(net).toBeGreaterThanOrEqual(Math.max(BE.collectionDustSats, dustOf(collection)))
                expect(sp.feeCollection.feeSats).toBe(net)
                expect(seller).toBe(pool - buyerValue + fmax - gross) // (d) the unused reserve Fmax - F
              } else {
                if (fmax > 0) expect(gross > 0 && net >= Math.max(BE.collectionDustSats, dustOf(collection))).toBe(false)
                expect(outs).toHaveLength(2)
                expect(seller).toBe(pool - buyerValue + fmax) // (d) the whole reserve
              }
            }
          }
        }
      }
      expect(checked).toBe(T_VALUES.length * MARKET.length * TYPES.length * (2 + BPS.length))
      console.log(`collection ${collectionType}: highest miner fee / real signed vsize = ${maxRealRate.toFixed(2)} sat/vB`)
    })
  }
})

it('the construction weight per output stays 43 vB: committed policies freeze V, so changing the estimator needs a rule migration', () => {
  for (const n of [1, 2, 3]) expect(estimatedVBytesForOutputCount(n + 1) - estimatedVBytesForOutputCount(n)).toBe(BE.vBytes)
})
