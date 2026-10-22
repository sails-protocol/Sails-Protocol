/**
 * MultisigFundingReorgSweep — Missão 11 Fase 9.1 §1/§3 (supersedes the
 * Fase 8.1 LB-08(A) log-only version).
 *
 * Phase 8.1 deliberately implemented detection + structured logging only,
 * per the CTO's own explicit stop condition ("if correct semantics require
 * a schema migration or a new economic state, STOP and report the
 * proposed invariant to the CTO — do not unilaterally redesign economic
 * history"). Phase 9.0's own audit named this gap explicitly ("INV-07F,
 * DP-03, DP-05, DP-07" — those labels are non-canonical/unrecoverable,
 * see Missão 11 Fase 9.3.3, docs/PROTOCOL_INVARIANTS.md's "Canonical
 * Hierarchy": this closes INV-04/INV-05/INV-07, Level 2 DP-1/DP-2/DP-3),
 * and Phase 9.1 authorizes closing it with the smallest existing
 * pattern: EscrowFundingEvidence, an append-only ledger mirroring
 * FeeCollectionEvidence's own proven shape exactly.
 *
 * Still does NOT mutate Escrow.status — the historical fact "FUNDS_LOCKED
 * was reached under evidence X at time T" is never rewritten. What
 * changed since Fase 8.1: a later reorg (or reconfirmation, or
 * replacement) is now a durable, queryable, append-only fact instead of
 * a log line that vanishes with log rotation.
 *
 * State machine (one evidence row per real change, never a duplicate for
 * an unchanged observation — see the inline comments below for exactly
 * which comparison decides each branch):
 *
 *   trustworthy (OBSERVED_CONFIRMED/RECONFIRMED, same txid, still deep enough)
 *     -> no write (nothing changed)
 *   uncertain, same txid now deep enough again
 *     -> RECONFIRMED
 *   any state, a DIFFERENT txid now satisfies the exact funding-matching
 *   rule at sufficient depth
 *     -> REPLACEMENT_OBSERVED (deliberately NOT auto-promoted to
 *        trustworthy on first sight — requires being seen again, deep
 *        enough, on a LATER tick before RECONFIRMED is recorded; see
 *        escrow-funding-evidence.service.ts's own header comment for why
 *        "do not manufacture certainty" applies here too)
 *   a confirmed-but-not-yet-deep-enough candidate exists, previous state
 *   was trustworthy
 *     -> REORGED_INVALIDATED (a real regression from trusted to uncertain)
 *   nothing at all found, previous state was not already REORGED_INVALIDATED
 *     -> REORGED_INVALIDATED
 *   nothing at all found, previous state already REORGED_INVALIDATED
 *     -> no write (avoid duplicate spam for an unresolved, unchanged loss)
 *   an escrow with NO recorded evidence at all (pre-Fase-9.1, or never
 *   swept before)
 *     -> skipped entirely; this sweep never invents a retroactive
 *        baseline for history it didn't itself observe
 *
 * Missão 11 Fase 9.3 — each escrow's read-then-write decision below now
 * runs inside withEscrowFundingLock(escrow.id, ...), the same per-escrow
 * pg_advisory_xact_lock this sweep shares with markPaymentSent() and
 * initiateRelease()/initiateSplit() (escrow-lifecycle.ts's own header
 * comment on withEscrowFundingLock() has the full rationale). This closes
 * two races at once: (a) this sweep's own read-then-conditional-write was
 * previously non-atomic, so two concurrent sweep ticks (e.g. two app
 * instances) could both read the same "last" evidence row and both
 * decide to write, producing a duplicate/racy evidence entry
 * (REORG-04); (b) a lifecycle transition reading evidence as trustworthy
 * a moment before this sweep invalidates it could otherwise still
 * proceed on that stale belief. rescanFunding() (an external chain scan,
 * not a DB call) and loadParticipantPubkeys() intentionally stay OUTSIDE
 * the lock — only the actual evidence read + conditional write need to be
 * atomic, and holding a DB transaction open across a network call would
 * be needless lock/connection hold time for no correctness benefit.
 */
import { prisma } from '../../common/database'
import { config } from '../../config'
import { childLogger } from '../../common/logger'
import { escrowFundingEvidenceRepository } from './escrow-funding-evidence-repository'
import { multisigProvider, type MultisigEscrowInput } from './multisig.provider'
import { loadParticipantPubkeys, withEscrowFundingLock } from './escrow-lifecycle'

const log = childLogger('multisig-funding-reorg-sweep')

export interface FundingReorgSweepResult {
  reconfirmed: string[]
  replacementObserved: string[]
  reverted: string[]
  stillGood: string[]
  stillPending: string[]
  skippedNoBaseline: string[]
  failed: Array<{ escrowId: string; error: string }>
}

