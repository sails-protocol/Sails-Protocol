/**
 * VouchService — Sails OpenReputation
 * RFC-021 D7 (`docs/rfcs/RFC-021-market-based-arbitration-and-payment-trust.md`).
 *
 * The real bootstrap mechanism for two brand-new participants who would
 * otherwise both start at zero (Yuri's "handshake at Anarcapulco"
 * analogy) — a peer with real trade history vouches for a newcomer,
 * which pre-signs the newcomer's first `PaymentAccount`
 * (payment-account.service.ts's `getOrCreate()`), skipping
 * `UNSIGNED_TRADE_LIMIT` entirely.
 *
 * Explicitly NOT a KYC/identity-linking flow — corrected directly by the
 * project owner (2026-08-02) after an earlier, lazier reading of this
 * RFC's own D7 draft used that framing: this protocol does not do KYC.
 * A vouch is a protocol-native attestation between two keypairs, nothing
 * more — the voucher is not verifying the vouchee's real-world identity,
 * only staking their own reputation on "I'm willing to vouch for this
 * participant."
 *
 * Real skin in the game, not a free action: eligibility requires actual
 * trade history (MIN_VOUCHER_TRADES) and non-negative standing, and if
 * the vouchee's first lost dispute happens while the vouch is still
 * active, the voucher's own reputation takes a real, disclosed penalty
 * (reputation.service.ts's `penalizeForBurnedVouch()`) — the same
 * "reputation as slashable collateral" principle D3 already applies to
 * arbiters, extended one hop further out. This is what keeps two fresh
 * Sybil accounts from vouching for each other for free: a real,
 * established account has to put its own real standing at risk to
 * bootstrap a newcomer.
 */
import { prisma } from '../../common/database'
import { NotFoundError, ValidationError } from '../../common/errors'
import { applyEventProjectionOnce } from '../../common/events/event-projection'
import { eventBus } from '../../common/events/event-bus'
import { reputationService, VOUCH_BURN_PENALTY } from './reputation.service'

const VOUCH_BURN_KEY = 'reputation.vouch-burn'
const VOUCH_BURNED_NOTICE_KEY = 'reputation.vouch-burned-notification'
class VouchAlreadyBurned extends Error {}

// A voucher needs real trade history before their attestation means
// anything — otherwise a brand-new account could vouch for another
// brand-new account for free, defeating the entire point. Starting
// number, not final (same "not fixed forever" precedent
// PROTOCOL_ECONOMY.md §7 and market-arbitration.provider.ts's own
// tunables already established).
export const MIN_VOUCHER_TRADES = 3

