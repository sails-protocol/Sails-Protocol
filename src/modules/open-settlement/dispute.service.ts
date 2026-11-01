/**
 * Dispute Service — Sails OpenSettlement
 * 04-Deepseek Review.md Task 2: raiseDispute()/resolveDispute().
 *
 * First real implementation of the Dispute primitive
 * (PROTOCOL_SPECIFICATION.md §1.9) — the primitive itself isn't new, only
 * its persistence and the escalation flow RFC-007 D4 already specified
 * (Trusted Arbitrator, not a protocol-native role).
 *
 * Deliberately built on the existing Postgres + EventStore (RFC-010)
 * architecture, not a CRDT document — reconciled directly with the user
 * before writing this file: a CRDT-based dispute state would create a
 * second, potentially divergent source of truth alongside `Trade`/
 * `Escrow`, exactly the risk RFC-011 was built to close for Postgres/P2P
 * consistency. "Freeze the trade and notify the arbitrator via pubsub"
 * (the task's own words) is achieved here without introducing CRDTs:
 * freezing = escrowService.openDispute() (already real code, transitions
 * Escrow to DISPUTED); pubsub = eventBus.emit('dispute.opened', ...)
 * (RFC-010's EventStore, already real).
 */
import { prisma } from '../../common/database'
import { NotFoundError, ValidationError, ForbiddenError } from '../../common/errors'
import { eventBus } from '../../common/events/event-bus'
import { escrowService } from './escrow.service'
import { config } from '../../config'
import { TrustedArbitratorProvider, type ArbitrationProvider } from './arbitration-provider'
import { marketArbitrationProvider } from './market-arbitration.provider'
import { createArbitrationProviderResolver } from './arbitration-provider-resolver'
import { escrowRepository, type EscrowRepository } from './escrow-repository'
import { tradeRepository } from '../open-p2p/trade-repository'
import { isPartyOrAgent, asTrustedActor } from './escrow-lifecycle'
import { withIdempotency } from '../../common/idempotency'
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../../common/pagination'
import type { AssetType } from '../../common/types'
import type { EvidenceDescriptor, DisputeRuling } from '@satsails/p2p-schemas'
import type { DisputeStatus } from '@prisma/client'
import {
  verifyAuthorityDecisionSignature,
  assertExecutionMatchesAuthorization,
  type AuthorityDecisionPayload,
} from './arbitration-authority'
import { Prisma } from '@prisma/client'
import { commitAuthoritativeDisputeRuling, revertDisputeRulingRecord } from './dispute-outcome'
import { economicDispositionLockKey } from './economic-disposition-authority'
import { assertDisputeDispatchEligible } from './dispute-dispatch'
import { assertTranslationMatchesOutcome } from './dispatch-translation-guard'
import { networkFor } from './multisig.provider'

// RFC-021 D6 — appeal fee, PROTOCOL_ECONOMY.md §4.4's own arbitration-fee
// baseline (1-2% of the disputed amount, charged as Escrow.feeCharged by
// escrow.service.ts's Phase 0 fee collection) multiplied per round, the
// same "escalating cost discourages frivolous appeals" reasoning Kleros
// uses for its own appeal rounds.
//
// Real charge as of 2026-08-01 (BACKLOG.md P0, closed) — appeal() now
// persists this as a real DisputeAppealFee row, and resolveDispute()
// settles its outcome (FORFEITED on a denied/frivolous appeal, REFUNDED
// on an overturn). Same "computed and persisted, not actually routed
// on-chain" realness as the Protocol Fee accounting foundation already
// has (no SettlementProvider here has a real configured treasury/
// arbitrator-reserve address to send anything to). A real on-chain
// appeal-fee lock (the appellant actually posting collateral before the
// panel convenes) is a separate, larger undertaking blocked on the same
// missing treasury infrastructure the Protocol Fee itself already is —
// not attempted here.
export const APPEAL_FEE_MULTIPLIER = 2

export type ArbitrationProviderResolver = (implementation: string) => ArbitrationProvider

export class DisputeService {
  constructor(
    private readonly arbitrationProvider: ArbitrationProvider,
    private readonly repo: EscrowRepository = escrowRepository,
    private readonly arbitrationProviderResolver?: ArbitrationProviderResolver,
  ) {}

  private providerFor(implementation: string): ArbitrationProvider {
    return this.arbitrationProviderResolver?.(implementation) ?? this.arbitrationProvider
  }

  /**
   * Runtime instances use the rail-scoped resolver and therefore must read
   * Escrow.type before selecting arbitration authority. Directly-injected
   * unit/service instances intentionally preserve the historical injection
   * boundary: the injected provider is already the caller's explicit
   * arbitration context and must not acquire an unrelated database dependency.
   */
  private async providerForEscrow(escrowId: string): Promise<{
    provider: ArbitrationProvider
    escrow: Awaited<ReturnType<EscrowRepository['findById']>> | null
  }> {
    if (!this.arbitrationProviderResolver) {
      return { provider: this.arbitrationProvider, escrow: null }
    }

    const escrow = await this.repo.findById(escrowId)
    if (!escrow) throw new NotFoundError('Escrow', escrowId)
    return { provider: this.providerFor(escrow.type), escrow }
  }

  // Missão 11 Fase 7.3.1 §B — real P0 closed (Fase 7.3 audit): for an
  // escrow type whose settlement script immutably commits to a SPECIFIC
  // arbiter identity at creation time (MULTISIG today —
  // EscrowParticipantKey{role:'arbiter'}, write-once and DB-trigger-
  // protected, see that model's own migration), no OTHER identity is ever
  // cryptographically capable of executing a ruling on that script. Which
  // arbiter mode is configured (trusted-list round-robin, or market's
  // collateral-weighted draw) is irrelevant once a script commitment
  // exists — respecting it is not a policy choice, it is the only
  // outcome that can ever actually work. escrowParticipantKey is
  // deliberately NOT wrapped by EscrowRepository (a satellite table,
  // same deferred-scope decision documented in escrow-repository.ts's own
  // header), so this reads it directly, matching how this file already
  // reads Dispute/DisputeAppealFee via `prisma` rather than a repository.
  private async findCommittedArbiterId(escrowId: string): Promise<string | null> {
    const key = await prisma.escrowParticipantKey.findUnique({
      where: { escrowId_role: { escrowId, role: 'arbiter' } },
    })
    return key?.participantId ?? null
  }

