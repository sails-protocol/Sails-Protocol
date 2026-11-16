/**
 * dispatch-translation-guard.ts — Sails Core Implementation Program
 * M8-R (Live Dispatch Retry), mission §18-19 (pre-dispatch translation
 * validation).
 *
 * BOUNDARY: this is Runtime/domain code, deliberately OUTSIDE
 * `packages/sails-core` — it decodes real Bitcoin PSBT bytes
 * (`bitcoinjs-lib`), which Pure Core must never do
 * (`docs/CORE_ARCHITECTURE.md` §8, M0's own mechanical boundary). It
 * exists to catch a buggy or malicious MULTISIG translator
 * (`multisig.provider.ts`'s `buildUnsignedRelease/Refund/Split()`,
 * UNCHANGED by this mission) BEFORE any signature is collected or
 * anything is broadcast — never a replacement for, and never reusing the
 * same code as, M6's POST-EXECUTION correspondence evaluator
 * (`destination-correspondence.ts`) or `sails-sdk`'s wallet-side
 * `verifySigningIntent()` (a REMOTE wallet's own independent input/
 * script verification against tampering in transit — a different threat
 * this server-side self-check does not need to duplicate, since the
 * server itself built the PSBT from its own trusted escrow record).
 *
 * EXECUTION COST SEMANTICS (Sails Core Implementation Program M8.6 —
 * closes what this file used to disclose as an open, single-beneficiary
 * skim gap): the authoritative Outcome commits to the ECONOMIC RULE
 * (ruling + bps + the escrow's full GROSS locked amount), never a
 * pre-computed net-of-miner-fee sat amount — the real miner fee is only
 * known once the provider actually builds the PSBT against live network
 * fee-rate data. This guard decodes the REAL spendable total from the
 * PSBT itself (input value minus the REAL fee implied by its own
 * outputs) and runs it through `execution-cost-policy.ts`'s
 * `deriveDistributableTotal()` — which BOUNDS the implied gap between
 * authorized gross and real delivered total against a deterministic fee
 * ceiling — before ever using that total as the basis for the
 * per-beneficiary ratio check. This is what makes the check
 * non-tautological even for a SINGLE-beneficiary ruling: "100% of
 * whatever is left" is no longer trivially satisfied by any real
 * output, because "whatever is left" must first be plausible as
 * legitimate rail execution cost (`execution-cost-policy.ts`'s own
 * header has the full model derivation and the K3 justification for why
 * this is translation, never redefinition). For a MULTI-beneficiary
 * (SPLIT) ruling, the pre-existing ratio check (shifting "70/30" to
 * "60/40") remains an independent, additional defense on top of the fee
 * bound.
 *
 * `declaredMinerFeeSats` (the provider's OWN `buildUnsignedRelease/
 * Refund/Split()` return value) is still checked for INTERNAL
 * CONSISTENCY against the real, PSBT-implied fee when supplied — a real,
 * distinct bug class (a translator whose reported fee disagrees with
 * what it actually built) the fee-ceiling check alone would not catch
 * on its own if the reported and actual fees merely happened to agree
 * with each other while both being wrong in the same way; kept as
 * defense in depth, not a substitute for the ceiling.
 *
 * SCOPE (disclosed, not silently assumed): this guard's "exactly the
 * authorized beneficiary set, no more, no less" output-count check
 * assumes the Sails Protocol Fee remains inactive (PROTOCOL_FEE_RATE has
 * never been raised above 0, `escrow-lifecycle.ts`'s own comment) — a
 * MULTISIG PSBT built today always has exactly one output per
 * beneficiary, never an additional fee-collection output. Mission M8-R
 * does not activate the fee (§39); if a future mission does, THIS guard
 * needs a corresponding, explicit extension — never a silent gap.
 */
import * as bitcoin from 'bitcoinjs-lib'
import { AppError } from '../../common/errors'
import { Outcome } from '@sails/core'
import { ArbitrationOutcomeContent, BeneficiaryDestination, allocateExactUnitsOverTotal } from './economic-outcome'
import { deriveDistributableTotal } from './execution-cost-policy'

export interface TranslationGuardResult {
  readonly ok: boolean
  readonly mismatches: readonly string[]
}

/**
 * Pure, side-effect-free decode+compare — never signs, never broadcasts,
 * never mutates anything. Safe to call before persisting the pending
 * transaction row at all.
 */
