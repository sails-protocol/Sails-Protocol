/**
 * ArbitrationProvider — Sails OpenSettlement Adapter
 * RFC-007 (rfcs/RFC-007-real-world-p2p-requirements.md), decision D4.
 *
 * Specified in RFC-007 but never implemented (BACKLOG.md: 🔲 Not started)
 * until now (04-Deepseek Review.md's raiseDispute() task). Deliberately
 * not called "Guardian" or any protocol-native role — RFC-007's own
 * reasoning: the protocol defines the interface, each application
 * registers its own Trusted Arbitrators, the protocol itself never
 * arbitrates or claims authority over the outcome.
 *
 * Unlike RedisStreamsEventStore/StubLightsparkClient, this ships as a
 * real, working implementation — `assign()` is simple, local,
 * deterministic logic with no external dependency to verify against, not
 * an unverifiable third-party API call.
 *
 * Refined from RFC-007 D4's original interface: that RFC's `rule()`
 * signature (`rule(disputeId, arbiterId): Promise<Dispute['ruling']>`)
 * implied the provider computes a ruling — but a Trusted Arbitrator's
 * ruling is a human decision, an external input, not something this
 * provider can compute. `rule()` is dropped; `dispute.service.ts`'s
 * `resolveDispute()` is the real entry point for an arbiter's decision,
 * taking `ruling` as a parameter rather than deriving it.
 */
import type { Prisma } from '@prisma/client'

export interface ArbitrationProvider {
  name: string
  // Registers a per-application list of trusted arbiters — RFC-007's
  // "each wallet/application registers its own Trusted Arbitrators," not
  // a protocol-wide list.
  arbitrators: string[]
  assign(disputeId: string, tradeId: string): Promise<string>

  // RFC-021 D6 — all three optional: TrustedArbitratorProvider implements
  // none of them (a curated allowlist has no collateral/reputation to
  // slash and no meaningful track record to weight an appeal panel by).
  // Only MarketArbitrationProvider implements all three.
  /** Reopens a resolved dispute for a new arbiter, drawn from a reputation-weighted panel that grows with `round`. */
  assignAppealPanel?(disputeId: string, tradeId: string, round: number, excludeParticipantId?: string): Promise<string>
  /**
   * Penalizes an arbiter whose ruling was overturned on appeal.
   *
   * Issue #253 - `tx` (additive, optional) lets dispute.service.ts's finalizeResolveDispute() run this
   * inside the SAME durable claim+effect transaction as recordRuling()/appeal-fee settlement — see that
   * method's own comment. Omitting it preserves the original standalone-call behavior (including the
   * `arbiter.slashed` emit) for every existing caller/test.
   */
  slash?(participantId: string, tx?: Prisma.TransactionClient): Promise<unknown>
  /**
   * Records that an arbiter issued a ruling, correct or not — feeds the
   * rulingsTotal/rulingsOverturned track record. `feeObserved` (RFC-021
   * D4, Phase 3) is the disputed escrow's real Escrow.feeCharged, when
   * one was charged — accrues onto the arbiter's own
   * cumulativeFeesObserved, the same cost-to-fabricate floor D4 tracks
   * per-trader, applied to an arbiter's real track record of disputed
   * value handled.
   *
   * Issue #253 - `tx`, same additive/optional shape and reason as slash()'s own comment above.
   */
  recordRuling?(participantId: string, feeObserved?: string, tx?: Prisma.TransactionClient): Promise<void>
}

/**
 * Simple round-robin assignment across the configured trusted-arbiter
 * list. Deterministic, real, and fully testable — no external I/O.
 */
export class TrustedArbitratorProvider implements ArbitrationProvider {
  name = 'trusted-arbitrator-list'
  private cursor = 0

  constructor(public readonly arbitrators: string[]) {
    if (arbitrators.length === 0) {
      throw new Error('TrustedArbitratorProvider requires at least one configured arbiter')
    }
  }

  async assign(_disputeId: string, _tradeId: string): Promise<string> {
    const arbiterId = this.arbitrators[this.cursor % this.arbitrators.length]
    this.cursor++
    return arbiterId
  }
}