  // Issue #266 — validates/resolves an OpenProof cross-reference
  // descriptor server-side before it is ever persisted; used by both
  // raiseDispute()'s initial evidence array and submitEvidence()'s
  // single descriptor, so the SAME guarantee holds regardless of entry
  // point (a caller could otherwise bypass this check entirely simply
  // by submitting the cross-reference at dispute-creation time instead
  // of via submitEvidence()).
  //
  // "Do not accept caller-supplied hash/provider/URI as authoritative
  // duplicates if OpenProof already owns those facts" (#266's own
  // frozen requirement) is why `uri` is rejected outright alongside
  // `evidenceReferenceId`, rather than silently ignored: OpenProof's
  // EvidenceReference already owns provider/uri/sha256 for this object,
  // so accepting a second, caller-supplied uri here would let a caller
  // forge or misrepresent it.
  //
  // CTO Gate re-gate — production eligibility for NEW writes. Absence
  // of a fabricated evidenceReferenceId is not itself an eligibility
  // rule: before this delta, ANY new `{type, uri, note}` descriptor
  // (including one that is really integrity-bound file/media evidence,
  // just submitted as a bare URI) was silently accepted and persisted.
  // `type` is an arbitrary caller string ('screenshot', 'payment_receipt',
  // whatever) — trusting it to infer "this is/isn't a file" would be
  // exactly the heuristic classification the CTO Gate explicitly
  // forbade (name/extension/URL-shape guessing, all fragile and
  // trivially bypassed). So every NEW raw-uri descriptor now requires an
  // EXPLICIT, non-inferred declaration instead: `externalReference: true`.
  // No flag and no evidenceReferenceId -> rejected outright, never
  // silently accepted as production-eligible. A HISTORICAL descriptor
  // (already persisted before this delta existed) is never touched or
  // reinterpreted by this rule — this function only ever runs on a NEW
  // write, never on data already in `Dispute.evidence`.
  private async resolveEvidenceDescriptor(
    descriptor: Pick<EvidenceDescriptor, 'type' | 'uri' | 'note' | 'evidenceReferenceId' | 'externalReference'>,
    tradeId: string
  ): Promise<Pick<EvidenceDescriptor, 'type' | 'uri' | 'note' | 'evidenceReferenceId' | 'externalReference'>> {
    if (descriptor.evidenceReferenceId) {
      if (descriptor.uri) {
        throw new ValidationError(
          'Evidence descriptor cannot include both uri and evidenceReferenceId — an OpenProof cross-reference is ' +
          'resolved server-side, never combined with a caller-supplied raw URI.'
        )
      }
      if (descriptor.externalReference) {
        throw new ValidationError(
          'Evidence descriptor cannot include both evidenceReferenceId and externalReference — these are the two ' +
          'mutually exclusive classes of new dispute evidence, never both at once.'
        )
      }
      // Lazy require, not a static top-of-file import — proof.service.ts's
      // module graph has real load-time side effects (a live Redis
      // client construction among them, via evidence-provider.ts/
      // timestamp-anchor.ts). A static import would drag that into
      // every test/dev-tool that loads dispute.service.ts even when
      // this cross-reference path is never exercised — the same
      // reasoning common/events/handlers.ts's own QVAC/dispute-service
      // requires already establish in this codebase.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { proofService } = require('../open-proof/proof.service') as typeof import('../open-proof/proof.service')
      await proofService.assertEvidenceReferenceBelongsToTrade(descriptor.evidenceReferenceId, tradeId)
      return { type: descriptor.type, note: descriptor.note, evidenceReferenceId: descriptor.evidenceReferenceId }
    }

    // The production-eligibility rule targets `uri` specifically — a raw
    // pointer is the one shape that could be mistaken for (or used to
    // smuggle in) file/media evidence. A uri-less descriptor (a pure
    // text note, always a valid EvidenceDescriptor shape, unchanged by
    // #266) has nothing that could masquerade as integrity-bound bytes,
    // so it is untouched by this rule either way.
    if (descriptor.uri && !descriptor.externalReference) {
      throw new ValidationError(
        'New dispute evidence with a raw uri must either reference OpenProof (evidenceReferenceId, for ' +
        'integrity-bound file/media evidence) or be explicitly declared as an external/non-file reference ' +
        '(externalReference: true) — a raw uri alone is not production-eligible.'
      )
    }
    // `externalReference: true` with no `uri` is a meaningless
    // declaration — there is nothing being referenced. Rejected
    // explicitly rather than silently accepted as an ambiguous
    // descriptor (CTO Gate re-gate, matrix case C).
    if (descriptor.externalReference && !descriptor.uri) {
      throw new ValidationError(
        'externalReference: true requires a uri — there is nothing to declare as an external reference without one.'
      )
    }
    return { type: descriptor.type, uri: descriptor.uri, note: descriptor.note, externalReference: descriptor.externalReference }
  }

