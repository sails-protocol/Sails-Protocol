/**
 * @satsails/p2p-trading-sdk — recomputes the outputs a fee-aware MULTISIG settlement must have, so a party can refuse to
 * sign a PSBT whose fee output is redirected or mis-sized, or whose miner fee is inflated (G4, CTO 38).
 *
 * Every input is data the client has verified itself, never the node's word:
 * - the rate, the destination and the break-even come from the SIGNED, COMMITTED policy (`feeAwareEscrowFromPolicy`);
 * - T comes from the commitment the client signed;
 * - the pre-funding waiver is recomputed here with the node's snapshot rule, never taken from a node flag;
 * - the fee rate is derived from the PSBT itself and must not exceed the client's own cap (and the committed cap with
 *   break-even).
 * Mirrors multisig.provider.ts; a parity test against the provider proves the two agree.
 */
import * as bitcoin from 'bitcoinjs-lib'
import type { FeePolicyV2 } from './fee-policy'

export interface BreakEvenParams { fMaxSatPerVb: number; vBytes: number; dMaxSats: number; collectionDustSats: number }

export interface FeeAwareEscrow {
  lockedSats: bigint
  protocolFeeRate: string
  waivedPreFunding: boolean
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

function breakEvenOf(rule: unknown): BreakEvenParams | null {
  const be = rule && typeof rule === 'object' ? (rule as Record<string, unknown>).breakEven : undefined
  if (!be || typeof be !== 'object') return null
  const o = be as Record<string, number>
  return { fMaxSatPerVb: o.fMaxSatPerVb, vBytes: o.vBytes, dMaxSats: o.dMaxSats, collectionDustSats: o.collectionDustSats }
}

/**
 * The escrow's fee terms from data the client verified: the signed committed policy and T from the commitment. The
 * pre-funding waiver follows the node's snapshot rule (escrow-fee-snapshot.service.ts) with the policy's destination.
 */
export function feeAwareEscrowFromPolicy(policy: FeePolicyV2, lockedSats: bigint, network: bitcoin.Network): FeeAwareEscrow {
  const breakEven = breakEvenOf(policy.smallTradeRule)
  const destination = policy.destination.value
  const fmax = feeSats(lockedSats, policy.protocolFeeRate)
  let reserve = false
  if (fmax > 0n) {
    const dust = dustSats(destination, network)
    const collectible = fmax >= dust
    const breakEvenOk = !breakEven || (fmax >= BigInt(breakEven.dMaxSats + breakEven.vBytes * breakEven.fMaxSatPerVb) && dust <= BigInt(breakEven.collectionDustSats))
    reserve = collectible && breakEvenOk
  }
  // As in the node: a positive rate whose reserve is not collectible is waived before funding; a zero rate is not.
  return { lockedSats, protocolFeeRate: policy.protocolFeeRate, waivedPreFunding: rateUnits(policy.protocolFeeRate) > 0n && !reserve, collectionAddress: reserve ? destination : null, breakEven }
}

function maxFeeSats(e: FeeAwareEscrow): bigint {
  return e.waivedPreFunding ? 0n : feeSats(e.lockedSats, e.protocolFeeRate)
}

/** The exact outputs, in order, for the given outcome and fee rate. Throws when the construction would be invalid. */
export function buildExpectedFeeAwareOutputs(e: FeeAwareEscrow, o: Outcome, feeRate: number, network: bitcoin.Network): ExpectedOutput[] {
  if (!(feeRate > 0)) throw new Error('fee rate must be positive')
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
 * Every fee rate that reproduces a miner fee M for an n-output spend lies in ((M - 1) / est(n), M / est(n)]. Within that
 * interval the other output counts' fees change only at j / est(k); one probe per sub-interval covers every outcome.
 */
function candidateRates(miner: bigint, outputs: number): number[] {
  const m = Number(miner)
  const lo = (m - 1) / estimatedVBytes(outputs)
  const hi = m / estimatedVBytes(outputs)
  const points = new Set<number>([hi])
  for (const k of [1, 2, 3]) {
    const est = estimatedVBytes(k)
    for (let j = Math.floor(lo * est); j <= Math.ceil(hi * est); j++) {
      const x = j / est
      if (x > lo && x < hi) points.add(x)
    }
  }
  const sorted = [lo, ...[...points].sort((a, b) => a - b)]
  const probes: number[] = [hi]
  for (let i = 1; i < sorted.length; i++) probes.push((sorted[i - 1] + sorted[i]) / 2, sorted[i])
  return probes.filter((f) => f > 0 && minerFee(f, outputs) === miner)
}

/**
 * Refuses unless: the funding input is T + Fmax; the miner fee implies a fee rate within the client's cap (and the
 * committed cap with break-even); and, for some such rate, the PSBT pays exactly the expected outputs (count, order,
 * addresses and amounts). The node never tells the client the fee rate.
 */
export function checkFeeAwarePsbt(
  psbtBase64: string, e: FeeAwareEscrow, o: Outcome, network: bitcoin.Network, opts: { maxFeeRateSatPerVb: number },
): { ok: true; feeRate: number } | { ok: false; reason: string } {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network })
  if (psbt.data.inputs.length !== 1) return { ok: false, reason: 'expected exactly one funding input' }
  const input = BigInt(psbt.data.inputs[0]?.witnessUtxo?.value ?? -1)
  if (input !== e.lockedSats + maxFeeSats(e)) return { ok: false, reason: 'the funding input is not the escrow amount' }
  const outs = psbt.txOutputs.map((x) => ({ address: bitcoin.address.fromOutputScript(x.script, network), value: BigInt(x.value) }))
  const miner = input - outs.reduce((s, x) => s + x.value, 0n)
  if (miner <= 0n) return { ok: false, reason: 'no miner fee' }
  // A non-finite or non-positive client cap would switch the miner-fee bound off: refuse instead.
  if (!Number.isFinite(opts.maxFeeRateSatPerVb) || opts.maxFeeRateSatPerVb <= 0) return { ok: false, reason: 'a finite, positive client fee-rate cap is required' }
  const cap = Math.min(opts.maxFeeRateSatPerVb, e.breakEven ? e.breakEven.fMaxSatPerVb : Infinity)
  const rates = candidateRates(miner, outs.length).filter((f) => f <= cap)
  if (rates.length === 0) return { ok: false, reason: `miner fee ${miner} implies a fee rate above the cap ${cap} sat/vB` }
  for (const f of rates) {
    let expected: ExpectedOutput[]
    try { expected = buildExpectedFeeAwareOutputs(e, o, f, network) } catch { continue }
    if (expected.length === outs.length && expected.every((x, i) => x.address === outs[i].address && x.value === outs[i].value)) return { ok: true, feeRate: f }
  }
  return { ok: false, reason: 'the outputs do not match the committed fee terms' }
}
