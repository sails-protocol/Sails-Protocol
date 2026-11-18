/**
 * Sails OpenSettlement — Bitcoin dust/output policy (Missão 10, Fase 4)
 *
 * Real gap found auditing multisig.provider.ts's buildUnsignedSpend():
 * it guarded `spendableValue <= 0n` (input can't cover the fee) but had
 * NO check that an individual output actually clears Bitcoin's real
 * relay-policy dust threshold — a sub-dust output was fully buildable,
 * signable by both parties, and would only fail (if it failed at all)
 * at broadcast(), after both signatures were already collected.
 *
 * Deliberately NOT a single magic constant (`DUST = 546`) applied
 * universally — that number is specifically the LEGACY P2PKH threshold;
 * a P2WPKH output's real threshold is 294, P2WSH/P2TR's is 330, under
 * Bitcoin Core's own default relay policy. `dustThresholdSats()` below
 * computes the threshold from the ACTUAL output script's serialized
 * size, mirroring Bitcoin Core's real `GetDustThreshold()`
 * (src/policy/policy.cpp) formula exactly — this generalizes correctly
 * to every standard script type Sails' payout-address surface can
 * currently produce (P2WPKH, P2WSH, P2TR, legacy P2PKH/P2SH), and to any
 * future witness version, without a per-type lookup table.
 *
 * Consensus vs. relay policy, precisely: Bitcoin's CONSENSUS rules do
 * not reject dust outputs at all — a block containing one is still
 * valid. Dust is purely a RELAY/mempool POLICY decision (every default-
 * configured node refuses to relay or mine a transaction with a
 * sub-dust output, governed by `-dustrelayfee`, default 3000 sat/kvB =
 * 3 sat/vB) — a real, separate node-operator-configurable knob, not a
 * protocol rule. Sails targets the REAL default relay policy every
 * standard node runs, since that's what determines whether a
 * broadcast() call in multisig.provider.ts actually succeeds.
 *
 * This dust-relay fee (3 sat/vB, a static relay-policy parameter) is
 * deliberately NOT the same value as fetchFeeRateSatsPerVByte()'s real
 * mempool.space-estimated rate (this specific transaction's own miner
 * fee) — conflating the two would be wrong: a transaction can legitimately
 * pay a much higher miner fee rate than the dust-relay floor, and dust
 * eligibility never depends on how much fee THIS transaction happens to
 * pay. Also deliberately unrelated to any Sails Protocol Fee (RFC-021 /
 * PROTOCOL_ECONOMY.md) — that is an entirely separate, currently-inert
 * (fee collection not activated) economic mechanism this mission
 * does not touch. Three genuinely independent concepts: miner fee, dust
 * threshold, protocol fee.
 */
import * as bitcoin from 'bitcoinjs-lib'
import { EscrowError } from '../../common/errors'

// Bitcoin Core's real default (`DUST_RELAY_TX_FEE` in src/policy/policy.h)
// — 3000 sat/kvB, i.e. 3 sat/vB. A relay-policy constant, not derived
// from any live fee-estimate call.
const DUST_RELAY_FEE_SATS_PER_KVB = 3000n

export class UnsupportedOutputScriptError extends EscrowError {}

// BIP141: a witness program is OP_0..OP_16 (0x00, or 0x51-0x60) followed
// by a single push of 2-40 bytes, and nothing else.
function isWitnessProgram(script: Buffer): boolean {
  if (script.length < 4 || script.length > 42) return false
  const version = script[0]
  const isVersionOpcode = version === 0x00 || (version >= 0x51 && version <= 0x60)
  if (!isVersionOpcode) return false
  const pushLen = script[1]
  return pushLen >= 2 && pushLen <= 40 && script.length === 2 + pushLen
}

export type OutputScriptKind = 'P2WPKH' | 'P2WSH' | 'P2TR' | 'P2WITNESS_OTHER' | 'P2PKH' | 'P2SH' | 'OTHER'

