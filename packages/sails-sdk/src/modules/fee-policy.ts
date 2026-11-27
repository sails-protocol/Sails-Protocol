/**
 * @satsails/p2p-trading-sdk — verifies a signed V2 fee policy before the party signs a commitment that references it
 * (G3 + G4, CTO 38). Same digest and rules as the node (`src/modules/open-settlement/global-fee-policy.ts`), proven by
 * a parity test; the client trusts only the authority keys and network it is configured with, never the node's word.
 */
import * as bitcoin from 'bitcoinjs-lib'
import { verifyDigestSignature, feePolicyDigestV2, type FeePolicyV1 } from './trade-commitment'

export { feePolicyDigestV2, FEE_POLICY_V2_DOMAIN_TAG } from './trade-commitment'

/** The protocol fee ceiling the client enforces (the same value as the node's PROTOCOL_MAX_FEE_RATE). */
export const PROTOCOL_MAX_FEE_RATE = '0.005'

export interface FeePolicyV2 extends FeePolicyV1 {
  version: 2
  rail: string
  network: string
  destination: { kind: 'address'; value: string }
  validFrom: string
  validUntil: string | null
}

export interface SignedFeePolicy {
  policy: FeePolicyV2
  signatures: Record<string, string>
}

export interface VerificationContext {
  authority: { keys: string[]; threshold: number }
  network: { name: string; bitcoin: bitcoin.Network }
  maxRate?: string
  now: Date
  purpose: 'new-use' | 'existing'
}

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const RATE = /^(0|[1-9]\d*)(\.\d{0,7}[1-9])?$/

/** A canonical decimal rate in 1e-8 units, for exact comparison. */
export function rateUnits(rate: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(rate)
  if (!m) throw new Error(`invalid fee rate ${rate}`)
  return BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? '').padEnd(8, '0') || '0')
}

export type FeePolicyVerdict = { ok: true; digest: string } | { ok: false; reason: string }

/** Shape, network, destination, ceiling, validity window (new use only) and >= threshold distinct authority signatures. */
export function verifySignedFeePolicy(doc: SignedFeePolicy, ctx: VerificationContext): FeePolicyVerdict {
  const p = doc?.policy
  if (!p || p.version !== 2) return { ok: false, reason: 'not a V2 fee policy' }
  if (p.destination?.kind !== 'address' || typeof p.destination.value !== 'string' || p.destination.value.length === 0) return { ok: false, reason: 'missing fee destination' }
  if (typeof p.rail !== 'string' || !p.rail) return { ok: false, reason: 'missing rail' }
  if (p.network !== ctx.network.name) return { ok: false, reason: `policy is for network ${p.network}, not ${ctx.network.name}` }
  try { bitcoin.address.toOutputScript(p.destination.value, ctx.network.bitcoin) } catch { return { ok: false, reason: 'fee destination is not an address of this network' } }
  const max = ctx.maxRate ?? PROTOCOL_MAX_FEE_RATE
  if (!RATE.test(p.protocolFeeRate) || rateUnits(p.protocolFeeRate) > rateUnits(max)) return { ok: false, reason: `fee rate above the ceiling ${max}` }
  if (!TS.test(p.validFrom) || (p.validUntil !== null && !TS.test(p.validUntil)) || Number.isNaN(Date.parse(p.validFrom)) || (p.validUntil !== null && Date.parse(p.validUntil) <= Date.parse(p.validFrom))) return { ok: false, reason: 'invalid validity window' }
  if (ctx.purpose === 'new-use' && (ctx.now < new Date(p.validFrom) || (p.validUntil !== null && ctx.now >= new Date(p.validUntil)))) return { ok: false, reason: 'outside its validity window' }
  const { keys, threshold } = ctx.authority
  if (new Set(keys).size !== keys.length || !keys.every((k) => /^[0-9a-f]{64}$/.test(k))) return { ok: false, reason: 'invalid authority keys' }
  if (!Number.isSafeInteger(threshold) || threshold < 2 || threshold > keys.length) return { ok: false, reason: 'invalid authority threshold' }
  const digest = feePolicyDigestV2(p)
  const valid = new Set<string>()
  for (const [pk, sig] of Object.entries(doc.signatures ?? {})) {
    if (keys.includes(pk) && verifyDigestSignature(digest, sig, pk)) valid.add(pk)
  }
  if (valid.size < threshold) return { ok: false, reason: `needs ${threshold} authority signatures, has ${valid.size}` }
  return { ok: true, digest }
}
