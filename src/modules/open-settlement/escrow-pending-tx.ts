import { prisma } from '../../common/database'
import { NotFoundError, EscrowError, ForbiddenError, ValidationError } from '../../common/errors'
import { config } from '../../config'
import { getSignatureCollectionProvider } from './escrow-providers'
import {
  assertEscrowTransition,
  isSellerOrAssignedArbiter,
  assertDisputedDispositionAuthority,
  loadParticipantPubkeys,
  claimEscrowTransition,
  revertEscrowStatus,
  settlementSucceededButLocalStepFailed,
  emitEscrowTransition,
  resolvePayoutAddress,
  checkFundMovementCapability,
  assertFundingNotUncertain,
  withEscrowFundingLock,
} from './escrow-lifecycle'
import { hasDualApproval } from './escrow-dual-approval'
import { escrowRepository } from './escrow-repository'
import { escrowFundingEvidenceService } from './escrow-funding-evidence.service'
import { tradeRepository } from '../open-p2p/trade-repository'
import { feeObligationService } from './fee-obligation.service'
import { feeCollectionRecognitionService } from './fee-collection-recognition.service'
import { identifyFeeOutput, networkFor } from './multisig.provider'
import { recordLiveCorrespondenceIfApplicable } from './dispute-correspondence'
import { authorizePendingExecution } from './capability-execution-authorization'
import { authorizeDisputedPendingExecution } from './economic-disposition-authority'
import { childLogger } from '../../common/logger'

const log = childLogger('escrow-pending-tx')

/**
 * Sails OpenSettlement — client-signature-collection pending-transaction
 * flow (ARCHITECTURE_AUDIT_REPORT.md §2's escrow.service.ts finding,
 * recommendation #1, closed 2026-08-08 — see escrow-providers.ts's
 * identical header comment for the full context).
 *
 * Moved verbatim from escrow.service.ts's initiateRelease()/
 * initiateRefund()/initiateSplit()/submitTransactionSignature()/
 * getPendingTransaction() (no behavior change) — the "assemble an
 * unsigned PSBT, collect required signatures, finalize + broadcast"
 * concern for SIGNATURE_COLLECTION_PROVIDERS (MULTISIG/LIGHTNING_HODL/
 * SAFE_GUARD_EVM), genuinely separate from the direct-call
 * releaseFunds()/refundFunds()/splitFunds() path escrow.service.ts still
 * owns for providers that move funds synchronously in one call (MOCK,
 * WDK_USDT_EVM).
 */