export class VouchService {
  /**
   * Either raises a ValidationError (self-vouch, ineligible voucher,
   * already-vouched pair) or persists a real Vouch row. `@@unique
   * ([voucherId, voucheeId])` is the actual enforcement for the
   * duplicate case — caught here and turned into a clean 400, same
   * pattern `reputation.service.ts`'s own `rate()` already established
   * for its own unique-constraint race.
   */
  async vouchFor(voucherId: string, voucheeId: string) {
    if (voucherId === voucheeId) {
      throw new ValidationError('cannot vouch for yourself')
    }

    const voucher = await prisma.user.findUnique({ where: { id: voucherId } })
    if (!voucher) throw new NotFoundError('User', voucherId)
    const vouchee = await prisma.user.findUnique({ where: { id: voucheeId } })
    if (!vouchee) throw new NotFoundError('User', voucheeId)

    if (voucher.totalTrades < MIN_VOUCHER_TRADES || voucher.reputationScore <= 0) {
      throw new ValidationError(
        `${voucherId} does not meet the eligibility bar to vouch — needs at least ${MIN_VOUCHER_TRADES} completed ` +
        `trades and a positive reputation score, has ${voucher.totalTrades} trades and a score of ${voucher.reputationScore}`
      )
    }

    try {
      const vouch = await prisma.vouch.create({ data: { voucherId, voucheeId } })
      await eventBus.emit('reputation.vouch.created', { voucherId, voucheeId, vouchId: vouch.id }, voucheeId)
      return vouch
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ValidationError(`${voucherId} has already vouched for ${voucheeId}`)
      }
      throw err
    }
  }

  /** Read-only check — payment-account.service.ts's own getOrCreate() calls the equivalent raw query directly (cross-module read, same precedent escrow.service.ts's Trade reads already established), not this method, to avoid a cross-module service import. Exposed here too for any same-module caller that wants it. */
  async hasActiveVouch(userId: string): Promise<boolean> {
    const vouch = await prisma.vouch.findFirst({ where: { voucheeId: userId, burnedAt: null } })
    return vouch !== null
  }

  /**
   * Called from common/events/handlers.ts's dispute.resolved reaction
   * when the losing party has at least one active vouch. Burns every
   * active vouch for this vouchee at once (if more than one peer vouched
   * for them, the trust every one of them extended was equally
   * misplaced) — each burn independently penalizes its own voucher.
   */
  /**
   * Issue #298 - burnVouchesFor() applied at most ONCE per (source transition,
   * vouchee): every vouch burn (CAS on burnedAt IS NULL) and its voucher score
   * penalty commit with a per-vouch projection claim in one transaction, and
   * each notification is published inside its own claim transaction (see
   * recordOutcomeOnce()): a failed publish rolls its unit back, so the
   * redelivery redoes exactly that unit instead of losing or repeating it.
   */
  async burnVouchesForOnce(effectId: string, voucheeId: string): Promise<boolean> {
    // One identity PER VOUCH (effectId, key, vouchId), each unit publishing at most ONE event inside its own claim
    // transaction. A unit that fails publishing rolls back with its claim and is redone by the redelivery; a unit
    // that committed is never repeated. With two events in one transaction a crash between them would republish
    // the first one.
    let burnedAny = false
    for (const vouch of await prisma.vouch.findMany({ where: { voucheeId } })) {
      if (vouch.burnedAt === null && await this.burnOneVouchOnce(effectId, vouch)) burnedAny = true
      // Only for a vouch THIS event burned (its burn claim exists): one already burned by an earlier event has none.
      if (await prisma.eventProjectionClaim.count({ where: { eventId: effectId, projectionKey: VOUCH_BURN_KEY, subjectId: vouch.id } }) > 0) {
        await applyEventProjectionOnce(effectId, VOUCH_BURNED_NOTICE_KEY, vouch.id, async () => {
          await eventBus.emit('reputation.vouch.burned', { voucherId: vouch.voucherId, voucheeId, vouchId: vouch.id }, voucheeId)
        })
      }
    }
    return burnedAny
  }

  /** CAS burn + voucher penalty + score notification in one claim transaction; false if already burned elsewhere. */
  private async burnOneVouchOnce(effectId: string, vouch: { id: string; voucherId: string }): Promise<boolean> {
    try {
      return await applyEventProjectionOnce(effectId, VOUCH_BURN_KEY, vouch.id, async (tx) => {
        const cas = await tx.vouch.updateMany({ where: { id: vouch.id, burnedAt: null }, data: { burnedAt: new Date() } })
        // Burned by someone else between our read and now: roll the claim back too - this event burned nothing.
        if (cas.count === 0) throw new VouchAlreadyBurned()
        const user = await tx.user.update({ where: { id: vouch.voucherId }, data: { reputationScore: { increment: VOUCH_BURN_PENALTY } } })
        await eventBus.emit('reputation.score.updated', { userId: vouch.voucherId, newScore: user.reputationScore, totalTrades: user.totalTrades, tradeId: null, ratingGiven: 0 }, vouch.voucherId)
      })
    } catch (err) {
      if (err instanceof VouchAlreadyBurned) return false
      throw err
    }
  }

  async burnVouchesFor(voucheeId: string): Promise<void> {
    const vouches = await prisma.vouch.findMany({ where: { voucheeId, burnedAt: null } })
    for (const vouch of vouches) {
      await prisma.vouch.update({ where: { id: vouch.id }, data: { burnedAt: new Date() } })
      await reputationService.penalizeForBurnedVouch(vouch.voucherId)
      await eventBus.emit('reputation.vouch.burned', { voucherId: vouch.voucherId, voucheeId, vouchId: vouch.id }, voucheeId)
    }
  }
}

export const vouchService = new VouchService()
