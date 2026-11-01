/**
 * Sails OpenReputation — Reference Implementation
 *
 * The last module TODO.md's route-restoration pass left genuinely
 * unbuilt — unlike open-identity/open-p2p/open-settlement/open-liquidity,
 * this one had no service layer at all, not just missing routes.
 *
 * RFC-007 D8/D9's rule, enforced structurally here, not just by
 * convention: `recordOutcome()` was the *sole* input to
 * `User.reputationScore` through RFC-021 D6. `rate()` (star ratings)
 * remains informational feedback only — persisted, displayed, never
 * mixed into the score. A trade cancelled by mutual agreement (no
 * dispute ever raised) always classifies Neutral, never Negative — see
 * `recordOutcome`'s callers in `common/events/handlers.ts` for how
 * that's actually decided.
 *
 * **Second legitimate input, added RFC-021 D7 (2026-08-02):**
 * `penalizeForBurnedVouch()` — a real, disclosed exception to "sole
 * input," not a silent violation of it. Peer vouching (D7) extends D3's
 * "reputation as slashable collateral" principle from arbiters to
 * anyone who vouches for a newcomer: if the vouchee's first dispute is
 * lost while the vouch is still active, the voucher's own reputation
 * takes a real hit — the same "skin in the game" reasoning, applied one
 * hop further out. Only ever called from `vouch.service.ts`'s
 * `burnVouchesFor()`, never directly from a route.
 *
 * Known simplification (documented, not hidden — same discipline
 * `DATABASE.md` uses for `Offer.intentType` standing in for
 * `TradeIntent`): `SDK_GUIDE.md`'s `ReputationScore` interface specifies
 * a `{ total, tradeScore, volumeScore, settlementScore, disputeRate }`
 * breakdown. `User.reputationScore` is a single `Float` today — this
 * service computes `total` and `disputeRate` for real, and reports the
 * rest of the shape as zero rather than fabricating sub-scores nothing
 * in this codebase actually tracks separately yet.
 */
import { prisma } from '../../common/database'
import { NotFoundError, ValidationError, ForbiddenError } from '../../common/errors'
import { eventBus } from '../../common/events/event-bus'
import { applyEventProjectionOnce } from '../../common/events/event-projection'

export type ReputationOutcome = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'

// RFC-021 D7 — same magnitude as ReputationService's own NEGATIVE_DELTA:
// a voucher who backed someone whose first trade went badly takes the
// same hit they'd take for a bad outcome of their own. Deliberately
// lighter than an arbiter's OVERTURNED_PENALTY (-10,
// market-arbitration.provider.ts) — vouching is a social attestation
// between peers, not a paid professional role committing capital to
// adjudicate, so the penalty scale reflects that difference.
export const VOUCH_BURN_PENALTY = -5

export class ReputationService {
  // Asymmetric by design: a disputed loss should cost more than a clean
  // trade earns, otherwise a participant can "wash" one bad outcome with
  // one good one — the same asymmetry RED_TEAM_REVIEW.md's Sybil/wash-
  // trading findings assume reputation scoring needs.
  private readonly POSITIVE_DELTA = 2
  private readonly NEGATIVE_DELTA = -5

  async recordOutcome(tradeId: string, participantId: string, outcome: ReputationOutcome) {
    const delta = outcome === 'POSITIVE' ? this.POSITIVE_DELTA : outcome === 'NEGATIVE' ? this.NEGATIVE_DELTA : 0

    const user = await prisma.user.update({
      where: { id: participantId },
      data: { reputationScore: { increment: delta } },
    })

    await eventBus.emit('reputation.score.updated', {
      userId: participantId,
      newScore: user.reputationScore,
      totalTrades: user.totalTrades,
      tradeId,
      ratingGiven: 0, // outcome-based update, not a rate() star rating — see rate() below
    }, tradeId)

    return user
  }

  /**
   * Issue #298 - the same outcome as recordOutcome(), applied at most ONCE per
   * (durable eventId, participant): the score increment and its projection
   * claim commit in one transaction, so redelivery / multi-instance fanout /
   * a crash-and-replay can never double-apply it. The notification event is
   * emitted only by the call that actually applied the increment.
   */
  async recordOutcomeOnce(eventId: string, tradeId: string, participantId: string, outcome: ReputationOutcome): Promise<boolean> {
    const delta = outcome === 'POSITIVE' ? this.POSITIVE_DELTA : outcome === 'NEGATIVE' ? this.NEGATIVE_DELTA : 0
    let user: { reputationScore: number; totalTrades: number } | undefined
    const applied = await applyEventProjectionOnce(eventId, 'reputation.outcome', participantId, async (tx) => {
      user = await tx.user.update({ where: { id: participantId }, data: { reputationScore: { increment: delta } } })
    })
    if (applied && user) {
      await eventBus.emit('reputation.score.updated', {
        userId: participantId,
        newScore: user.reputationScore,
        totalTrades: user.totalTrades,
        tradeId,
        ratingGiven: 0,
      }, tradeId)
    }
    return applied
  }