// Phase 2 client-signature-collection flow (2026-07-27) — the real
// replacement for the direct releaseFunds() call in escrow.service.ts,
// for providers in SIGNATURE_COLLECTION_PROVIDERS (MULTISIG only this
// pass). Runs the exact same ownership/capability/dual-approval checks
// releaseFunds() already has, but does NOT transition escrow.status or
// write txReleaseId itself — it only builds and persists an unsigned
// PSBT for the required parties to sign. The real transition happens
// inside submitTransactionSignature() below, once every required
// signature has arrived.
// ─── Shared skeleton for initiateRelease/Refund/Split ──────────────────────
// These three functions are 90% identical (~90 lines each). Extracted the
// shared validation + provider lookup + pending-transaction-create skeleton
// into this private helper to eliminate ~180 lines of duplication. Each
// public function only adds its own specific pre-checks (capability,
// dual-approval, buyerBps validation) and provider call.
async function initiateSignatureCollectionCore(
  escrowId: string,
  kind: 'release' | 'refund' | 'split',
  targetStatus: string,
  triggeredBy: string,
  buildProvider: (provider: any, escrowRecord: any) => Promise<{ psbtBase64: string; requiredSigners: string[]; toAddress?: string; toAddressSecondary?: string; feeCollection?: { feeSats: number; waived: boolean } | null; minerFeeSats?: number }>,
  extraData?: Record<string, unknown>
) {
  const escrow = await escrowRepository.findById(escrowId)
  if (!escrow) throw new NotFoundError('Escrow', escrowId)

  // Issue #242 — getSignatureCollectionProvider() asserts deployment
  // eligibility before returning anything, so a production-ineligible
  // type is refused here, before this function ever builds/persists an
  // unsigned PSBT (the "pending economic instruction" the mission's own
  // required tests are about) — not just before the later broadcast.
  const provider = getSignatureCollectionProvider(escrow.type)
  if (!provider) {
    throw new EscrowError(
      `Escrow type '${escrow.type}' does not use the client-signature-collection ${kind} flow`
    )
  }
  assertEscrowTransition(escrow.status, targetStatus as any)

  // Missão 11 Fase 9.1 §2 — release and split both credit the BUYER (and,
  // for split, collect a protocol fee) from what's believed to be the
  // escrow's own locked funds; refund is deliberately exempt (see
  // assertFundingNotUncertain()'s own comment — it's a recovery path,
  // returning collateral to the party who originally funded it, not a
  // new false-positive risk).
  if (kind === 'release' || kind === 'split') {
    await assertFundingNotUncertain(escrowId, escrow.type)
  }

  const trade = await tradeRepository.findById(escrow.tradeId)
  if (!trade) throw new NotFoundError('Trade', escrow.tradeId)
  // ADR-005 / #218 — when this pending operation originates from a
  // disputed ruling, snapshot the exact ruling generation that authorized
  // it (disputeId/appealRound/arbiterId/ruling/authoritySignature/
  // authorityIssuedAt) onto the pending row itself below. This is the
  // durable provenance the Economic Disposition Commit Gate
  // (economic-disposition-authority.ts) later re-validates against the
  // LIVE Dispute row, immediately before the first provider side effect
  // in submitTransactionSignature(). null for an ordinary cooperative
  // operation — ADR-005 §9 does not redefine that authority.
  let disputedRulingProvenance: Record<string, unknown> = {}
  if (escrow.status === 'DISPUTED') {
    const dispute = await assertDisputedDispositionAuthority(trade.id, escrow.status, triggeredBy)
    if (dispute) {
      disputedRulingProvenance = {
        disputeId: dispute.id,
        rulingAppealRound: dispute.appealRound,
        rulingArbiterId: dispute.arbiterId,
        rulingOutcome: dispute.ruling,
        rulingAuthoritySignature: dispute.authoritySignature,
        rulingAuthorityIssuedAt: dispute.authorityIssuedAt,
      }
    }
  } else if (!(await isSellerOrAssignedArbiter(trade.id, trade.sellerId, triggeredBy))) {
    throw new ForbiddenError(`${triggeredBy} is neither the seller of trade ${trade.id} nor its assigned dispute arbiter`)
  }

  // Missão 06.9 (RFC-014 wiring completion) — moved here, into the one
  // shared skeleton every signature-collection kind funnels through, so
  // release/refund/split get the identical check instead of only release
  // having it (the exact drift Missão 06.7's audit found: this used to
  // live only in initiateRelease()'s own wrapper below, so
  // initiateRefund()/initiateSplit() silently never got it).
  const capabilityScope =
    kind === 'release' ? 'settlement.escrow.released' as const
    : kind === 'refund' ? 'settlement.escrow.refunded' as const
    : 'settlement.escrow.split' as const
  await checkFundMovementCapability(triggeredBy, capabilityScope)

  const existingPending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
  if (existingPending) {
    throw new EscrowError(`Escrow ${escrowId} already has a pending ${existingPending.kind} transaction awaiting signatures`)
  }

  const { buyerPubkey, sellerPubkey, arbiterPubkey } = await loadParticipantPubkeys(escrowId)
  // Missão 11 Fase 5.3 §A — restores context this function already HAD
  // (triggeredBy is its own parameter, already used for the authorization
  // check above and already persisted onto EscrowPendingTransaction.triggeredBy
  // below) but never threaded onto the record the provider itself
  // receives — escrow.service.ts's direct-call releaseFunds() has always
  // included `triggeredBy` in its own equivalent record (see its own
  // `{ ...escrow, buyerId, sellerId, triggeredBy }`); this brings the
  // signature-collection path to the same parity, closing the gap that
  // left MultisigProvider.assertArbiterMatchesScript()'s pre-existing
  // triggeredBy/arbiter identity check structurally unreachable on the
  // only path MULTISIG actually uses for a real disputed release/refund/
  // split. Not a new authorization mechanism — the check itself already
  // existed; only its input was missing.
  const escrowRecord = { ...escrow, buyerId: trade.buyerId, sellerId: trade.sellerId, buyerPubkey, sellerPubkey, arbiterPubkey, triggeredBy }

  const result = await buildProvider(provider, escrowRecord)

  try {
    // Missão 11 Fase 9.3 — the AUTHORITATIVE funding-uncertainty re-check
    // (the earlier assertFundingNotUncertain() call above is only a cheap
    // fail-fast, run before the trade lookup / authorization / capability
    // / provider PSBT-building work) and the pending-transaction write now
    // run inside the same withEscrowFundingLock() transaction, closing
    // the window where a concurrent reorg-sweep tick could invalidate the
    // evidence between the earlier check and this write. See
    // escrow-lifecycle.ts's own header comment on withEscrowFundingLock()
    // for why this specific mechanism closes the race.
    return await withEscrowFundingLock(escrowId, async (tx) => {
      if (kind === 'release' || kind === 'split') {
        const uncertain = await escrowFundingEvidenceService.isFundingUncertain(escrowId, tx)
        if (uncertain) {
          throw new EscrowError(
            `Escrow ${escrowId}'s funding evidence became uncertain (reorg or replacement detected) while this request was in flight — refusing to build a pending ${kind} transaction. Refunding, raising a dispute, or waiting for reconfirmation remain available.`
          )
        }
      }
      return tx.escrowPendingTransaction.create({
        data: {
          escrowId,
          kind,
          toAddress: result.toAddress!,
          ...(result.toAddressSecondary ? { toAddressSecondary: result.toAddressSecondary } : {}),
          unsignedPsbtBase64: result.psbtBase64,
          requiredSigners: result.requiredSigners,
          triggeredBy,
          // Missão 11 Fase 4 §J — persist exactly what the provider built,
          // so submitTransactionSignature() below records a FeeObligation
          // guaranteed to match the real transaction, not a later
          // independent recomputation.
          ...(result.feeCollection ? { feeCollectionSats: result.feeCollection.feeSats, feeCollectionWaived: result.feeCollection.waived } : {}),
          // Missão 11 Fase 9.1.1 §3 — persist the exact miner fee this PSBT
          // was actually built against, so an independent verifier
          // (sails-ui, or any external wallet) can reconstruct the correct
          // ExpectedSigningIntent without re-estimating a live fee rate
          // that would almost never match the historical value baked into
          // this already-built PSBT. Undefined for a provider that doesn't
          // report one (LIGHTNING_HODL/SAFE_GUARD_EVM today).
          ...(result.minerFeeSats !== undefined ? { minerFeeSats: result.minerFeeSats } : {}),
          ...disputedRulingProvenance,
          ...extraData,
        },
      })
    })
  } catch (err: any) {
    if (err?.code === 'P2002') {
      throw new EscrowError(`Escrow ${escrowId} already has a pending transaction awaiting signatures (concurrent initiate)`)
    }
    throw err
  }
}