export function validateTranslatedOutputsAgainstOutcome(
  psbtBase64: string,
  outcome: Outcome<ArbitrationOutcomeContent, readonly BeneficiaryDestination[]>,
  network: bitcoin.Network,
  declaredMinerFeeSats?: number,
): TranslationGuardResult {
  const mismatches: string[] = []

  let psbt: bitcoin.Psbt
  try {
    psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network })
  } catch (err) {
    return { ok: false, mismatches: [`failed to decode translated PSBT: ${err instanceof Error ? err.message : String(err)}`] }
  }

  const witnessUtxo = psbt.data.inputs[0]?.witnessUtxo
  if (!witnessUtxo) {
    return { ok: false, mismatches: ['translated PSBT input has no witnessUtxo — cannot determine the real spendable value'] }
  }
  const inputValue = BigInt(witnessUtxo.value)

  const actualOutputs = psbt.txOutputs.map((o) => {
    let address: string | undefined
    try {
      address = bitcoin.address.fromOutputScript(o.script, network)
    } catch {
      // Non-standard script — left undefined; will simply never match an
      // expected destination below, surfacing as an unexplained output.
    }
    return { address, value: BigInt(o.value) }
  })
  const outputTotal = actualOutputs.reduce((sum, o) => sum + o.value, 0n)
  if (outputTotal > inputValue) {
    return { ok: false, mismatches: [`translated PSBT outputs (${outputTotal} sats) exceed its own declared input (${inputValue} sats)`] }
  }
  const actualFee = inputValue - outputTotal
  if (declaredMinerFeeSats !== undefined && actualFee !== BigInt(declaredMinerFeeSats)) {
    mismatches.push(`translator declared a miner fee of ${declaredMinerFeeSats} sats, but the translated PSBT actually implies ${actualFee} sats (input ${inputValue} minus outputs ${outputTotal}) — internally inconsistent`)
  }

  const destinations = outcome.destinationBinding?.reference ?? []
  if (destinations.length === 0) {
    return { ok: false, mismatches: ['authoritative Outcome has no destination binding — refusing to validate a translation against nothing'] }
  }

  // M8.6 — bound the gap between the AUTHORIZED gross entitlement and
  // the REAL, PSBT-observed delivered total (outputTotal) against the
  // deterministic execution-cost ceiling BEFORE using it as the ratio
  // basis. This is what prevents "100% of whatever is left" from being
  // trivially satisfied by an arbitrarily skimmed output — see this
  // file's own header and execution-cost-policy.ts.
  const derivation = deriveDistributableTotal(BigInt(outcome.content.totalUnits), outputTotal, outcome.content.allocations.length)
  if (!derivation.ok) {
    // Append, never replace — an earlier internal-consistency finding
    // (declaredMinerFeeSats mismatch) must not be silently discarded.
    return { ok: false, mismatches: [...mismatches, derivation.reason] }
  }

  // Re-derive the EXPECTED per-beneficiary split over the BOUNDED
  // distributable total — never the raw gross totalUnits directly
  // (which would ignore the real, legitimate rail cost) and never the
  // unbounded outputTotal directly (which would be tautological).
  const expected = allocateExactUnitsOverTotal(outcome.content, derivation.distributable)

  for (const exp of expected) {
    const destination = destinations.find((d) => d.beneficiary === exp.beneficiary)
    if (!destination) {
      mismatches.push(`no destination binding exists for allocated beneficiary "${exp.beneficiary}"`)
      continue
    }
    const match = actualOutputs.find((o) => o.address === destination.destination && o.value === BigInt(exp.units))
    if (!match) {
      const atThatAddress = actualOutputs.find((o) => o.address === destination.destination)
      mismatches.push(
        atThatAddress
          ? `beneficiary "${exp.beneficiary}" expected ${exp.units} sats at ${destination.destination}, translated PSBT pays ${atThatAddress.value} sats there instead`
          : `beneficiary "${exp.beneficiary}" expected an output of ${exp.units} sats at ${destination.destination} — no such output exists in the translated PSBT`
      )
    }
  }

  // No unexplained extra outputs (§46 "added unauthorized output") —
  // exactly one output per authorized beneficiary, per this guard's own
  // disclosed protocol-fee-inactive scope (see file header).
  if (actualOutputs.length !== expected.length) {
    mismatches.push(`translated PSBT has ${actualOutputs.length} output(s), expected exactly ${expected.length} (one per authorized beneficiary)`)
  }

  return { ok: mismatches.length === 0, mismatches }
}

/** An expected refusal (409, mismatches in `details`), not a 500: nothing was persisted. Unexpected faults stay 500. */
export class TranslationGuardError extends AppError {
  constructor(public readonly mismatches: readonly string[]) {
    super(`Translated settlement transaction does not correspond to the authoritative Outcome (${mismatches.length} mismatch(es)): ${mismatches.join('; ')}`, 409, 'TRANSLATION_GUARD_MISMATCH', mismatches)
  }
}

/** Throws `TranslationGuardError` (never persisted, never broadcast) on any mismatch — the enforcement wrapper `dispute.service.ts` calls before persisting a pending transaction. */
export function assertTranslationMatchesOutcome(
  psbtBase64: string,
  outcome: Outcome<ArbitrationOutcomeContent, readonly BeneficiaryDestination[]>,
  network: bitcoin.Network,
  declaredMinerFeeSats?: number,
): void {
  const result = validateTranslatedOutputsAgainstOutcome(psbtBase64, outcome, network, declaredMinerFeeSats)
  if (!result.ok) {
    throw new TranslationGuardError(result.mismatches)
  }
}