  async raiseDispute(
    tradeId: string,
    raisedBy: string,
    reason: string,
    evidence: Pick<EvidenceDescriptor, 'type' | 'uri' | 'note' | 'evidenceReferenceId' | 'externalReference'>[] = []
  ) {
    const trade = await tradeRepository.findById(tradeId)
    if (!trade) throw new NotFoundError('Trade', tradeId)
    if (!trade.escrowId) throw new ValidationError(`Trade ${tradeId} has no escrow to dispute`)

    // CISO Byzantine Rule, applied here too: only the two actual
    // counterparties may raise a dispute on their own trade.
    if (raisedBy !== trade.buyerId && raisedBy !== trade.sellerId) {
      throw new ForbiddenError(`${raisedBy} is not a party to trade ${tradeId}`)
    }

    // Issue #266 — validate/resolve any OpenProof cross-references
    // BEFORE any state-changing call below, so a rejected cross-
    // reference (nonexistent, wrong-scope, or forged uri) never opens a
    // dispute with a half-applied side effect.
    const resolvedEvidence = await Promise.all(
      evidence.map((entry) => this.resolveEvidenceDescriptor(entry, tradeId))
    )

    // Freezes the trade — escrow.service.ts's real, existing state
    // transition (Escrow -> DISPUTED), not new logic written here.
    await escrowService.openDispute(trade.escrowId, raisedBy, reason)

    // Security-validation round (2026-07-19, "disputa dupla" scenario):
    // this create() reads-then-writes across two calls (this one and
    // openDispute() above) with no locking — buyer and seller calling
    // raiseDispute() concurrently could both pass every check above
    // before either write lands. The schema's new @@unique([tradeId])
    // on Dispute (see that model's own comment) is the actual guard: the
    // loser of the race hits a real P2002 here, caught and turned into a
    // clean rejection instead of a second, corrupting Dispute row —
    // same pattern reputation.service.ts's rate() already established
    // for its own unique-constraint race.
    let dispute
    try {
      dispute = await prisma.dispute.create({
        data: {
          tradeId,
          escrowId: trade.escrowId,
          openedBy: raisedBy,
          reason,
          evidence: resolvedEvidence as unknown as object,
          status: 'OPENED',
        },
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ValidationError(`A dispute has already been raised for trade ${tradeId}`)
      }
      throw err
    }

    // Fase 7.3.1 §B — a script-committed arbiter identity always wins
    // over the configured ArbitrationProvider's own independent pick;
    // assign() is only ever consulted for an escrow type with no such
    // commitment (see findCommittedArbiterId()'s own comment above).
    const { provider } = await this.providerForEscrow(trade.escrowId)
    const committedArbiterId = await this.findCommittedArbiterId(trade.escrowId)
    const arbiterId = committedArbiterId ?? (await provider.assign(dispute.id, tradeId))
    const updated = await prisma.dispute.update({
      where: { id: dispute.id },
      data: { arbiterId },
    })

    // Notification via pubsub (EventStore, RFC-010) — correlationId =
    // tradeId, the established convention for trade-lifecycle events.
    await eventBus.emit('dispute.opened', {
      disputeId: dispute.id,
      settlementId: trade.escrowId,
      tradeId,
      arbiterId,
      reason,
      triggeredBy: raisedBy,
    }, tradeId)

    return updated
  }

  /**
   * Missão 11 Fase 7.3.3 §D (CTO-selected: Model C + Model A) — the
   * explicit, guided participant recovery action for a MULTISIG escrow
   * whose timelock has genuinely expired (EscrowStatus.EXPIRED — see
   * schema.prisma's own comment and escrow.service.ts's
   * sweepExpiredEscrows()). Deliberately a THIN wrapper around the
   * already-existing raiseDispute() — invents no new authority, no new
   * signature, no new settlement mechanism. Its only real job is the
   * scenario-specific guard raiseDispute() itself doesn't have: requiring
   * the escrow to actually BE expired, and narrowing WHO may invoke it
   * for that specific reason.
   *
   * Authority (Fase 7.3.3 §C's own audit, not assumed): in the EXPIRED
   * state, the SELLER is the only party with real locked collateral at
   * stake — the buyer never paid on-chain and has no completed
   * obligation to enforce yet, so they have no legitimate expiry-recovery
   * claim (the general raiseDispute() endpoint remains available to
   * either party for any OTHER reason, unchanged). This does not
   * apply to a PAYMENT_PENDING escrow (a genuine payment dispute, where
   * the buyer may have the stronger claim) — VALID_TRANSITIONS never
   * lets a PAYMENT_PENDING escrow reach EXPIRED, so that state can never
   * reach this method at all.
   *
   * NO SERVER IMPERSONATION: raisedBy is always the real, authenticated
   * caller — never a fabricated or borrowed identity. NO SERVER CUSTODY
   * OF KEYS: this call persists a Dispute row and assigns an arbiter,
   * exactly like raiseDispute() always has — it never touches a
   * signature or a private key.
   */
  async initiateExpiryRecovery(escrowId: string, raisedBy: string) {
    const escrow = await this.repo.findById(escrowId)
    if (!escrow) throw new NotFoundError('Escrow', escrowId)
    if (escrow.status !== 'EXPIRED') {
      throw new ValidationError(
        `Escrow ${escrowId} is not in EXPIRED status (current: ${escrow.status}) — expiry recovery is only available once this escrow's own timelock has genuinely passed with no cooperative resolution.`
      )
    }

    const trade = await tradeRepository.findById(escrow.tradeId)
    if (!trade) throw new NotFoundError('Trade', escrow.tradeId)
    if (!isPartyOrAgent(asTrustedActor(raisedBy), trade.sellerId)) {
      throw new ForbiddenError(
        `${raisedBy} is not the seller of trade ${trade.id} — expiry recovery for an EXPIRED escrow is a seller-only action, since the seller is the only party with locked collateral at stake in this state.`
      )
    }

    return this.raiseDispute(
      trade.id,
      raisedBy,
      'Escrow timelock expired with no cooperative resolution — seller-initiated expiry recovery (Missão 11 Fase 7.3.3).'
    )
  }

  async getDispute(disputeId: string) {
    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } })
    if (!dispute) throw new NotFoundError('Dispute', disputeId)
    return dispute
  }

  // UI-audit gap (2026-08-03, sails-ui SLC audit relayed via the parallel
  // UI session): every existing read path here was scoped to a trade
  // party (getDispute by id above still has no participant check, same
  // "escrow.service.ts's getEscrow() is a public read" precedent), but
  // nothing let an arbiter discover which disputes are actually assigned
  // to them — the resolve/appeal/evidence/contest actions above were all
  // real and callable, they just had no corresponding fetch to find a
  // disputeId to call them with. This is that fetch: scoped to the
  // calling participant's own arbiterId only (never an arbitrary
  // `?arbiterId=` from the query string — same "scoped to whoever is
  // actually authenticated, not whoever the caller claims to be" rule
  // trade.service.ts's getTrades()/liquidity.service.ts's getMyOffers()
  // already follow), so this can't be used to enumerate another
  // arbiter's caseload.
  async listForArbiter(arbiterId: string, pagination?: { limit?: number; offset?: number }) {
    const limit = Math.min(Math.max(pagination?.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT)
    const offset = Math.max(pagination?.offset ?? 0, 0)

    const where = { arbiterId }

    const [disputes, total] = await Promise.all([
      prisma.dispute.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.dispute.count({ where }),
    ])

    return { disputes, total, hasMore: offset + disputes.length < total }
  }

  // Extracted from resolveDispute() (RFC-021 D8, 2026-08-02) so
  // sweepExpiredAutoResolutions() below can reuse the exact same
  // mechanical release/refund + revert-on-failure logic — including the
  // hard-won ordering fix in its own comment — without duplicating it.
  // Shared by both the human-ruling path and the QVAC auto-resolution
  // path; slashing/recordRuling/appeal-fee settlement are NOT here — those
  // are specific to a human arbiter's own track record and stay in
  // resolveDispute() itself.
  // Sails Core Implementation Program M8-R2 (Destination Authority
  // Conformance, disputed rails, 2026-09-11,
  // docs/DESTINATION_AUTHORITY_ARCHITECTURE.md) — `releaseToAddress`/
  // `refundToAddress` REMOVED from this method's own parameters (unlike
  // the public `resolveDispute()`, this is a private method with exactly
  // one call site — resolveDispute() itself — so removing them here is a
  // safe, non-breaking, purely internal cleanup, not the "large
  // mechanical rename" that same public method's own comment explains
  // for why ITS signature stays unchanged). This method now always lets
  // `escrowService`'s own `resolvePayoutAddress()` resolve each
  // beneficiary's destination from their registered `PayoutAddress` —
  // exactly the same beneficiary-controlled, durably-bound-at-initiate-
  // time path M8-R2's cooperative-release fix already proved correct
  // (tests/escrowPendingReleaseDestinationBinding.test.ts), now reached
  // by every rail this method still handles (LIGHTNING_HODL/
  // SAFE_GUARD_EVM/WDK_USDT_EVM/MOCK — MULTISIG has used
  // `applyRulingCoreAuthoritative()` exclusively since M8-R). An
  // arbiter's ruling decides economic disposition only; it never again
  // carries any destination-authority channel for these rails either.
  private async applyRuling(
    dispute: { id: string; escrowId: string; tradeId: string; status: string },
    ruling: DisputeRuling,
    triggeredBy: string,
    splitBuyerBps?: number,
    // Missão 13 Fase 2 — present only for a caller that has already
    // independently verified an authority decision (resolveDispute()).
    // Never populated by anything else — in particular,
    // sweepExpiredAutoResolutions() (below) no longer calls this method
    // at all, exactly because it has no verified authority to attach.
    authority?: { authoritySignature: string; authorityIssuedAt: Date; authorityBuyerBps: number | null }
  ) {
    // Real bug found by tests/fullTradeLifecycle.test.ts (end-to-end
    // chain, added investigating the CTO-role "validate the full flow"
    // follow-up): this used to call escrowService.releaseFunds()/
    // refundFunds() BEFORE marking the Dispute RESOLVED below. Those
    // calls emit settlement.escrow.released/refunded, which
    // common/events/handlers.ts reacts to with RFC-007 D8/D9's
    // dispute-aware branch — a query for a Dispute row with
    // `status: 'RESOLVED'` on this exact tradeId. That query always
    // raced this function's own not-yet-run update() below and lost:
    // every disputed resolution was silently scored as an ordinary
    // no-dispute outcome (both parties POSITIVE/NEUTRAL) instead of the
    // asymmetric win/loss RFC-007 D8/D9 specifies. Fixed by marking
    // RESOLVED first; if the fund movement then fails, the ruling is
    // reverted rather than left claiming a resolution that never
    // actually moved funds.
    //
    // ADR-005 §10 — this used to be an unconditional `prisma.dispute.update()`
    // by id alone: the exact "old-arbiter in-flight race" family ADR-005
    // requires closed. resolveDispute()'s own top-level check (dispute.status
    // !== 'RESOLVED' && dispute.arbiterId === arbiterId) read the row BEFORE
    // this method was ever called — a concurrent appeal() landing between
    // that read and this write could previously still let a stale arbiter's
    // ruling commit RESOLVED over a dispute appeal() had already reassigned.
    // Now: the same `economic-disposition:<disputeId>` lock scope appeal()
    // and the Economic Disposition Commit Gate use (ADR-005 §3) serializes
    // this write too, and the write itself is a conditional claim re-checked
    // AFTER acquiring the lock — never a bare re-use of the pre-lock read.
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${economicDispositionLockKey(dispute.id)})::bigint)`

      const claim = await tx.dispute.updateMany({
        where: { id: dispute.id, status: { not: 'RESOLVED' }, arbiterId: triggeredBy },
        data: {
          status: 'RESOLVED',
          ruling,
          resolvedAt: new Date(),
          ...(authority
            ? {
                authoritySignature: authority.authoritySignature,
                authorityIssuedAt: authority.authorityIssuedAt,
                authorityBuyerBps: authority.authorityBuyerBps,
              }
            : {}),
        },
      })
      if (claim.count === 0) {
        throw new ValidationError(
          `Dispute ${dispute.id} is no longer authorized for a ruling from ${triggeredBy} — its economic disposition authority ` +
          'has already changed (resolved, appealed, or reassigned) since this ruling was requested.'
        )
      }
      const row = await tx.dispute.findUnique({ where: { id: dispute.id } })
      if (!row) throw new NotFoundError('Dispute', dispute.id)
      return row
    })

    try {
      // Second real bug found while building SPLIT (RFC-021 D9,
      // 2026-08-02) — see escrowService.isSignatureCollectionType()'s own
      // comment for the full story: MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM
      // escrows need the client-signature-collection flow
      // (initiateRelease/initiateRefund/initiateSplit), not the direct
      // releaseFunds()/refundFunds()/splitFunds() calls those types'
      // providers throw "not directly callable" from. Applies uniformly to
      // all three rulings now, not just the new one.
      const escrow = await this.repo.findById(dispute.escrowId)
      if (!escrow) throw new NotFoundError('Escrow', dispute.escrowId)
      const needsSignatureCollection = escrowService.isSignatureCollectionType(escrow.type)

      // M8-R2 — every call below passes `undefined` where a destination
      // parameter exists, on purpose: escrowService's own
      // resolvePayoutAddress() (escrow-lifecycle.ts) then always resolves
      // the beneficiary's registered PayoutAddress, exactly the same
      // beneficiary-controlled path the cooperative release fix already
      // proved durably-bound-before-signing and rotation/retry-immune.
      // This ruling decided WHO is entitled and HOW MUCH — never WHERE.
      if (ruling === 'RELEASE') {
        if (needsSignatureCollection) {
          await escrowService.initiateRelease(dispute.escrowId, undefined, triggeredBy)
        } else {
          await escrowService.releaseFunds(dispute.escrowId, undefined, triggeredBy)
        }
      } else if (ruling === 'REFUND') {
        if (needsSignatureCollection) {
          await escrowService.initiateRefund(dispute.escrowId, triggeredBy, undefined)
        } else {
          await escrowService.refundFunds(dispute.escrowId, triggeredBy)
        }
      } else if (ruling === 'SPLIT') {
        // RFC-021 D9 — the third §1.9 option finally has a real settlement
        // action, for the escrow types that can actually represent a
        // partial payout (MOCK, WDK_USDT_EVM, MULTISIG). SAFE_GUARD_EVM's
        // immutable Guard contract and LIGHTNING_HODL's fixed-leaf
        // VtxoScript each have a real, provider-specific reason they
        // can't — see their own buildUnsignedSplit() overrides — surfaced
        // here as a normal thrown error (reverting this ruling below), not
        // silently no-op'd. Buyer and seller destinations are resolved
        // INDEPENDENTLY, each from their own registered PayoutAddress
        // (escrowService.initiateSplit()/splitFunds()'s own two separate
        // resolvePayoutAddress() calls) — never collapsed into one value.
        if (splitBuyerBps === undefined) {
          throw new ValidationError('SPLIT requires splitBuyerBps')
        }
        if (needsSignatureCollection) {
          await escrowService.initiateSplit(dispute.escrowId, undefined, undefined, splitBuyerBps, triggeredBy)
        } else {
          await escrowService.splitFunds(dispute.escrowId, undefined, undefined, splitBuyerBps, triggeredBy)
        }
      }
    } catch (err) {
      // CTO Gate R2 (#222) finding R2-1 — this revert used to be an
      // unconditional `prisma.dispute.update()` by id alone, running
      // AFTER the resolve-write's own lock already released (the provider
      // call above is real I/O and must never run while holding a DB
      // advisory lock). That left a genuine window: the resolve-write
      // commits RESOLVED, the lock releases, the provider call begins,
      // a concurrent appeal() acquires the SAME lock and advances the
      // dispute to a newer generation, the provider call then fails, and
      // this catch's unconditional update would stomp the newer
      // generation's status/arbiter/ruling back to this call's own
      // pre-resolve values — exactly the "old authority overwrites newer
      // generation" defect ADR-005 exists to prevent, now via the
      // rollback path instead of the primary write path.
      //
      // Fixed the same way the resolve-write itself was: re-acquire the
      // `economic-disposition:<disputeId>` lock and revert via a
      // conditional claim that proves the row is STILL exactly the
      // generation this call committed (status/ruling/arbiter/appealRound,
      // plus the signed authority identity when one was verified) before
      // touching it. If a newer generation already won — appeal()
      // serialized first — this revert does nothing at all: the newer
      // generation's own state stands, and this call's own (now
      // irrelevant) provider failure is still reported to the caller.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${economicDispositionLockKey(dispute.id)})::bigint)`

        await tx.dispute.updateMany({
          where: {
            id: dispute.id,
            status: 'RESOLVED',
            ruling,
            arbiterId: triggeredBy,
            appealRound: updated.appealRound,
            ...(authority ? { authoritySignature: authority.authoritySignature } : {}),
          },
          data: {
            status: dispute.status as DisputeStatus,
            ruling: null,
            resolvedAt: null,
            // Missão 13 Fase 2 — a reverted ruling never leaves a verified
            // authority decision attached to a dispute that in fact never
            // settled; the arbiter must re-submit (their real decision may
            // legitimately change once the underlying failure is understood).
            ...(authority ? { authoritySignature: null, authorityIssuedAt: null, authorityBuyerBps: null } : {}),
          },
        })
        // A count of 0 here means a newer generation already won — never
        // logged as an error and never retried: the correct outcome IS
        // "do nothing," not a failure of the revert itself.
      })
      throw err
    }

    await eventBus.emit('dispute.resolved', {
      disputeId: dispute.id,
      settlementId: dispute.escrowId,
      tradeId: dispute.tradeId,
      ruling,
      triggeredBy,
    }, dispute.tradeId)

    return updated
  }

  /**
   * Sails Core Implementation Program M8-R (Live Dispatch Retry) — the
   * Core-authoritative replacement for `applyRuling()` above, used ONLY
   * for MULTISIG (`docs/DESTINATION_AUTHORITY_ARCHITECTURE.md`,
   * `docs/M8_DISPATCH_GATE_FINDINGS.md`). LIGHTNING_HODL/SAFE_GUARD_EVM/
   * MOCK/WDK_USDT_EVM disputes remain on `applyRuling()` — this mission's
   * own scope was Mission13 MULTISIG disputed settlement, no other rail
   * (mission §2/§38); it deliberately did not touch `applyRuling()`.
   * **Note (M8-R2, 2026-09-11):** `applyRuling()` is no longer
   * byte-for-byte what it was here — a later, separate mission extended
   * Destination Authority conformance (never Economic Disposition
   * Authority/dispatch semantics, which stay exactly as M8-R left them)
   * to the four rails `applyRuling()` still handles. See its own header
   * comment for that mission's full scope.
   *
   * `releaseToAddress`/`refundToAddress` are DELIBERATELY ABSENT from
   * this method's parameters — see `resolveDispute()`'s own comment for
   * why they remain accepted-but-inert at that call site rather than
   * being removed from the public route/SDK surface.
   *
   * Ordering (mission §13, proofs P19-P22): durable semantic commit
   * (attribution + Outcome + destination snapshot, one Postgres
   * transaction, `commitAuthoritativeDisputeRuling()`) STRICTLY
   * PRECEDES dispatch-eligibility evaluation, which STRICTLY PRECEDES
   * calling any settlement action. The eligibility check re-loads the
   * record from the database (`assertDisputeDispatchEligible()`) rather
   * than reusing anything built in this call stack — proving persistence
   * governs, not transient request memory.
   */
  private async applyRulingCoreAuthoritative(
    dispute: { id: string; escrowId: string; tradeId: string; status: string; appealRound: number },
    payload: AuthorityDecisionPayload,
    authoritySignature: string,
    resolvedArbiterPublicKeyHex: string,
    buyerId: string,
    sellerId: string,
    lockedAmount: Prisma.Decimal,
    asset: AssetType,
  ) {
    const totalUnits = lockedAmount.times(1e8).toFixed(0)
    const commitResult = await commitAuthoritativeDisputeRuling(
      dispute, payload, authoritySignature, resolvedArbiterPublicKeyHex, totalUnits, asset, buyerId, sellerId,
    )
    if (!commitResult.committed) {
      if (commitResult.reason === 'NOT_ATTRIBUTED') {
        throw new ForbiddenError(
          `Authority decision signature does not verify against ${payload.authorityId}'s registered public key for dispute ${dispute.id} — ` +
          'refusing to execute a discretionary settlement attributed to an authorization that cannot be independently verified (INV-12).'
        )
      }
      throw new ValidationError(`Dispute ${dispute.id} is already resolved`)
    }

    try {
      const record = await assertDisputeDispatchEligible(dispute.escrowId, dispute.appealRound)
      const outcome = record.outcome!
      const network = networkFor(config.multisig.network)
      const buyerDestination = commitResult.destinations.find((d) => d.beneficiary === buyerId)?.destination
      const sellerDestination = commitResult.destinations.find((d) => d.beneficiary === sellerId)?.destination

      let pending: { unsignedPsbtBase64: string; minerFeeSats: number | null }
      if (payload.outcome === 'RELEASE') {
        pending = await escrowService.initiateRelease(dispute.escrowId, buyerDestination, payload.authorityId)
      } else if (payload.outcome === 'REFUND') {
        // M8-RF (Destination Consistency) — sellerDestination is the
        // seller's OWN historical DestinationBinding, already resolved
        // and committed atomically with the Outcome above
        // (commitAuthoritativeDisputeRuling() -> resolveBeneficiaryDestination()).
        // Passing it here (previously silently dropped) is what makes
        // the real Bitcoin translation match what the Outcome already
        // authorized — never re-derived from the seller's multisig
        // signing key, never re-read from current PayoutAddress state.
        pending = await escrowService.initiateRefund(dispute.escrowId, payload.authorityId, sellerDestination)
      } else {
        pending = await escrowService.initiateSplit(dispute.escrowId, buyerDestination, sellerDestination, payload.buyerBps!, payload.authorityId)
      }

      try {
        assertTranslationMatchesOutcome(pending.unsignedPsbtBase64, outcome, network, pending.minerFeeSats ?? undefined)
      } catch (guardErr) {
        // The translator produced something that does not correspond to
        // the authoritative Outcome — never let it sit collectable for
        // signature. Deleting the just-created pending row is what
        // actually blocks dispatch (mission §19: "blocked before
        // broadcast if translated intent is inspectable" — it was, and
        // this is the block).
        await prisma.escrowPendingTransaction.deleteMany({ where: { escrowId: dispute.escrowId } })
        throw guardErr
      }
    } catch (err) {
      // Same revert discipline as applyRuling()'s own catch above,
      // extended to also delete the durable Core record this method
      // additionally created — a reverted ruling must never leave a
      // dangling Core authorization behind (dispute-outcome.ts's own
      // header comment).
      //
      // CTO Gate R2 (#222) finding R2-1 — same fix as applyRuling()'s own
      // catch block above: this used to be an unconditional update by id
      // alone, running after commitAuthoritativeDisputeRuling()'s own lock
      // already released and after real provider/dispatch I/O — a
      // concurrent appeal() could win the same `economic-disposition:
      // <disputeId>` lock in between and advance the generation before
      // this revert runs. Re-acquiring the lock and conditionally
      // claiming the exact generation this call committed (status/ruling/
      // arbiter/appealRound/authoritySignature) means a newer generation
      // is never overwritten; if one already won, this revert is a no-op
      // and the newer generation's state stands untouched.
      // revertDisputeRulingRecord() below is already appealRound-scoped
      // by its own unique key and needs no such guard.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${economicDispositionLockKey(dispute.id)})::bigint)`

        await tx.dispute.updateMany({
          where: {
            id: dispute.id,
            status: 'RESOLVED',
            ruling: payload.outcome,
            arbiterId: payload.authorityId,
            appealRound: dispute.appealRound,
            authoritySignature,
          },
          data: { status: dispute.status as DisputeStatus, ruling: null, resolvedAt: null, authoritySignature: null, authorityIssuedAt: null, authorityBuyerBps: null },
        })
      })
      await revertDisputeRulingRecord(dispute.escrowId, dispute.appealRound)
      throw err
    }

    await eventBus.emit('dispute.resolved', {
      disputeId: dispute.id,
      settlementId: dispute.escrowId,
      tradeId: dispute.tradeId,
      ruling: payload.outcome,
      triggeredBy: payload.authorityId,
    }, dispute.tradeId)

    return prisma.dispute.findUnique({ where: { id: dispute.id } })
  }

  async resolveDispute(
    disputeId: string,
    arbiterId: string,
    ruling: DisputeRuling,
    // Buyer's payout address for RELEASE/SPLIT. Optional as of
    // 2026-08-04 (BACKLOG.md's "Participant payout address" gap,
    // closed): if omitted, escrowService.releaseFunds()/splitFunds()'s
    // own resolvePayoutAddress() falls back to the buyer's registered
    // PayoutAddress for the escrow's asset, throwing its own clear error
    // only if neither exists — this method no longer pre-validates
    // presence, since "missing" is no longer necessarily an error.
    //
    // @deprecated for EVERY rail (Sails Core Implementation Program
    // M8-R, 2026-08-30, extended M8-R2, 2026-09-11 —
    // docs/DESTINATION_AUTHORITY_ARCHITECTURE.md). This value is now
    // COMPLETELY INERT regardless of escrow type — the beneficiary's own
    // registered PayoutAddress is the ONLY destination that governs
    // execution (Economic Disposition Authority — this ruling's own
    // outcome/bps — is distinct from Destination Authority, which
    // belongs to the beneficiary alone, never the arbiter's own
    // request). For MULTISIG this is snapshotted atomically into the
    // durable authoritative Outcome (`applyRulingCoreAuthoritative()`);
    // for LIGHTNING_HODL/SAFE_GUARD_EVM/WDK_USDT_EVM/MOCK it's resolved
    // fresh at settlement time by `applyRuling()`'s own unchanged
    // `resolvePayoutAddress()` fallback — different mechanism, same
    // property (never the arbiter's own supplied value). Deliberately
    // NOT removed from this signature: this SDK is workspace-internal
    // and unpublished, but 61+ files (SDK, e2e tests, examples, unit
    // tests) already call this method positionally — eliminating the
    // parameter outright would be a large, purely mechanical rename
    // exercise disproportionate to what either mission's own bounded
    // mandate requires, and it would not have made the destination MORE
    // authoritative, only differently shaped. Ambiguity is closed the
    // way M8-R's own §5 required: not silently — see
    // tests/destinationAuthorityDisputedRails.test.ts's own "arbiter-
    // supplied destination is ignored" cases, covering all five rails.
    // **Correction, M8-R2:** the prior text here read "Still fully
    // authoritative for LIGHTNING_HODL/SAFE_GUARD_EVM disputes
    // (unmigrated, out of this mission's scope)" — no longer true, and
    // its own citation of `tests/disputeOutcomeMultisig.test.ts` was
    // already stale before this correction (no file by that exact name
    // exists in this repository).
    releaseToAddress: string | undefined,
    // RFC-021 D9 (2026-08-02) — seller's payout address for SPLIT only
    // (mirrors releaseToAddress's buyer role), same fallback as above.
    // splitBuyerBps has no such fallback — it's a ruling decision, not an
    // address, so it's still required up front for SPLIT.
    //
    // @deprecated for every rail — see releaseToAddress's own comment above; identical status.
    refundToAddress: string | undefined,
    splitBuyerBps: number | undefined,
    // Missão 13 Fase 2 — INV-12 closure. Required, never optional: the
    // caller-supplied `arbiterId` above is only an identity CLAIM,
    // authenticated no more strongly than the session token that made
    // this HTTP request — exactly the gap Missão 12/13 found (the
    // "record of decision" lived only in this server's own database,
    // never independently checkable). `authoritySignature` must verify
    // against `arbiterId`'s own already-registered `User.publicKey`
    // (arbitration-authority.ts, the same Ed25519 identity every
    // participant already has — no new key type) over the EXACT economic
    // disposition being requested here. `authorityIssuedAt` is the
    // client-signed timestamp bound into that same signature — passed
    // separately because it must be supplied verbatim to reconstruct the
    // canonical string that was actually signed.
    authoritySignature: string,
    authorityIssuedAt: string
  ) {
    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } })
    if (!dispute) throw new NotFoundError('Dispute', disputeId)
    if (dispute.status === 'RESOLVED') {
      throw new ValidationError(`Dispute ${disputeId} is already resolved`)
    }
    if (dispute.arbiterId !== arbiterId) {
      throw new ForbiddenError(`${arbiterId} is not the arbiter assigned to dispute ${disputeId}`)
    }

    if (ruling === 'SPLIT' && splitBuyerBps === undefined) {
      throw new ValidationError('splitBuyerBps is required when ruling is SPLIT')
    }

    // FAIL CLOSED — no path below this point ever falls back to trusting
    // the bare `ruling`/`arbiterId` request body on its own. Missão 13
    // Fase 2 Task 12's own explicit prohibition: "no fallback to DB
    // assertion... if signature missing, trust stored outcome" is exactly
    // the violation this closes.
    const authority = await prisma.user.findUnique({ where: { id: arbiterId } })
    if (!authority) throw new NotFoundError('User', arbiterId)

    const payload: AuthorityDecisionPayload = {
      disputeId,
      escrowId: dispute.escrowId,
      appealRound: dispute.appealRound,
      authorityId: arbiterId,
      outcome: ruling,
      buyerBps: ruling === 'SPLIT' ? splitBuyerBps! : null,
      issuedAt: authorityIssuedAt,
    }
    const sigValid = verifyAuthorityDecisionSignature(payload, authoritySignature, authority.publicKey)
    if (!sigValid) {
      throw new ForbiddenError(
        `Authority decision signature does not verify against ${arbiterId}'s registered public key for dispute ${disputeId} — ` +
        'refusing to execute a discretionary settlement attributed to an authorization that cannot be independently verified (INV-12).'
      )
    }
    // Execution-correspondence boundary (Missão 13 Fase 2 Task 13) — the
    // single place every path that attributes a disposition to a
    // discretionary authority checks it, before any settlement call.
    // Here `payload` IS `requested` (they were built from the same
    // values) — the check still runs so this remains the one function
    // every caller goes through, not a special-cased inline comparison.
    assertExecutionMatchesAuthorization(payload, payload)

    // Sails Core Implementation Program M8-R — Mission13 MULTISIG
    // disputed settlement only (mission §2/§38: "no other rail").
    // LIGHTNING_HODL/SAFE_GUARD_EVM/MOCK/WDK_USDT_EVM disputes fall
    // through to applyRuling() below — this remains a deliberate, narrow
    // routing boundary (docs/DESTINATION_AUTHORITY_ARCHITECTURE.md §16),
    // but as of M8-R2 (2026-09-11) both branches now equally ignore any
    // caller-supplied releaseToAddress/refundToAddress for destination
    // purposes — see applyRuling()'s own updated header comment.
    const escrowForBranch = await this.repo.findById(dispute.escrowId)
    if (!escrowForBranch) throw new NotFoundError('Escrow', dispute.escrowId)

    let updated
    if (escrowForBranch.type === 'MULTISIG') {
      const trade = await tradeRepository.findById(dispute.tradeId)
      if (!trade) throw new NotFoundError('Trade', dispute.tradeId)
      updated = await this.applyRulingCoreAuthoritative(
        dispute,
        payload,
        authoritySignature,
        authority.publicKey,
        trade.buyerId,
        trade.sellerId,
        new Prisma.Decimal(escrowForBranch.lockedAmount),
        escrowForBranch.asset as AssetType,
      )
    } else {
      // M8-R2 — releaseToAddress/refundToAddress deliberately NOT passed
      // through: applyRuling() no longer accepts them at all (see its own
      // header comment). Still accepted by this public method's own
      // signature below for source compatibility; still inert now for
      // every rail, not just MULTISIG.
      updated = await this.applyRuling(
        dispute,
        ruling,
        arbiterId,
        splitBuyerBps,
        { authoritySignature, authorityIssuedAt: new Date(authorityIssuedAt), authorityBuyerBps: payload.buyerBps }
      )
    }

    await this.finalizeResolveDispute(dispute, arbiterId, ruling)
    return updated
  }

  /**
   * The post-settlement bookkeeping shared by BOTH the Core-authoritative
   * (MULTISIG) and legacy (`applyRuling()`) paths — arbiter track record,
   * appeal-slashing, and appeal-fee settlement. Extracted unchanged
   * (mission M8-R) so neither path duplicates it and both stay
   * byte-for-byte identical in behavior to before this migration.
   */
  private async finalizeResolveDispute(
    dispute: { id: string; escrowId: string; appealRound: number; previousRuling: DisputeRuling | null; previousArbiterId: string | null },
    arbiterId: string,
    ruling: DisputeRuling,
  ): Promise<void> {
    const { provider, escrow: providerEscrow } = await this.providerForEscrow(dispute.escrowId)
    // RFC-021 D6/D4 — feeds the arbiter's track record on every real
    // resolution, correct or not (optional: only market mode has an
    // ArbiterProfile to update; trusted-list mode silently skips this).
    // feeObserved reads the escrow fresh — a RELEASE ruling's
    // escrowService.releaseFunds() call above has already computed and
    // persisted Escrow.feeCharged (Phase 0) by this point; REFUND never
    // charges a fee, so this is correctly undefined for those.
    if (provider.recordRuling) {
      // Runtime resolution already loaded the escrow to choose the effective
      // rail policy. Direct provider injection keeps the old best-effort
      // accounting read instead of making repository availability a new
      // prerequisite for every test/caller.
      const resolvedEscrow = providerEscrow ?? await this.repo.findById(dispute.escrowId)
      const feeObserved = resolvedEscrow?.feeCharged ? String(resolvedEscrow.feeCharged) : undefined
      await provider.recordRuling(arbiterId, feeObserved)
    }

    // RFC-021 D6 — an appeal round reversing the ruling being appealed is
    // real evidence the original arbiter got it wrong; slash them.
    // `dispute` here is the pre-update fetch at the top of resolveDispute(),
    // so previousRuling/previousArbiterId still reflect whatever appeal()
    // set them to before this resolution — untouched by the RESOLVED
    // write above. If the appeal panel reaches the SAME ruling, the
    // appeal is denied and nothing is slashed (the requester's already-
    // computed appealFeeRequired was the real cost of a frivolous
    // appeal).
    if (
      dispute.previousRuling &&
      dispute.previousRuling !== ruling &&
      dispute.previousArbiterId &&
      provider.slash
    ) {
      await provider.slash(dispute.previousArbiterId)
    }

    // RFC-021 D6 — real appeal-fee settlement, closing the "computed and
    // returned but never collected" gap (appeal()'s own doc comment,
    // BACKLOG.md). Only appealed disputes (appealRound > 0) have a fee
    // row to settle at all. Same comparison the slashing check above
    // already makes: the appeal panel reaching the SAME ruling means the
    // appeal was denied (frivolous) — FORFEITED, the real cost this fee
    // exists to impose; a different ruling means the appellant was right
    // to appeal — REFUNDED. Real bookkeeping, not a simulated one — same
    // "computed and persisted, not actually routed on-chain" precedent
    // the Protocol Fee accounting foundation already established: no
    // SettlementProvider here has a real configured treasury/arbitrator-
    // reserve address to move anything to.
    if (dispute.appealRound > 0) {
      const outcome = dispute.previousRuling && dispute.previousRuling !== ruling ? 'REFUNDED' : 'FORFEITED'
      await prisma.disputeAppealFee.updateMany({
        where: { disputeId: dispute.id, appealRound: dispute.appealRound, outcome: null },
        data: { outcome, settledAt: new Date() },
      })
    }
  }

  /**
   * RFC-021 D6 — reopens a RESOLVED dispute for a new arbiter, drawn from
   * a reputation-weighted appeal panel (assignAppealPanel(), growing with
   * round count). Only meaningful under ARBITRATION_MODE=market — the
   * configured provider must implement assignAppealPanel(); a
   * TrustedArbitratorProvider deployment gets a clear config error
   * instead of a silent no-op.
   */
  async appeal(disputeId: string, requestedBy: string) {
    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } })
    if (!dispute) throw new NotFoundError('Dispute', disputeId)
    if (dispute.status !== 'RESOLVED') {
      throw new ValidationError(
        `Dispute ${disputeId} cannot be appealed from status ${dispute.status} — only a RESOLVED dispute can be appealed`
      )
    }

    const trade = await tradeRepository.findById(dispute.tradeId)
    if (!trade) throw new NotFoundError('Trade', dispute.tradeId)
    if (requestedBy !== trade.buyerId && requestedBy !== trade.sellerId) {
      throw new ForbiddenError(`${requestedBy} is not a party to trade ${dispute.tradeId}`)
    }

    // Fase 7.3.1 §B — an escrow whose script committed one specific
    // arbiter identity at creation time cannot ever be reassigned to a
    // different one: no signature from any other identity will validate
    // against that script, appeal panel or not. This is a cryptographic
    // fact, not an arbitration-mode setting, so it is checked before (and
    // independently of) the assignAppealPanel/market-mode check below.
    const committedArbiterId = await this.findCommittedArbiterId(dispute.escrowId)
    if (committedArbiterId) {
      throw new ValidationError(
        `Dispute ${disputeId}'s escrow has an immutable, script-committed arbiter identity (${committedArbiterId}) — ` +
        'this settlement rail cannot reassign arbitration authority to a different identity after the fact, so no ' +
        'appeal panel could ever produce a ruling capable of executing. Appeals are only supported for escrow types ' +
        'with no pre-committed signing arbiter.'
      )
    }

    const { provider, escrow: providerEscrow } = await this.providerForEscrow(dispute.escrowId)

    if (!provider.assignAppealPanel) {
      const implementationContext = providerEscrow ? ` for settlement implementation ${providerEscrow.type}` : ''
      throw new ValidationError(
        `Appeals require ARBITRATION_MODE=market (effective market arbitration${implementationContext}) — ${provider.name} does not support appeal panels`
      )
    }

    // Appeal-fee accounting genuinely needs escrow economic data even for
    // direct provider injection. Runtime rail-scoped resolution already
    // loaded it; direct callers retain the historical lazy read here.
    const escrow = providerEscrow ?? await this.repo.findById(dispute.escrowId)
    if (!escrow) throw new NotFoundError('Escrow', dispute.escrowId)

    const nextRound = dispute.appealRound + 1
    const newArbiterId = await provider.assignAppealPanel(
      disputeId,
      dispute.tradeId,
      nextRound,
      dispute.arbiterId ?? undefined
    )

    const baseFee = escrow.feeCharged ? Number(escrow.feeCharged) : 0
    const appealFeeRequired = (baseFee * APPEAL_FEE_MULTIPLIER).toFixed(8)

    // ADR-005 §3/§10 — the actual authority-moving write. Locked and
    // re-checked against the SAME `economic-disposition:<disputeId>` scope
    // the disputed-ruling resolve-write and the Economic Disposition
    // Commit Gate use, so appeal() and a concurrent stale-generation
    // execution attempt get one deterministic winner: whichever side
    // serializes first here wins this dispute's next generation; the
    // loser's own conditional claim (applyRuling()'s updateMany, or the
    // Commit Gate's live-dispute comparison) observes the result and fails
    // closed. The top-level `dispute.status !== 'RESOLVED'`/appealRound
    // read above is pre-lock and therefore only a fail-fast — this
    // re-check, taken AFTER acquiring the lock, is what is actually
    // race-safe.
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${economicDispositionLockKey(disputeId)})::bigint)`

      const claim = await tx.dispute.updateMany({
        where: { id: disputeId, status: 'RESOLVED', appealRound: dispute.appealRound },
        data: {
          status: 'APPEALED',
          appealRound: nextRound,
          previousRuling: dispute.ruling,
          previousArbiterId: dispute.arbiterId,
          arbiterId: newArbiterId,
          ruling: null,
          resolvedAt: null,
        },
      })
      if (claim.count === 0) {
        throw new ValidationError(
          `Dispute ${disputeId} can no longer be appealed from the generation this request was built against — ` +
          'a concurrent resolution or appeal has already changed its current economic disposition authority.'
        )
      }

      // The fee belongs to the generation that actually became authoritative.
      // Persist it inside the same transaction as the locked authority claim:
      // a losing concurrent appeal creates no orphan fee, and a fee-write
      // failure rolls the APPEALED transition back atomically.
      await tx.disputeAppealFee.create({
        data: {
          disputeId,
          appealRound: nextRound,
          requestedBy,
          amount: appealFeeRequired,
          asset: (escrow.asset ?? 'BTC') as AssetType,
        },
      })

      const row = await tx.dispute.findUnique({ where: { id: disputeId } })
      if (!row) throw new NotFoundError('Dispute', disputeId)
      return row
    })

    await eventBus.emit('dispute.appealed', {
      disputeId,
      settlementId: dispute.escrowId,
      tradeId: dispute.tradeId,
      round: nextRound,
      newArbiterId,
      previousArbiterId: dispute.arbiterId,
      triggeredBy: requestedBy,
    }, dispute.tradeId)

    return { dispute: updated, appealFeeRequired }
  }

  /**
   * RFC-021 D8 — either trade party may attach more evidence to their own
   * open dispute after it's been raised (raiseDispute()'s own `evidence`
   * param only covers what existed at open time). Finally makes
   * `DisputeStatus.EVIDENCE_SUBMITTED` reachable — it has existed in the
   * schema since the Dispute primitive was first built but no code path
   * ever produced it before this. Emits `dispute.evidence_submitted`,
   * which `common/events/handlers.ts` reacts to by attempting a QVAC
   * auto-resolution pass (config-gated, `qvacAutoResolutionEnabled`) —
   * this method itself has no QVAC dependency, matching this codebase's
   * module-boundary convention of reacting to events rather than one
   * module calling into another's service directly.
   */
  async submitEvidence(
    disputeId: string,
    submittedBy: string,
    descriptor: Pick<EvidenceDescriptor, 'type' | 'uri' | 'note' | 'evidenceReferenceId' | 'externalReference'>,
    idempotencyKey?: string
  ) {
    return withIdempotency(
      {
        scope: 'settlement.dispute.evidence',
        participantId: submittedBy,
        key: idempotencyKey,
        // Deliberately excludes submittedAt (assigned at execution time,
        // not part of the caller's own logical request) — a retry of the
        // identical descriptor must hash identically regardless of how
        // long the retry took to arrive. evidenceReferenceId/
        // externalReference are included (Issue #266) — a retry that
        // names a DIFFERENT cross-reference, or flips the explicit
        // external-reference declaration, must never be treated as the
        // same idempotent request as an earlier, different one.
        requestPayload: {
          disputeId, type: descriptor.type, uri: descriptor.uri, note: descriptor.note,
          evidenceReferenceId: descriptor.evidenceReferenceId, externalReference: descriptor.externalReference,
        },
      },
      () => this.persistEvidence(disputeId, submittedBy, descriptor),
      (dispute) => this.postPersistEvidence(dispute, submittedBy),
      async (resultDisputeId) => {
        const dispute = await prisma.dispute.findUnique({ where: { id: resultDisputeId } })
        if (!dispute) throw new NotFoundError('Dispute', resultDisputeId)
        return dispute
      }
    )
  }

  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1-R2 — the durable side effect here
  // is the validation reads (no writes) followed by exactly one durable
  // write, `prisma.dispute.update(...)`, which durably appends the
  // evidence entry AND advances `status` to `EVIDENCE_SUBMITTED` in the
  // same statement. Before that call returns, no evidence has been
  // durably appended — a throw anywhere above it (including the
  // NotFoundError/ForbiddenError/ValidationError guards) genuinely means
  // nothing durable happened, the only case safe to mark FAILED and
  // retry via a fresh `persistEvidence()` call.
  private async persistEvidence(disputeId: string, submittedBy: string, descriptor: Pick<EvidenceDescriptor, 'type' | 'uri' | 'note' | 'evidenceReferenceId' | 'externalReference'>) {
    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } })
    if (!dispute) throw new NotFoundError('Dispute', disputeId)

    const trade = await tradeRepository.findById(dispute.tradeId)
    if (!trade) throw new NotFoundError('Trade', dispute.tradeId)
    if (submittedBy !== trade.buyerId && submittedBy !== trade.sellerId) {
      throw new ForbiddenError(`${submittedBy} is not a party to trade ${dispute.tradeId}`)
    }

    if (dispute.status !== 'OPENED' && dispute.status !== 'EVIDENCE_SUBMITTED') {
      throw new ValidationError(`Dispute ${disputeId} cannot accept new evidence from status ${dispute.status}`)
    }

    // Issue #266 — validates/resolves an OpenProof cross-reference
    // before it is ever persisted; a no-op for a legacy raw/external
    // descriptor (see resolveEvidenceDescriptor()'s own header comment).
    const resolved = await this.resolveEvidenceDescriptor(descriptor, dispute.tradeId)
    const entry: EvidenceDescriptor = { ...resolved, submittedBy, submittedAt: new Date().toISOString() }
    const existing = Array.isArray(dispute.evidence) ? (dispute.evidence as unknown as EvidenceDescriptor[]) : []

    const updated = await prisma.dispute.update({
      where: { id: disputeId },
      data: { evidence: [...existing, entry] as unknown as object, status: 'EVIDENCE_SUBMITTED' },
    })

    // `tradeId`/`escrowId` never change in this update (only `evidence`/
    // `status` do) — merging over the already-validated pre-update
    // `dispute` guarantees `postPersistEvidence()` below always has them,
    // matching this method's pre-R2 behavior (which read them from this
    // same pre-update fetch, never from `prisma.dispute.update()`'s own
    // return value) regardless of whether a given Prisma client/mock/
    // future `select` clause happens to return the full row.
    return { ...dispute, ...updated }
  }

  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1-R2 — runs AFTER the evidence is
  // already durably appended. `eventBus.emit()`'s failure is real and
  // propagates to submitEvidence()'s original caller (the QVAC
  // auto-resolution pass this event triggers, per this method's own
  // doc comment above, simply won't fire for this submission — a real,
  // disclosed consequence, not a silent one), but idempotency.ts's
  // runAndSettle() has already settled the claim to COMPLETED/UNKNOWN by
  // the time this runs — a retry with the same key always recovers the
  // already-updated Dispute via recover() above, never calls
  // persistEvidence() again, and can never double-append the same
  // evidence entry.
  private async postPersistEvidence(dispute: Awaited<ReturnType<DisputeService['persistEvidence']>>, submittedBy: string) {
    await eventBus.emit('dispute.evidence_submitted', {
      disputeId: dispute.id,
      settlementId: dispute.escrowId,
      tradeId: dispute.tradeId,
      triggeredBy: submittedBy,
    }, dispute.tradeId)
  }

  /**
   * RFC-021 D8 — called by the `dispute.evidence_submitted` event handler
   * once QVAC has produced a confident recommendation. Never called with
   * `recommendation: 'INCONCLUSIVE'` or below-threshold confidence — the
   * event handler filters those out before reaching here, so a dispute
   * simply stays on its normal human-arbiter path with no trace of a
   * failed automation attempt. The atomic claim below (same idiom
   * escrow.service.ts's lockFunds() established) means a human arbiter
   * who already resolved or appealed this dispute always wins the race —
   * this never overwrites a real decision, it can only ever act on a
   * dispute still genuinely open.
   */
  async proposeAutoResolution(disputeId: string, recommendation: 'RELEASE' | 'REFUND', confidence: number, reasoning: string) {
    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } })
    if (!dispute) throw new NotFoundError('Dispute', disputeId)

    const deadline = new Date(Date.now() + config.settlement.qvacAutoResolutionWindowHours * 3600 * 1000)

    const claim = await prisma.dispute.updateMany({
      where: { id: disputeId, status: { in: ['OPENED', 'EVIDENCE_SUBMITTED'] }, ruling: null },
      data: {
        status: 'AUTO_PROPOSED',
        autoResolutionRecommendation: recommendation,
        autoResolutionConfidence: confidence,
        autoResolutionReasoning: reasoning,
        autoResolutionDeadline: deadline,
      },
    })
    if (claim.count === 0) return null // lost the race to a real human decision — not an error

    await eventBus.emit('dispute.auto_resolution_proposed', {
      disputeId,
      settlementId: dispute.escrowId,
      tradeId: dispute.tradeId,
      recommendation,
      confidence,
      deadline: deadline.toISOString(),
      triggeredBy: 'qvac-auto',
    }, dispute.tradeId)

    return prisma.dispute.findUnique({ where: { id: disputeId } })
  }

  /**
   * RFC-021 D8 — either trade party can reject a proposed automated
   * ruling at any point before its deadline, forcing the dispute back
   * onto its already-assigned human arbiter (assigned back at
   * raiseDispute() time and never touched by the auto-resolution
   * attempt) — no new arbiter assignment needed, matching D1's "the
   * market/parties decide, not software unilaterally" framing.
   */
  async contestAutoResolution(disputeId: string, contestedBy: string) {
    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } })
    if (!dispute) throw new NotFoundError('Dispute', disputeId)

    const trade = await tradeRepository.findById(dispute.tradeId)
    if (!trade) throw new NotFoundError('Trade', dispute.tradeId)
    if (contestedBy !== trade.buyerId && contestedBy !== trade.sellerId) {
      throw new ForbiddenError(`${contestedBy} is not a party to trade ${dispute.tradeId}`)
    }

    if (dispute.status !== 'AUTO_PROPOSED') {
      throw new ValidationError(`Dispute ${disputeId} has no pending automated resolution to contest (status: ${dispute.status})`)
    }
    if (dispute.autoResolutionDeadline && dispute.autoResolutionDeadline.getTime() < Date.now()) {
      throw new ValidationError(`Dispute ${disputeId}'s contest window has already closed`)
    }

    const expectedDeadline = dispute.autoResolutionDeadline
    const claim = await prisma.dispute.updateMany({
      where: {
        id: disputeId,
        status: 'AUTO_PROPOSED',
        autoResolutionDeadline: expectedDeadline,
      },
      data: {
        status: 'EVIDENCE_SUBMITTED',
        autoResolutionRecommendation: null,
        autoResolutionConfidence: null,
        autoResolutionReasoning: null,
        autoResolutionDeadline: null,
      },
    })
    if (claim.count === 0) {
      throw new ValidationError(`Dispute ${disputeId} auto-resolution state changed before contest could commit`)
    }
    const updated = await prisma.dispute.findUnique({ where: { id: disputeId } })
    if (!updated) throw new NotFoundError('Dispute', disputeId)

    await eventBus.emit('dispute.auto_resolution_contested', {
      disputeId,
      settlementId: dispute.escrowId,
      tradeId: dispute.tradeId,
      contestedBy,
      triggeredBy: contestedBy,
    }, dispute.tradeId)

    return updated
  }

  /**
   * RFC-021 D8, DOWNGRADED TO ADVISORY-ONLY — Missão 13 Fase 2, INV-12.
   *
   * Before this phase, an uncontested QVAC recommendation was applied
   * automatically via `applyRuling()`, using the already-assigned human
   * arbiter's own slot/execution key — with no cryptographic record that
   * the arbiter personally authorized THIS specific automated outcome.
   * Missão 12/13 found this to be exactly the failure `INV-12` (Attributed
   * Authority Integrity) exists to close: the settlement it produced was
   * indistinguishable on-chain from a real human ruling, attributed to an
   * arbiter who never actually signed anything for that instance.
   *
   * `resolveDispute()` now REQUIRES a verified signature from the
   * assigned arbiter's own identity key for every execution — a bar this
   * function has no way to satisfy on its own (there is, by construction,
   * no human present at the moment an uncontested window expires; that
   * was the entire point of automating it). Rather than fabricate an
   * attribution (having the server sign "on the arbiter's behalf" would
   * reproduce the identical violation under a different name — explicitly
   * forbidden, Missão 13 Fase 2 Task 16), this sweep no longer executes
   * ANY settlement. It reverts an expired, uncontested `AUTO_PROPOSED`
   * dispute back to `EVIDENCE_SUBMITTED` — the same transition
   * `contestAutoResolution()` already performs — so the already-assigned
   * arbiter reviews and produces a real, verifiable decision. The
   * recommendation/confidence/reasoning QVAC already computed are left in
   * place as context for that arbiter, not erased.
   *
   * A future, separate pass may reintroduce automated EXECUTION under a
   * genuine scoped, signed delegation from the human arbiter (Missão 13
   * Fase 1's Q2 model) — deliberately not attempted here per this
   * mission's own QVAC STOP GATE ("acceptable to downgrade QVAC to
   * ADVISORY... correct attribution is more important than preserving
   * automation").
   */
  async sweepExpiredAutoResolutions(): Promise<{ revertedToHuman: string[]; failed: Array<{ disputeId: string; error: string }> }> {
    const expired = await prisma.dispute.findMany({
      where: { status: 'AUTO_PROPOSED', autoResolutionDeadline: { lt: new Date() } },
    })

    const revertedToHuman: string[] = []
    const failed: Array<{ disputeId: string; error: string }> = []
    for (const dispute of expired) {
      try {
        const claim = await prisma.dispute.updateMany({
          where: {
            id: dispute.id,
            status: 'AUTO_PROPOSED',
            autoResolutionDeadline: dispute.autoResolutionDeadline,
          },
          data: { status: 'EVIDENCE_SUBMITTED', autoResolutionDeadline: null },
        })
        if (claim.count === 0) continue
        await eventBus.emit('dispute.auto_resolution_contested', {
          disputeId: dispute.id,
          settlementId: dispute.escrowId,
          tradeId: dispute.tradeId,
          contestedBy: 'window-expired-advisory-only',
          triggeredBy: 'window-expired-advisory-only',
        }, dispute.tradeId)
        revertedToHuman.push(dispute.id)
      } catch (err) {
        failed.push({ disputeId: dispute.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { revertedToHuman, failed }
  }
}

// Lazy singleton — constructed on first use, not at module load, so a
// deployment with neither arbitration mode configured can still boot and
// serve every other route/handler; only dispute-touching code paths fail,
// with a clear config error instead of the whole process refusing to
// start. Moved here (2026-08-02, RFC-021 D8) from settlement.routes.ts,
// which held the only previous copy — common/events/handlers.ts's new
// dispute.evidence_submitted reaction and app.ts's new sweeper interval
// both need the exact same instance a route handler would get, not a
// second, independently-constructed one.
//
// RFC-021 D2 — config.settlement.arbitrationMode picks between the two
// real ArbitrationProvider implementations: 'trusted-list' (RFC-007 D4's
// original, curated TRUSTED_ARBITRATORS allowlist) and 'market' (RFC-021's
// permissionless, collateral-and-reputation-weighted registry).
let disputeServiceInstance: DisputeService | null = null
export function getDisputeService(): DisputeService {
  if (!disputeServiceInstance) {
    const resolver = createArbitrationProviderResolver(
      config.settlement.arbitrationMode,
      config.settlement.arbitrationPolicyByEscrowType,
      config.settlement.trustedArbitrators,
    )

    // Legacy provider remains as an injection-compatible default for
    // code paths/tests that instantiate DisputeService directly. Runtime
    // dispute/appeal/finalize selection is escrow-aware via resolver.
    const hasExplicitMarketOverride = Object.values(config.settlement.arbitrationPolicyByEscrowType).includes('market')
    let defaultProvider: ArbitrationProvider
    if (config.settlement.arbitrationMode === 'market' || hasExplicitMarketOverride) {
      // This is only the injection-compatible fallback. Runtime dispute,
      // appeal and finalize authority still comes from the escrow-aware
      // resolver above; a trusted-list rail with no trusted arbiters fails
      // closed when that rail is actually selected.
      defaultProvider = marketArbitrationProvider
    } else {
      if (config.settlement.trustedArbitrators.length === 0) {
        throw new ValidationError('No trusted arbitrators configured — set TRUSTED_ARBITRATORS (RFC-007 D4)')
      }
      defaultProvider = new TrustedArbitratorProvider(config.settlement.trustedArbitrators)
    }

    disputeServiceInstance = new DisputeService(defaultProvider, escrowRepository, resolver)
  }
  return disputeServiceInstance
}