export async function initiateRelease(escrowId: string, toAddress: string | undefined, triggeredBy: string) {
  // Capability check (RFC-014) now lives in initiateSignatureCollectionCore()
  // above, shared by release/refund/split (Missão 06.9) — this file used
  // to duplicate it here, which is exactly why refund/split never got it.
  // Dual-approval check — only release has this (RFC-015).
  const escrow = await escrowRepository.findById(escrowId)
  if (!escrow) throw new NotFoundError('Escrow', escrowId)
  if (config.features.requireDualApprovalForRelease && escrow.status === 'PAYMENT_PENDING') {
    const dual = await hasDualApproval(escrowId)
    if (!dual) {
      throw new EscrowError(
        `Release blocked: both counterparties must call POST /v1/settlement/escrow/${escrowId}/approve-release ` +
        'before funds can be released (RFC-015 two-person control).'
      )
    }
  }
  const trade = await tradeRepository.findById(escrow.tradeId)
  if (!trade) throw new NotFoundError('Trade', escrow.tradeId)
  const resolvedToAddress = await resolvePayoutAddress(toAddress, trade.buyerId, escrow.asset)

  return initiateSignatureCollectionCore(
    escrowId, 'release', 'COMPLETED', triggeredBy,
    (provider, record) => provider.buildUnsignedRelease(record, resolvedToAddress).then((r: any) => ({ ...r, toAddress: resolvedToAddress }))
  )
}