  // RFC-021 D7 — this class's own header comment has the full "second
  // legitimate input" disclosure. No tradeId parameter (unlike
  // recordOutcome()) — a burned vouch isn't scoped to one trade in the
  // reputation.score.updated event shape, so tradeId is reported as null
  // there rather than fabricated.
  async penalizeForBurnedVouch(voucherId: string) {
    const user = await prisma.user.update({
      where: { id: voucherId },
      data: { reputationScore: { increment: VOUCH_BURN_PENALTY } },
    })

    await eventBus.emit('reputation.score.updated', {
      userId: voucherId,
      newScore: user.reputationScore,
      totalTrades: user.totalTrades,
      tradeId: null,
      ratingGiven: 0,
    }, voucherId)

    return user
  }

  // Informational only (RFC-007 D8/D9) — does not touch reputationScore.
  // One rating per (tradeId, raterId), enforced by the schema's
  // @@unique constraint; caught here and surfaced as a clear 400 rather
  // than a raw Prisma error leaking through.
  async rate(tradeId: string, raterId: string, ratedId: string, score: number, comment?: string) {
    if (score < 1 || score > 5) {
      throw new ValidationError(`score must be between 1 and 5, got ${score}`)
    }

    // Gap-audit fix: this previously created a ReputationEvent for any
    // (tradeId, raterId, ratedId) triple with no check that either
    // party was actually involved in that trade — an authenticated
    // participant could rate a trade they had nothing to do with, or
    // attribute a rating to an arbitrary ratedId. Lower severity than
    // the escrow/Intent findings (this is informational only, per this
    // file's own header comment — it never touches reputationScore),
    // but still a real spam/abuse vector worth closing.
    const trade = await prisma.trade.findUnique({ where: { id: tradeId } })
    if (!trade) throw new NotFoundError('Trade', tradeId)
    if (raterId !== trade.buyerId && raterId !== trade.sellerId) {
      throw new ForbiddenError(`${raterId} is not a party to trade ${tradeId}`)
    }
    const expectedRatedId = raterId === trade.buyerId ? trade.sellerId : trade.buyerId
    if (ratedId !== expectedRatedId) {
      throw new ValidationError(`ratedId must be the other party to trade ${tradeId} (expected ${expectedRatedId})`)
    }

    try {
      return await prisma.reputationEvent.create({
        data: { tradeId, raterId, ratedId, score, comment },
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ValidationError(`${raterId} has already rated trade ${tradeId}`)
      }
      throw err
    }
  }

  async getScore(participantId: string) {
    const user = await prisma.user.findUnique({ where: { id: participantId } })
    if (!user) throw new NotFoundError('Participant', participantId)

    return {
      participantId: user.id,
      total: user.reputationScore,
      tradeScore: 0,       // not yet tracked separately — see class doc comment
      volumeScore: 0,      // not yet tracked separately — see class doc comment
      settlementScore: 0,  // not yet tracked separately — see class doc comment
      disputeRate: user.totalTrades > 0 ? user.disputeCount / user.totalTrades : 0,
      totalTrades: user.totalTrades,
      // RFC-021 D4 — real, not fabricated (unlike the three above): the
      // cost-to-fabricate-reputation floor. common/events/handlers.ts's
      // settlement.escrow.released handler is the only writer. Stays
      // '0' for every participant while config.settlement.protocolFeeRate
      // is 0 (the bootstrap-phase default) — that's the honest number,
      // not a bug.
      cumulativeFeesObserved: String(user.cumulativeFeesObserved),
    }
  }

  // RFC-013 (rfcs/RFC-013-capability-registry-and-wallet-adapter.md) —
  // reputation addressable by a participant's portable Pears identity
  // (User.peerId, set the first time their PearNode starts), not only
  // the internal participantId. No new scoring logic: this resolves
  // peerId -> participantId, then delegates to the same getScore() path
  // above — the correction that RFC establishes is that Pears provides
  // the portable identity substrate, not the reputation computation
  // itself, which stays exclusively this service's job.
  async getScoreByPeerId(peerId: string) {
    const user = await prisma.user.findUnique({ where: { peerId } })
    if (!user) throw new NotFoundError('Participant with this peerId', peerId)
    return this.getScore(user.id)
  }

  async getLeaderboard(limit = 20, offset = 0) {
    const [items, total] = await Promise.all([
      prisma.user.findMany({
        orderBy: { reputationScore: 'desc' },
        take: limit,
        skip: offset,
        select: { id: true, displayName: true, reputationScore: true, totalTrades: true },
      }),
      prisma.user.count(),
    ])
    return {
      items,
      total,
      hasMore: offset + items.length < total,
      nextOffset: offset + items.length < total ? offset + items.length : null,
    }
  }
}

export const reputationService = new ReputationService()
