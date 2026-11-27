/**
 * @satsails/p2p-trading-sdk — recomputes the outputs a fee-aware MULTISIG settlement must have, from the COMMITTED fee
 * policy and the fee rate the round declares, so a party can refuse to sign a PSBT whose fee output is redirected or
 * mis-sized (G4, CTO 38). Mirrors the node's construction (`multisig.provider.ts`); a parity test against the provider
 * proves the two agree. The declared fee rate is untrusted: it must be at most the committed cap (with break-even) and
 * must reproduce the PSBT's own miner fee exactly, otherwise the PSBT is refused.
 */
import * as bitcoin from 'bitcoinjs-lib'

export interface BreakEvenParams { fMaxSatPerVb: number; vBytes: number; dMaxSats: number; collectionDustSats: number }

export interface FeeAwareEscrow {
  /** T, the trade notional, in sats. */
  lockedSats: bigint
  /** The committed protocol fee rate, a decimal string with at most 8 places. */
  protocolFeeRate: string
  /** The pre-funding waiver frozen on the escrow. */
  waivedPreFunding: boolean
  /** The committed collection destination; null when there is no reserve. */
  collectionAddress: string | null
  breakEven: BreakEvenParams | null
}

export type Outcome =
  | { kind: 'RELEASE'; buyer: string }
  | { kind: 'REFUND'; seller: string }
  | { kind: 'SPLIT'; buyer: string; seller: string; buyerBps: number }

export interface ExpectedOutput { address: string; value: bigint }

/** The construction's own weight reference (execution-cost-policy.ts). */
export const estimatedVBytes = (outputs: number): number => 11 + 110 + 43 * outputs
const minerFee = (rate: number, outputs: number): bigint => BigInt(Math.ceil(rate * estimatedVBytes(outputs)))

function rateUnits(rate: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(rate)
  if (!m) throw new Error(`invalid fee rate ${rate}`)
  return BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? '').padEnd(8, '0') || '0')
}
/** floor(basis * rate), in sats: the node's computeProtocolFee floors to 8 decimal places of BTC. */
const feeSats = (basisSats: bigint, rate: string): bigint => (basisSats * rateUnits(rate)) / 100_000_000n

function isWitnessProgram(s: Uint8Array): boolean {
  if (s.length < 4 || s.length > 42) return false
  const v = s[0]
  return (v === 0x00 || (v >= 0x51 && v <= 0x60)) && s[1] >= 2 && s[1] <= 40 && s.length === 2 + s[1]
}
/** bitcoin-dust-policy.ts dustThresholdSats(), the same relay-dust formula. */
export function dustSats(address: string, network: bitcoin.Network): bigint {
  const s = bitcoin.address.toOutputScript(address, network)
  const overhead = isWitnessProgram(s) ? 32 + 4 + 1 + Math.floor(107 / 4) + 4 : 32 + 4 + 1 + 107 + 4
  return (3000n * BigInt(8 + 1 + s.length + overhead) + 999n) / 1000n
}

function maxFeeSats(e: FeeAwareEscrow): bigint {
  return e.waivedPreFunding ? 0n : feeSats(e.lockedSats, e.protocolFeeRate)
}

/**
 * The exact outputs, in order, for the given outcome and fee rate. Throws when the rate exceeds the committed cap or the
 * construction would be invalid; the caller refuses to sign in that case.
 */
export function buildExpectedFeeAwareOutputs(e: FeeAwareEscrow, o: Outcome, feeRate: number, network: bitcoin.Network): ExpectedOutput[] {
  if (!(feeRate > 0)) throw new Error('fee rate must be positive')
  if (e.breakEven && feeRate > e.breakEven.fMaxSatPerVb) throw new Error(`fee rate ${feeRate} above the committed cap ${e.breakEven.fMaxSatPerVb}`)
  const fmax = maxFeeSats(e)
  const input = e.lockedSats + fmax
  const be = e.breakEven

  if (o.kind === 'REFUND') return [{ address: o.seller, value: input - minerFee(feeRate, 1) }]

  if (o.kind === 'RELEASE') {
    if (fmax === 0n) return [{ address: o.buyer, value: input - minerFee(feeRate, 1) }]
    const collected = be ? fmax - (minerFee(feeRate, 2) - minerFee(feeRate, 1)) : fmax
    const spendable = input - minerFee(feeRate, 2)
    return [{ address: o.buyer, value: spendable - collected }, { address: e.collectionAddress!, value: collected }]
  }

  // SPLIT
  const sellerBasis = (e.lockedSats * BigInt(10000 - o.buyerBps)) / 10000n
  let collect = false
  let collected = 0n
  let addBack = 0n
  if (fmax > 0n) {
    const gross = feeSats(sellerBasis, e.protocolFeeRate)
    if (be) {
      const cost = minerFee(feeRate, 3) - minerFee(feeRate, 2)
      const net = gross - cost
      collect = gross > 0n && net >= BigInt(be.collectionDustSats) && net >= dustSats(e.collectionAddress!, network)
      if (collect) { collected = net; addBack = cost }
    } else {
      collect = gross > 0n && gross >= dustSats(e.collectionAddress!, network)
      if (collect) collected = gross
    }
  }
  const outputs = fmax > 0n && collect ? 3 : 2
  const spendable = input - minerFee(feeRate, outputs)
  const pool = fmax > 0n ? spendable - fmax + addBack : spendable
  const buyerValue = (pool * BigInt(o.buyerBps)) / 10000n
  const sellerBase = pool - buyerValue
  if (fmax === 0n) return [{ address: o.buyer, value: buyerValue }, { address: o.seller, value: sellerBase }]
  const sellerFinal = sellerBase + fmax - collected - addBack
  const out: ExpectedOutput[] = [{ address: o.buyer, value: buyerValue }, { address: o.seller, value: sellerFinal }]
  if (collect) out.push({ address: e.collectionAddress!, value: collected })
  return out
}

/**
 * Refuses unless the PSBT pays exactly the expected outputs (same count, order, addresses and amounts) and its miner fee
 * equals the one the declared rate implies. Returns the reason on refusal.
 */
export function checkFeeAwarePsbt(psbtBase64: string, e: FeeAwareEscrow, o: Outcome, feeRate: number, network: bitcoin.Network): { ok: true } | { ok: false; reason: string } {
  let expected: ExpectedOutput[]
  try { expected = buildExpectedFeeAwareOutputs(e, o, feeRate, network) } catch (err) { return { ok: false, reason: (err as Error).message } }
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network })
  const outs = psbt.txOutputs.map((x) => ({ address: bitcoin.address.fromOutputScript(x.script, network), value: BigInt(x.value) }))
  if (outs.length !== expected.length) return { ok: false, reason: `expected ${expected.length} outputs, PSBT has ${outs.length}` }
  for (let i = 0; i < outs.length; i++) {
    if (outs[i].address !== expected[i].address) return { ok: false, reason: `output ${i} pays ${outs[i].address}, expected ${expected[i].address}` }
    if (outs[i].value !== expected[i].value) return { ok: false, reason: `output ${i} carries ${outs[i].value} sats, expected ${expected[i].value}` }
  }
  const input = BigInt(psbt.data.inputs[0]?.witnessUtxo?.value ?? -1)
  if (input !== e.lockedSats + maxFeeSats(e)) return { ok: false, reason: 'the funding input is not the escrow amount' }
  return { ok: true }
}