// Sails Core Implementation Program M8-RF (Destination Consistency) —
// `toAddress` is optional/additive at the tail (every existing 2-arg
// call site stays valid) and resolved exactly like `initiateRelease()`'s
// own `resolvedToAddress` above: an explicit caller-supplied value wins
// (the Core-authoritative disputed path passes the historical Outcome's
// own committed seller destination here — never re-derived at dispatch
// time), otherwise the seller's own registered PayoutAddress governs
// (the cooperative/live path) — the SAME rule RELEASE has already
// applied to the buyer since M8.5, now applied symmetrically to REFUND's
// own beneficiary (the seller). `resolvePayoutAddress()` fails closed
// (no fabricated destination) exactly as it already does for RELEASE.
//
// Unlike initiateRelease()/initiateSplit() above, this does NOT overwrite
// the provider's own returned `toAddress` with `resolvedToAddress` —
// buildUnsignedRefund()'s interface has ALWAYS included `toAddress` as
// part of its real return shape (every provider already derives one
// today; MultisigProvider's own now equals `resolvedToAddress` exactly
// since it uses it directly, but LIGHTNING_HODL/SAFE_GUARD_EVM — genuinely
// out of this mission's scope — still derive their OWN, different
// destination internally and must keep reporting THAT truthfully, not a
// value they never actually used).
export async function initiateRefund(escrowId: string, triggeredBy: string, toAddress?: string) {
  const escrow = await escrowRepository.findById(escrowId)
  if (!escrow) throw new NotFoundError('Escrow', escrowId)
  const trade = await tradeRepository.findById(escrow.tradeId)
  if (!trade) throw new NotFoundError('Trade', escrow.tradeId)
  const resolvedToAddress = await resolvePayoutAddress(toAddress, trade.sellerId, escrow.asset)

  return initiateSignatureCollectionCore(
    escrowId, 'refund', 'REFUNDED', triggeredBy,
    (provider, record) => provider.buildUnsignedRefund(record, resolvedToAddress)
  )
}

export async function initiateSplit(escrowId: string, buyerAddress: string | undefined, sellerAddress: string | undefined, buyerBps: number, triggeredBy: string) {
  if (!(buyerBps > 0 && buyerBps < 10000)) {
    throw new ValidationError('buyerBps must be strictly between 0 and 10000 for a real split — use release/refund for an all-or-nothing outcome')
  }
  const escrow = await escrowRepository.findById(escrowId)
  if (!escrow) throw new NotFoundError('Escrow', escrowId)
  const trade = await tradeRepository.findById(escrow.tradeId)
  if (!trade) throw new NotFoundError('Trade', escrow.tradeId)
  const resolvedBuyerAddress = await resolvePayoutAddress(buyerAddress, trade.buyerId, escrow.asset)
  const resolvedSellerAddress = await resolvePayoutAddress(sellerAddress, trade.sellerId, escrow.asset)

  return initiateSignatureCollectionCore(
    escrowId, 'split', 'SPLIT', triggeredBy,
    (provider, record) => {
      if (!provider.buildUnsignedSplit) {
        throw new EscrowError(
          `Escrow type '${record.type}' does not support a SPLIT settlement action — see that provider's own buildUnsignedSplit() comment for the specific reason (contract/protocol limitation, not a missing wire-up).`
        )
      }
      return provider.buildUnsignedSplit(record, resolvedBuyerAddress, resolvedSellerAddress, buyerBps).then((r: any) => ({ ...r, toAddress: resolvedBuyerAddress, toAddressSecondary: resolvedSellerAddress }))
    },
    // Missão 11 Fase 3 — real gap found: buyerBps was validated and used to
    // build the PSBT but never persisted, so submitTransactionSignature()
    // (which can finalize much later, once every signature arrives) had no
    // way to compute the seller's basisAmount for a SPLIT settled via this
    // path. EscrowPendingTransaction.buyerBps (new, additive column) closes
    // this gap.
    { buyerBps }
  )
}