// For error messages / test assertions only — dustThresholdSats() below
// never branches on this, it works purely from the script's real byte
// length, so a kind this doesn't specifically name (a future witness
// version, for instance) still gets a correct threshold.
export function classifyOutputScript(script: Buffer): OutputScriptKind {
  if (isWitnessProgram(script)) {
    const version = script[0]
    const pushLen = script[1]
    if (version === 0x00 && pushLen === 20) return 'P2WPKH'
    if (version === 0x00 && pushLen === 32) return 'P2WSH'
    if (version === 0x51 && pushLen === 32) return 'P2TR'
    return 'P2WITNESS_OTHER'
  }
  if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac) return 'P2PKH'
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) return 'P2SH'
  return 'OTHER'
}

// Mirrors Bitcoin Core's GetDustThreshold(): the estimated cost of an
// input spending this specific output, at the dust-relay fee rate.
// Witness outputs get bitcoinjs-lib's/Bitcoin Core's own documented
// witness-discount treatment (a P2WPKH/P2WSH/P2TR spend's signature data
// counts at 1/4 weight); legacy P2PKH/P2SH outputs use the full,
// undiscounted spending-input estimate.
export function dustThresholdSats(script: Buffer): bigint {
  const scriptSize = script.length
  if (scriptSize > 252) {
    // No standard Bitcoin output script is this large — a >1-byte
    // compactsize prefix would be needed, which none of Sails' real
    // payout-address paths can ever produce. Rejected explicitly rather
    // than silently mis-sizing the varint.
    throw new UnsupportedOutputScriptError(`Output script is ${scriptSize} bytes — larger than any standard output script this dust policy recognizes`)
  }
  const txoutSize = 8 /* value, 8-byte LE */ + 1 /* compactsize varint prefix, 1 byte for scriptSize <= 252 */ + scriptSize
  const witnessDiscountedInputOverhead = 32 + 4 + 1 + Math.floor(107 / 4) + 4 // outpoint + sequence + scriptSig-len byte + discounted witness + locktime-adjacent overhead
  const legacyInputOverhead = 32 + 4 + 1 + 107 + 4
  const inputOverhead = isWitnessProgram(script) ? witnessDiscountedInputOverhead : legacyInputOverhead
  const nSize = BigInt(txoutSize + inputOverhead)
  // CFeeRate::GetFee(): ceil(nFeePerK * nSize / 1000).
  return (DUST_RELAY_FEE_SATS_PER_KVB * nSize + 999n) / 1000n
}

export interface ValidatedOutput {
  address: string
  value: bigint
  script: Buffer
  kind: OutputScriptKind
  dustThreshold: bigint
}

// The one call site every release/refund/split output must pass through
// before a PSBT is ever returned to a caller — decodes the address for
// the real network (surfacing an invalid/wrong-network address with a
// clear error, reusing bitcoinjs-lib's own real address parsing rather
// than reinventing it), computes the real dust threshold for that exact
// script, and throws before any signature is ever requested if the
// output does not clear it. Bitcoin Core's own IsDust() is a strict
// less-than check — an output exactly AT the threshold is standard,
// non-dust, and allowed; this mirrors that exactly, not an arbitrary
// choice.
export function validateOutput(address: string, value: bigint, network: bitcoin.Network): ValidatedOutput {
  let script: Buffer
  try {
    script = Buffer.from(bitcoin.address.toOutputScript(address, network))
  } catch (err) {
    throw new EscrowError(`MULTISIG provider: destination address '${address}' is invalid or does not match the configured network: ${err instanceof Error ? err.message : String(err)}`)
  }
  const kind = classifyOutputScript(script)
  const dustThreshold = dustThresholdSats(script)
  if (value < dustThreshold) {
    throw new EscrowError(
      `MULTISIG provider: output of ${value} sats to ${address} (${kind}) is below the ${dustThreshold}-sat dust threshold for this script type — refusing to build a transaction the network would reject at broadcast. This is a relay-policy check (3 sat/vB dust-relay fee), separate from the miner fee this transaction pays.`
    )
  }
  return { address, value, script, kind, dustThreshold }
}
