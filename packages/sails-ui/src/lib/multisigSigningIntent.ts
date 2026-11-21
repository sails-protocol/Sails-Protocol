/**
 * Missão 11 Fase 9.1.1 §3 — builds the ExpectedSigningIntent a MULTISIG
 * pending release/refund PSBT must satisfy, using ONLY data this browser
 * already has through the public @satsails/p2p-trading-sdk surface
 * (`sailsClient.settlement.get()`/`getPendingTransaction()`) — the same
 * neutrality test any external wallet would need to pass. No verification
 * SEMANTICS live here: this module only ASSEMBLES the expectation object;
 * `verifyAndSignEscrowPsbt()` (the SDK's own function) does the actual
 * decode-and-compare. See that function's own module header for why
 * signing must never happen without it.
 *
 * SPLIT is deliberately NOT supported here — see buildMultisigSigningIntent()'s
 * own comment below for why, and BACKLOG.md's "MULTISIG cooperative
 * spend without the server" row for the shared-construction-primitive
 * decision record this same limitation is part of.
 */
import {
  type Escrow,
  type EscrowPendingTransaction,
  type ExpectedSigningIntent,
  buildExpectedFeeAwareReleaseOutputs,
  verifySigningIntent,
  networkFromMultisigAddress,
  btcToSats,
} from '@satsails/p2p-trading-sdk'
import type { SigningVerification } from './signingRequest'
import { t } from '../i18n'

/** `userMessage`: the same refusal in plain words, in the interface language, for the signing card. */
export class MultisigSigningIntentError extends Error {
  constructor(message: string, public readonly userMessage: string) {
    super(message)
  }
}

/**
 * Read-only: builds the expected intent and runs the SDK's own
 * verifySigningIntent() (the same check verifyAndSignEscrowPsbt() runs
 * before signing). Never signs; never throws for a refusal.
 */
export function checkMultisigPending(escrow: Escrow, pending: EscrowPendingTransaction): SigningVerification {
  let expected: ExpectedSigningIntent
  try {
    assertMultisigSigningAllowed(escrow)
    expected = buildMultisigSigningIntent(escrow, pending)
  } catch (err) {
    if (err instanceof MultisigSigningIntentError) return { status: 'cannotVerify', reason: err.userMessage }
    throw err
  }
  const result = verifySigningIntent(pending.unsignedPsbtBase64, expected, pending.requiredSigners)
  return result.ok
    ? { status: 'verified', outputs: expected.outputs.map((o) => ({ address: o.address, sats: o.value })), minerFeeSats: expected.minerFee }
    : { status: 'mismatch', fields: result.mismatches.map((m) => m.field) }
}

/**
 * Throws MultisigSigningIntentError (never returns a partial/guessed
 * intent) if the public data needed to verify this specific pending
 * transaction isn't available — a caller must treat that as "cannot
 * safely sign this one," never as license to fall back to raw
 * `signEscrowPsbt()`.
 */
// CTO 28 Despacho 033 (2026-11-20): fundedAmount's unit is inconsistent on main (provider persists sats,
// this verifier reads BTC). MULTISIG signing that depends on it is on HOLD until the backend fix gets GK VERIFY.
// shortcut: hard-coded flag, flip to false only with that VERIFY on record.
export const MULTISIG_SIGNING_HOLD = true
export const multisigSigningHoldMessage = () => t('escrow.multisig.hold')

/**
 * The one HOLD gate (Despacho 033). Every MULTISIG signing path calls it first: checkMultisigPending() and
 * useEscrowKey's signVerifiedMultisigPending(), before any key is decrypted. The builder below stays pure, so its
 * real-crypto tests keep proving that a tampered PSBT is refused while the HOLD lasts. No parameter or env var
 * bypasses it.
 */
export function assertMultisigSigningAllowed(escrow: Pick<Escrow, 'id'>): void {
  if (MULTISIG_SIGNING_HOLD) {
    throw new MultisigSigningIntentError(
      `MULTISIG signing on HOLD (fundedAmount unit, CTO 28 Despacho 033) — escrow ${escrow.id}.`,
      multisigSigningHoldMessage()
    )
  }
}