export async function sweepMultisigFundingReorgs(): Promise<FundingReorgSweepResult> {
  const result: FundingReorgSweepResult = {
    reconfirmed: [], replacementObserved: [], reverted: [], stillGood: [], stillPending: [], skippedNoBaseline: [], failed: [],
  }

  const escrows = await prisma.escrow.findMany({
    where: { type: 'MULTISIG', status: 'FUNDS_LOCKED', txLockId: { not: null } },
  })

  if (escrows.length === 0) return result

  const required = config.multisig.requiredConfirmations

  for (const escrow of escrows) {
    try {
      // Cheap, unlocked peek — preserves the original "no baseline, skip
      // without paying for loadParticipantPubkeys/rescanFunding" fast
      // path. Not authoritative: the AUTHORITATIVE read happens again
      // inside the lock below, so a rare stale peek here only costs one
      // wasted rescanFunding() call in the (harmless) worst case, never
      // an incorrect decision — the actual read-then-write that matters
      // for correctness is entirely inside withEscrowFundingLock().
      const peek = await escrowFundingEvidenceRepository.listForEscrow(escrow.id)
      if (peek.length === 0) {
        result.skippedNoBaseline.push(escrow.id)
        continue
      }

      const { buyerPubkey, sellerPubkey, arbiterPubkey } = await loadParticipantPubkeys(escrow.id)
      const input: MultisigEscrowInput = {
        tradeId: escrow.tradeId, lockedAmount: escrow.lockedAmount.toString(),
        buyerPubkey, sellerPubkey, arbiterPubkey, multisigAddr: escrow.multisigAddr,
        feePolicyVersionId: escrow.feePolicyVersionId,
        snapshotProtocolFeeRate: escrow.snapshotProtocolFeeRate?.toString() ?? null,
        snapshotFeeCollectionAddress: escrow.snapshotFeeCollectionAddress,
        snapshotFeeCollectionWaivedPreFunding: escrow.snapshotFeeCollectionWaivedPreFunding,
      }

      const scan = await multisigProvider.rescanFunding(input)

      // Missão 11 Fase 9.3 — the evidence read that decides `last`/
      // `trustworthy` and every conditional write below now run inside
      // one withEscrowFundingLock() transaction, so a concurrent sweep
      // tick or lifecycle transition can never interleave with this
      // escrow's read-then-write. See this file's own header comment and
      // escrow-lifecycle.ts's withEscrowFundingLock() doc comment for the
      // full rationale.
      await withEscrowFundingLock(escrow.id, async (tx) => {
        const history = await escrowFundingEvidenceRepository.listForEscrow(escrow.id, tx)
        const last = history[history.length - 1]
        if (!last) {
          // No baseline this sweep itself ever recorded (a pre-Fase-9.1
          // escrow, or a MULTISIG escrow whose lockFunds() ran before this
          // repository existed). Never invent a retroactive OBSERVED_CONFIRMED
          // row for history this sweep didn't witness — skip, disclosed.
          result.skippedNoBaseline.push(escrow.id)
          return
        }

        const trustworthy = last.kind === 'OBSERVED_CONFIRMED' || last.kind === 'RECONFIRMED'

        if (scan && scan.depth >= required) {
          if (last.txid === scan.txId) {
            if (trustworthy) {
              result.stillGood.push(escrow.id)
            } else {
              await escrowFundingEvidenceRepository.record({
                escrowId: escrow.id, kind: 'RECONFIRMED', txid: scan.txId, vout: scan.vout,
                ...(scan.confirmedAtHeight !== null ? { observedAtHeight: scan.confirmedAtHeight } : {}),
                ...(scan.tipHeightAtObservation !== null ? { tipHeightAtObservation: scan.tipHeightAtObservation } : {}),
              }, tx)
              result.reconfirmed.push(escrow.id)
            }
          } else {
            // A different txid than whatever we last knew about — record
            // once per distinct new candidate, never re-record the same one.
            if (!(last.kind === 'REPLACEMENT_OBSERVED' && last.txid === scan.txId)) {
              await escrowFundingEvidenceRepository.record({
                escrowId: escrow.id, kind: 'REPLACEMENT_OBSERVED', txid: scan.txId, vout: scan.vout,
                ...(scan.confirmedAtHeight !== null ? { observedAtHeight: scan.confirmedAtHeight } : {}),
                ...(scan.tipHeightAtObservation !== null ? { tipHeightAtObservation: scan.tipHeightAtObservation } : {}),
                note: `Replaces previously observed ${last.txid ?? 'unknown'}`,
              }, tx)
              result.replacementObserved.push(escrow.id)
            } else {
              result.stillPending.push(escrow.id)
            }
          }
          return
        }

        if (scan && scan.depth < required) {
          // A confirmed-but-shallow candidate exists — not yet trustworthy.
          if (trustworthy) {
            await escrowFundingEvidenceRepository.record({
              escrowId: escrow.id, kind: 'REORGED_INVALIDATED', txid: last.txid ?? undefined,
              note: `Confirmation depth dropped: only ${scan.depth} of ${required} required at this observation`,
            }, tx)
            result.reverted.push(escrow.id)
          } else {
            result.stillPending.push(escrow.id)
          }
          return
        }

        // Nothing found at all.
        if (last.kind !== 'REORGED_INVALIDATED') {
          await escrowFundingEvidenceRepository.record({
            escrowId: escrow.id, kind: 'REORGED_INVALIDATED', txid: last.txid ?? undefined,
            note: 'No confirmed UTXO matching the required funding criteria found at this observation',
          }, tx)
          result.reverted.push(escrow.id)
        } else {
          result.stillPending.push(escrow.id)
        }
      })
    } catch (err) {
      result.failed.push({ escrowId: escrow.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  if (result.reverted.length || result.reconfirmed.length || result.replacementObserved.length || result.failed.length) {
    log.info({
      msg: 'MULTISIG funding reorg sweep completed',
      reverted: result.reverted.length,
      reconfirmed: result.reconfirmed.length,
      replacementObserved: result.replacementObserved.length,
      stillGood: result.stillGood.length,
      stillPending: result.stillPending.length,
      skippedNoBaseline: result.skippedNoBaseline.length,
      failed: result.failed.length,
    })
  }

  return result
}