// The signature-collection write path — each required signer (from
// EscrowPendingTransaction.requiredSigners) calls this once, submitting
// their own independently-signed copy of the unsigned PSBT
// (`@satsails/p2p-trading-sdk`'s signEscrowPsbt()). Upsert-idempotent per participant,
// same shape as submitParticipantKey()/approveRelease() (escrow.service.ts/
// escrow-dual-approval.ts). Once every required signer has submitted,
// combines + broadcasts for real (provider.finalizeRelease()/
// finalizeRefund()) and performs the same atomic status-claim
// releaseFunds()/refundFunds() already do, so the race protection those
// methods have is preserved here too.
export async function submitTransactionSignature(escrowId: string, participantId: string, signedPsbtBase64: string) {
  const escrow = await escrowRepository.findById(escrowId)
  if (!escrow) throw new NotFoundError('Escrow', escrowId)

  const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
  if (!pending) {
    throw new EscrowError(`Escrow ${escrowId} has no pending transaction awaiting signatures — call initiate-release/initiate-refund (or, for a dispute SPLIT ruling, resolveDispute()) first`)
  }
  if (!pending.requiredSigners.includes(participantId)) {
    throw new ForbiddenError(
      `${participantId} is not one of the required signers (${pending.requiredSigners.join(', ')}) for escrow ${escrowId}'s pending ${pending.kind}`
    )
  }

  await prisma.escrowTransactionSignature.upsert({
    where: { pendingTxId_participantId: { pendingTxId: pending.id, participantId } },
    update: { signedPsbtBase64 },
    create: { pendingTxId: pending.id, participantId, signedPsbtBase64 },
  })

  const signatures = await prisma.escrowTransactionSignature.findMany({ where: { pendingTxId: pending.id } })
  const submittedIds = new Set(signatures.map((s: { participantId: string }) => s.participantId))
  const allSubmitted = pending.requiredSigners.every((id: string) => submittedIds.has(id))

  if (!allSubmitted) {
    return { pendingTransaction: pending, complete: false, submittedCount: signatures.length, requiredCount: pending.requiredSigners.length }
  }

  // Issue #242 — this is the finalization boundary: every required
  // signature has just arrived (allSubmitted, above) and the next steps
  // are the real economic commit (ADR-005/ADR-004 gates, the atomic
  // status claim, then provider.finalizeRelease/Refund/Split + broadcast
  // below). A pending row can sit here indefinitely — signatures arrive
  // at any later wall-clock time, from any signer, including long after
  // a process restart (this function has no in-memory state of its own;
  // every call re-reads the pending row and its signatures fresh from
  // Postgres) — exactly the "historical pending state" case: if
  // `escrow.type` has since become deployment-ineligible,
  // getSignatureCollectionProvider() refuses here, before any of that,
  // regardless of how long ago the row was created. (dispute-dispatch-
  // recovery.ts's own C4 recovery calls initiateRelease/Refund/Split —
  // the OTHER call site above — not this one; it only re-creates a
  // missing pending row, it never submits a signature itself.)
  const provider = getSignatureCollectionProvider(escrow.type)
  if (!provider) {
    // Cannot happen in practice — a pending row only exists for a type
    // registered in SIGNATURE_COLLECTION_PROVIDERS — but stated loudly
    // rather than silently, consistent with getSettlementProvider()'s own comment.
    throw new EscrowError(`Escrow type '${escrow.type}' has a pending transaction but no registered SignatureCollectionProvider`)
  }
  const targetStatus = pending.kind === 'release' ? 'COMPLETED' : pending.kind === 'refund' ? 'REFUNDED' : 'SPLIT'

  // Validate that the provider supports the required finalization method
  if (pending.kind === 'split' && !provider.finalizeSplit) {
    throw new EscrowError(`Escrow type '${escrow.type}' does not support split finalization — buildUnsignedSplit was allowed but finalizeSplit is not implemented`)
  }

  // ADR-005 / #218 — Economic Disposition Commit Gate. Runs first: a stale
  // ruling generation must fail closed before Capability/Eligibility is
  // even considered (ADR-005 §7 — the two gates are orthogonal, but this
  // ordering means a superseded ruling never gets to "pass" any gate). A
  // no-op for a pending operation with no recorded ruling generation
  // (ordinary cooperative release/refund/split).
  await authorizeDisputedPendingExecution(pending)

  // ADR-004 / #211 — Execution Commit Gate. This re-evaluates the
  // ORIGINAL initiator (pending.triggeredBy), not whichever signer happened
  // to submit the final signature. The durable authorization is committed
  // before the first provider side effect and survives pending-row cleanup.
  await authorizePendingExecution(pending)

  // Atomic claim before ever calling the real, side-effecting provider —
  // same idiom as releaseFunds()/refundFunds() (escrow.service.ts).
  await claimEscrowTransition(escrowId, escrow.status, targetStatus)

  // Issue #291 - two distinct error boundaries. Only a failing PROVIDER
  // finalize reverts the claim (the pending row and signatures stay for a
  // retry). Once finalize has returned, external execution may already have
  // happened: a later LOCAL failure must not revert the escrow as though it
  // had not - the pending row is kept and reconciliation (C8 / PASS 1 / 2 / 3)
  // converges from durable facts.
  let result: Awaited<ReturnType<typeof provider.finalizeRelease>>
  try {
    const signedList = pending.requiredSigners.map(
      (id: string) => signatures.find((s: { participantId: string; signedPsbtBase64: string }) => s.participantId === id)!.signedPsbtBase64
    )
    result = pending.kind === 'release'
      ? await provider.finalizeRelease(escrow, pending.unsignedPsbtBase64, signedList)
      : pending.kind === 'refund'
      ? await provider.finalizeRefund(escrow, pending.unsignedPsbtBase64, signedList)
      : await provider.finalizeSplit!(escrow, pending.unsignedPsbtBase64, signedList)
  } catch (err) {
    await revertEscrowStatus(escrowId, targetStatus, escrow.status)
    throw err
  }

  try {
    const updateData = pending.kind === 'refund'
      ? { txReleaseId: result.txId }
      : { txReleaseId: result.txId, releasedAt: new Date() }
    // txReleaseId is provider EVIDENCE; the write is bound to the immutable,
    // Sails-owned pending operation it belongs to (Issue #291).
    const updated = await escrowRepository.updateSignatureCollectionResult(escrowId, updateData, {
      operation: { pendingOperationId: pending.id },
    })

    // Missão 11 Fase 3 §7 — the SAME centralized function
    // escrow.service.ts's direct-call releaseFunds()/refundFunds()/
    // splitFunds() call, so MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM (which
    // finalize exclusively through this signature-collection path) produce
    // an identical economic determination to MOCK/WDK_USDT_EVM's direct
    // path — one semantics, not two implementations that could diverge.
    const feeOutcome = pending.kind === 'release' ? 'RELEASE' : pending.kind === 'refund' ? 'FULL_REFUND' : 'SPLIT'
    // Missão 11 Fase 4 §J — pass through exactly what was built into the
    // real transaction (persisted at initiate-time above), if any, so the
    // recorded obligation cannot diverge from the actual on-chain output.
    const actualCollection = pending.feeCollectionSats !== null && pending.feeCollectionSats !== undefined
      ? { feeSats: pending.feeCollectionSats, waived: pending.feeCollectionWaived ?? false }
      : undefined
    await feeObligationService.recordObligationForEscrowSettlement(escrow, feeOutcome, pending.buyerBps ?? undefined, actualCollection)

    // Missão 11 Fase 5 §6 — broadcast success -> IN_PROGRESS, closing the
    // gap Fase 4.2 flagged (Activation Blocker A): a real, non-waived
    // Sails fee output was just broadcast (result.txId, above) — record
    // real, deterministic collection evidence for it and advance the
    // FeeObligation past PENDING_COLLECTION. Deliberately excludes:
    //   - refund (never has a fee output at all — §6's own rule);
    //   - a waived or legacy outcome (actualCollection is undefined or
    //     .waived — no fee output was ever built, so there is nothing to
    //     identify and no evidence to fake);
    //   - any rail other than MULTISIG (the only one whose pending
    //     transaction is a real Bitcoin PSBT identifyFeeOutput() can
    //     decode — LIGHTNING_HODL/SAFE_GUARD_EVM never populate
    //     feeCollectionSats at all today, so actualCollection is already
    //     undefined for them; the explicit type check here is a second,
    //     self-documenting guard against that ever changing silently).
    // Broadcast success != confirmed revenue — this never marks COLLECTED
    // itself (see fee-collection-recognition.service.ts's own contract).
    if (pending.kind !== 'refund' && escrow.type === 'MULTISIG' && actualCollection && !actualCollection.waived) {
      try {
        const obligation = await feeObligationService.findByEscrowId(escrowId)
        if (!obligation) {
          throw new Error('recordObligationForEscrowSettlement() just ran for a non-waived collectible fee but no FeeObligation was found')
        }
        if (!escrow.snapshotFeeCollectionAddress) {
          throw new Error('escrow has a real, non-waived actualCollection but no frozen snapshotFeeCollectionAddress — structurally impossible per Fase 4.1\'s own invariant')
        }
        const network = networkFor(config.multisig.network)
        const evidence = identifyFeeOutput(pending.unsignedPsbtBase64, escrow.snapshotFeeCollectionAddress, actualCollection.feeSats, network)
        await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation.id, {
          txid: result.txId, vout: evidence.vout, scriptPubKey: evidence.scriptPubKeyHex, amountSats: evidence.amountSats,
        })
      } catch (err) {
        // Same established safety pattern as recordObligationForEscrowSettlement()
        // itself (Fase 3 §6/§9): the real settlement has ALREADY broadcast
        // successfully by this point — collection-evidence recording is
        // strictly secondary accounting, never allowed to un-do or fail a
        // settlement whose funds already moved. Logged loudly, never
        // thrown; the obligation simply remains PENDING_COLLECTION,
        // exactly the safe/honest state when evidence couldn't be recorded
        // (detectable later via reconciliation, never silently masked).
        log.error({
          msg: 'Broadcast-evidence recording failed after a successful settlement — FeeObligation remains PENDING_COLLECTION, not silently advanced',
          escrowId, err: err instanceof Error ? err.message : err,
        })
      }
    }

    // Sails Core Implementation Program M8.6 — live M6 correspondence for
    // the ONE migrated slice (Mission13 MULTISIG dispute settlement).
    // Narrowly scoped inside recordLiveCorrespondenceIfApplicable() itself
    // (escrow type + "does a RESOLVED Dispute with a durable
    // Core-authoritative Outcome actually exist" — never triggered for a
    // cooperative release or any other rail); never allowed to fail this
    // already-successful settlement (same established idiom as the
    // fee-collection-evidence block immediately above — funds have
    // already moved by this point).
    await recordLiveCorrespondenceIfApplicable(escrowId, escrow.tradeId, escrow.type, result.rawTxHex)

    const eventName = pending.kind === 'release'
      ? 'settlement.escrow.released'
      : pending.kind === 'refund'
      ? 'settlement.escrow.refunded'
      : 'settlement.escrow.split'
    await emitEscrowTransition(escrowId, escrow.tradeId, escrow.status, targetStatus, pending.triggeredBy, eventName, {
      txId: result.txId,
    })

    // Cascade-deletes its EscrowTransactionSignature rows (schema.prisma's
    // onDelete: Cascade) — a completed round leaves no pending row behind.
    await prisma.escrowPendingTransaction.delete({ where: { id: pending.id } }).catch(() => {})

    return { escrow: updated, complete: true }
  } catch (err) {
    // Issue #291 - finalize already succeeded (above): never revert here.
    // The pending row and its signatures are left in place for recovery.
    throw settlementSucceededButLocalStepFailed(escrowId, pending.kind, result.txId, err)
  }
}

export async function getPendingTransaction(escrowId: string) {
  const pending = await prisma.escrowPendingTransaction.findUnique({
    where: { escrowId },
    include: { signatures: true },
  })
  if (!pending) throw new NotFoundError('Pending transaction for this escrow', escrowId)
  return pending
}