export function buildMultisigSigningIntent(escrow: Escrow, pending: EscrowPendingTransaction): ExpectedSigningIntent {
  if (pending.kind === 'split') {
    // A SPLIT's output construction (proportional buyerBps division plus
    // a three-way fee leg, multisig.provider.ts's own buildUnsignedSplit())
    // is genuinely complex arithmetic this module deliberately does not
    // duplicate — doing so independently here would risk exactly the
    // "server and external wallet maintain subtly different construction
    // rules" drift this whole mission has avoided everywhere else (see
    // §5's shared-construction-primitive decision record). SPLIT only
    // ever happens via a disputed arbiter ruling (rare), never the normal
    // cooperative path — refusing here, rather than guessing, is the
    // fail-safe choice.
    throw new MultisigSigningIntentError(
      'Independent verification for a SPLIT pending transaction is not yet supported — refusing to sign blind. ' +
      'This requires a shared, audited construction primitive (tracked in BACKLOG.md), not an independently-reimplemented one.',
      t('escrow.multisig.split')
    )
  }

  if (!escrow.multisigAddr) {
    throw new MultisigSigningIntentError(`Escrow ${escrow.id} has no known deposit address yet — cannot verify a signing intent against it.`, t('escrow.multisig.noAddress'))
  }
  if (!escrow.txLockId || escrow.txLockVout === null || escrow.txLockVout === undefined) {
    throw new MultisigSigningIntentError(`Escrow ${escrow.id} is missing its funding outpoint (txLockId/txLockVout) — cannot verify the PSBT's input.`, t('escrow.multisig.noLockTx'))
  }
  if (!escrow.fundedAmount) {
    throw new MultisigSigningIntentError(`Escrow ${escrow.id} has no recorded fundedAmount — cannot determine the expected input value.`, t('escrow.multisig.noFunded'))
  }
  if (pending.minerFeeSats === null || pending.minerFeeSats === undefined) {
    throw new MultisigSigningIntentError(
      `Pending transaction for escrow ${escrow.id} has no recorded minerFeeSats — cannot reconstruct the expected outputs. ` +
      'Refusing to sign blind rather than guessing a fee rate that would almost never match what the server actually built.',
      t('escrow.multisig.noMinerFee')
    )
  }
  const participantPubkeys = escrow.participantKeys?.map((k) => k.publicKeyHex)
  if (!participantPubkeys || participantPubkeys.length < 2) {
    throw new MultisigSigningIntentError(`Escrow ${escrow.id} has fewer than 2 registered participant keys — cannot verify the witness script.`, t('escrow.multisig.noKeys'))
  }

  const network = networkFromMultisigAddress(escrow.multisigAddr)
  const inputValueSats = btcToSats(escrow.fundedAmount)
  const minerFee = BigInt(pending.minerFeeSats)

  const outputs = buildOutputsForKind(escrow, pending, inputValueSats, minerFee)

  return {
    operation: pending.kind === 'release' ? 'RELEASE' : 'REFUND',
    network,
    escrowId: escrow.id,
    input: { txid: escrow.txLockId, vout: escrow.txLockVout, value: inputValueSats, multisigAddress: escrow.multisigAddr },
    outputs,
    minerFee,
    threshold: 2, // every current MULTISIG script is 2-of-3 (buyer, seller, arbiter) — see multisig.provider.ts's own buildScript()
    participantPubkeys,
    requiredSigners: pending.requiredSigners,
  }
}

function buildOutputsForKind(
  escrow: Escrow,
  pending: EscrowPendingTransaction,
  inputValueSats: bigint,
  minerFee: bigint
): Array<{ address: string; value: bigint }> {
  if (pending.kind === 'refund') {
    // Refund is always Sails=0 (RFC's own frozen conservation equation —
    // see multisig.provider.ts's buildUnsignedRefund() header comment):
    // the seller's single output receives the full spendable value, no
    // fee leg, regardless of this escrow's own fee-policy snapshot.
    return [{ address: pending.toAddress, value: inputValueSats - minerFee }]
  }

  // kind === 'release'
  const feeCollectible = !!escrow.feePolicyVersionId
    && escrow.snapshotProtocolFeeRate !== null && escrow.snapshotProtocolFeeRate !== undefined
    && !escrow.snapshotFeeCollectionWaivedPreFunding
  if (!feeCollectible) {
    return [{ address: pending.toAddress, value: inputValueSats - minerFee }]
  }
  if (!escrow.snapshotFeeCollectionAddress) {
    throw new MultisigSigningIntentError(`Escrow ${escrow.id} is fee-collectible but has no snapshotFeeCollectionAddress — cannot verify the fee output.`, t('escrow.multisig.noFeeAddress'))
  }
  return buildExpectedFeeAwareReleaseOutputs({
    lockedAmountSats: inputValueSats,
    protocolFeeRate: escrow.snapshotProtocolFeeRate!,
    minerFee,
    buyerAddress: pending.toAddress,
    secondOutputAddress: escrow.snapshotFeeCollectionAddress,
  })
}
