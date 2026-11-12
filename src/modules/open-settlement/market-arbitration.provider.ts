/**
 * MarketArbitrationProvider — Sails OpenSettlement Adapter
 * RFC-021 D1-D3 (`docs/rfcs/RFC-021-market-based-arbitration-and-payment-trust.md`).
 *
 * Replaces (does not remove — see below) `TrustedArbitratorProvider`'s
 * static, application-curated `TRUSTED_ARBITRATORS` allowlist with
 * permissionless registration: any participant may become an arbiter
 * candidate by posting collateral, and eligibility/selection for a given
 * dispute is a function of `effectiveStake` (monetary collateral +
 * reputation-at-risk), not a fixed list anyone approves.
 *
 * Implements the exact `ArbitrationProvider` interface RFC-007 D4 already
 * defined (`arbitration-provider.ts`) — `DisputeService` needs zero code
 * changes; `assign()` is the only method it calls. `TrustedArbitratorProvider`
 * is not deleted: a deployment that wants a curated, closed arbiter set
 * (e.g. a regulated context) can still choose it via
 * `config.settlement.arbitrationMode` — see `settlement.routes.ts`'s
 * `getDisputeService()`.
 *
 * D1's load-bearing legal framing, unchanged by this provider: an arbiter
 * never moves funds directly. `assign()` only returns a participantId;
 * `dispute.service.ts`'s `resolveDispute()` writes `Dispute.ruling`, and
 * it is *that* write `escrowService.releaseFunds()`/`refundFunds()` react
 * to — verified directly in that file before writing this one, not
 * assumed.
 *
 * **Corrected/disclosed (Issue #255, 2026-09-22):** "posting collateral"
 * above describes the intended design, not what `register()` actually
 * verifies. `monetaryCollateral` is a bare, caller-declared decimal
 * string — no deposit txid, no on-chain lock, no escrow, no funding
 * verification of any kind exists anywhere in this codebase. `slash()`
 * only ever decrements this same internal column; there is no external
 * seizure/burn to perform. This does NOT make `effectiveStake`
 * cosmetic — `eligibleFor()`/`assign()`/`assignAppealPanel()` below are
 * real code that grants real arbitration authority (dispute assignment
 * + RELEASE/REFUND/SPLIT power) in proportion to this declared number,
 * which is exactly why `ARBITRATION_MODE=market` is refused at boot in
 * production (`arbitration-policy.ts`'s
 * `assertMarketArbitrationCollateralProductionEligible()`) until a real
 * funding/custody adapter exists — see that RFC's own D3 correction for
 * the full trace.
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '../../common/database'
import { EscrowError } from '../../common/errors'
import { escrowRepository, type EscrowRepository } from './escrow-repository'
import { tradeRepository } from '../open-p2p/trade-repository'
import { AssetType } from '../../common/types'
import { eventBus } from '../../common/events/event-bus'
import type { ArbitrationProvider } from './arbitration-provider'

// RFC-021 D3 — starting parameters. Explicitly not claimed as final
// (PROTOCOL_ECONOMY.md §7's own "not fixed forever" precedent for every
// economic parameter in this codebase).
//
// REPUTATION_STAKE_FACTOR: each arbiterReputation point counts as this
// fraction of one notional collateral unit toward effectiveStake — e.g.
// an arbiter with 100 reputation and 0 collateral has the same
// effectiveStake as one who posted 1 unit of real collateral. Low on
// purpose: reputation alone should let an arbiter compete for small
// disputes, not instantly out-collateralize someone with real capital.
export const REPUTATION_STAKE_FACTOR = 0.01

// K_ELIGIBILITY — effectiveStake must be at least this multiple of the
// disputed value. 1.5x sits inside the real-world 1.2x-2x range
// bonding/insurance over-collateralization ratios typically use — not
// asserted without that comparison.
export const K_ELIGIBILITY = 1.5

// RFC-021 D6 — appeal + slashing parameters. Starting proposals, same
// "not fixed forever" caveat as the two constants above.
//
// OVERTURNED_PENALTY: reputation lost when an appeal panel overturns this
// arbiter's ruling. Roughly double reputation.service.ts's own
// NEGATIVE_DELTA (-5) — an arbiter's wrong ruling affects two other
// parties (the losing side AND the protocol's own credibility), not one.
export const OVERTURNED_PENALTY = -10

// SLASH_COLLATERAL_FRACTION: fraction of posted collateral forfeited on
// a real slash (an overturned ruling). Not 100% — a single overturned
// ruling shouldn't be a death sentence for an otherwise-good arbiter
// (mirrors reputation.service.ts's own asymmetric-but-not-annihilating
// penalty design), but 50% is a real, felt cost, not a token deduction.
export const SLASH_COLLATERAL_FRACTION = 0.5

// PANEL_SIZE_BASE: Kleros's own real starting jury size (verified before
// reuse, see RFC-021 D6). Panel size for appeal round N is
// PANEL_SIZE_BASE * 2^N — Kleros's own real escalating-jury mechanism,
// reused for panel size only; the WEIGHTING inside that panel is
// deliberately NOT Kleros's stake-only draw (see assignAppealPanel()).
export const PANEL_SIZE_BASE = 3

// D4's own formula — real, tracked data (`cumulativeFeesObserved`, wired
// since RFC-021 Phase 3) that was never actually CONSUMED anywhere until
// now (verified via a real grep across src/ before writing this — the
// only prior reads were a read-only profile display and this file's own
// doc comments citing D4). The RFC's own "D3 correction" already
// recorded a deliberate decision NOT to fold this into D3's baseline
// `effectiveStake`/`eligibleFor()` — doing so would zero out every
// reputation-heavy arbiter's eligibility for ordinary disputes for as
// long as `protocolFeeRate` stays at its bootstrap-phase default of 0
// (nobody has meaningful `cumulativeFeesObserved` yet), directly undoing
// D3's own "veteran with low capital can still compete" design goal.
// Project owner's own decision (2026-08-04, after Yuri's audio 06-08
// discussion): apply the floor narrowly to `assignAppealPanel()`'s
// reputation-weighted 70% term instead — that panel is exactly where a
// cheaply-fabricated reputation gaming the "full node vs. hashpower"
// concern this design started from would matter, and D3's baseline
// selection is left untouched.
//
// k=1 — Yuri's own plain formula ("cumulativeFeesObserved(candidate) >
// k × currentTradeValue"), no extra margin (unlike K_ELIGIBILITY's 1.5x
// bonding-style buffer above): this is a pass/fail worst-case-Sybil
// validity check, not a collateral bond.
export const COST_FLOOR_FACTOR = 1

export interface ArbiterCandidate {
  participantId: string
  monetaryCollateral: string // decimal string, RFC-009
  collateralAsset: string | null
  arbiterReputation: number
  effectiveStake: number
  cumulativeFeesObserved: string // decimal string, RFC-009 — D4's cost-to-fabricate floor input
}

export class MarketArbitrationProvider implements ArbitrationProvider {
  name = 'market-arbitration'
  // Satisfies the ArbitrationProvider interface's `arbitrators: string[]`
  // field structurally — this provider has no fixed list (that's the
  // entire point of D2), so it always reports empty here. Real candidate
  // discovery goes through eligibleFor()/register() below, not this
  // property; nothing in dispute.service.ts reads it.
  arbitrators: string[] = []

  constructor(private readonly repo: EscrowRepository = escrowRepository) {}

  /**
   * D2 — permissionless registration. No approval step: any participant
   * may call this for themselves. Creates the ArbiterProfile if one
   * doesn't exist yet, or tops up collateral on an existing one.
   */
  async register(participantId: string, monetaryCollateral: string, collateralAsset?: string): Promise<ArbiterCandidate> {
    const existing = await prisma.arbiterProfile.findUnique({ where: { participantId } })

    const profile = existing
      ? await prisma.arbiterProfile.update({
          where: { participantId },
          data: {
            monetaryCollateral: { increment: monetaryCollateral },
            collateralAsset: (collateralAsset as AssetType | undefined) ?? existing.collateralAsset ?? undefined,
          },
        })
      : await prisma.arbiterProfile.create({
          data: {
            participantId,
            monetaryCollateral,
            collateralAsset: collateralAsset as AssetType | undefined,
          },
        })

    return this.toCandidate(profile)
  }

  async getProfile(participantId: string): Promise<ArbiterCandidate | null> {
    const profile = await prisma.arbiterProfile.findUnique({ where: { participantId } })
    return profile ? this.toCandidate(profile) : null
  }

  private toCandidate(profile: {
    participantId: string
    monetaryCollateral: unknown
    collateralAsset: string | null
    arbiterReputation: number
    cumulativeFeesObserved?: unknown
  }): ArbiterCandidate {
    const monetaryCollateral = Number(profile.monetaryCollateral)
    const effectiveStake = monetaryCollateral + profile.arbiterReputation * REPUTATION_STAKE_FACTOR
    return {
      // cumulativeFeesObserved defaults to 0 when absent — real
      // ArbiterProfile rows always have it (schema `@default(0)`), this
      // fallback only matters for older test fixtures predating D4's
      // wiring here.
      cumulativeFeesObserved: String(profile.cumulativeFeesObserved ?? 0),
      participantId: profile.participantId,
      monetaryCollateral: String(profile.monetaryCollateral),
      collateralAsset: profile.collateralAsset,
      arbiterReputation: profile.arbiterReputation,
      effectiveStake,
    }
  }

  /**
   * D3 — filters registered candidates to those whose effectiveStake
   * clears K_ELIGIBILITY * disputeValue. disputeValue is a decimal
   * string (RFC-009); Number() here is a bounds comparison only, never
   * stored or propagated as a number — same precedent
   * `policy-engine.ts`'s `validateFinancialSanity` already established.
   *
   * excludeParticipantIds — Missão 04 hardening finding: neither this
   * method nor assign()/assignAppealPanel() below ever excluded the
   * disputed trade's own buyer/seller from the eligible pool. A trade
   * party who registered as an arbiter (permissionless, D2) with enough
   * collateral to clear K_ELIGIBILITY for their own trade's value had a
   * real, non-zero chance of being weighted-random-selected to arbitrate
   * their own dispute — resolveDispute()'s only check is
   * `dispute.arbiterId === arbiterId`, trivially true for a self-assigned
   * arbiter, giving them a real, unilateral path to a favorable
   * RELEASE/REFUND/SPLIT ruling with none of RFC-015's two-person control
   * (arbitration is explicitly exempted from that by design, on the
   * assumption the arbiter is neutral — this bug broke that assumption).
   * Fixed at the source (the eligible pool itself) so both assign() and
   * assignAppealPanel() get the fix for free.
   */
  async eligibleFor(disputeValue: string, excludeParticipantIds: string[] = []): Promise<ArbiterCandidate[]> {
    const profiles = await prisma.arbiterProfile.findMany({ where: { slashedAt: null } })
    const threshold = Number(disputeValue) * K_ELIGIBILITY
    return profiles
      .map((p) => this.toCandidate(p))
      .filter((c) => c.effectiveStake >= threshold && !excludeParticipantIds.includes(c.participantId))
  }

  /**
   * The real assign() the ArbitrationProvider interface requires.
   * Weighted-random selection among eligible candidates, weight =
   * effectiveStake — replaces TrustedArbitratorProvider's round-robin.
   * The trade's own buyer/seller are excluded from the eligible pool —
   * see eligibleFor()'s own doc comment for why. Read from the dispute's
   * own persisted `tradeId` (authoritative), not the `_tradeId` parameter
   * alone, though the two should always agree for a correct caller.
   */
  async assign(disputeId: string, _tradeId: string): Promise<string> {
    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } })
    if (!dispute) throw new EscrowError(`MarketArbitrationProvider: no dispute found for id ${disputeId}`)
    const escrow = await this.repo.findById(dispute.escrowId)
    if (!escrow) throw new EscrowError(`MarketArbitrationProvider: no escrow found for dispute ${disputeId}`)
    const trade = await tradeRepository.findById(dispute.tradeId)
    if (!trade) throw new EscrowError(`MarketArbitrationProvider: no trade found for dispute ${disputeId}`)

    const eligible = await this.eligibleFor(String(escrow.lockedAmount), [trade.buyerId, trade.sellerId])
    if (eligible.length === 0) {
      throw new EscrowError(
        `MarketArbitrationProvider: no registered arbiter clears the ${K_ELIGIBILITY}x eligibility threshold ` +
        `for a dispute of value ${escrow.lockedAmount} (excluding the trade's own buyer/seller) — register more ` +
        'collateral/reputation, or configure TRUSTED_ARBITRATORS and set ARBITRATION_MODE=trusted-list instead.'
      )
    }

    return this.weightedRandomPick(eligible)
  }

  private weightedRandomPick(candidates: ArbiterCandidate[]): string {
    const totalWeight = candidates.reduce((sum, c) => sum + c.effectiveStake, 0)
    let roll = Math.random() * totalWeight
    for (const candidate of candidates) {
      roll -= candidate.effectiveStake
      if (roll <= 0) return candidate.participantId
    }
    // Floating-point edge case (roll never went <= 0 due to rounding) —
    // the last candidate is the correct fallback, not an error.
    return candidates[candidates.length - 1].participantId
  }

  /**
   * RFC-021 D6 — appeal-round arbiter selection. Deliberately NOT
   * stake-weighted like Kleros's real juror draw (verified before this
   * session converged on the alternative: Kleros draws jurors purely
   * proportional to staked PNK). Weighting here shifts toward reputation
   * (70/30) specifically so a deep-capital actor who dominated the
   * first-instance draw (assign(), effectiveStake-weighted) doesn't also
   * dominate the appeal panel — the concrete mechanism for the
   * full-node-vs-hashpower analogy this design started from. Panel size
   * grows with round (PANEL_SIZE_BASE * 2^round); the excluded original
   * arbiter can't be redrawn onto their own appeal. Same Missão 04
   * exclusion as assign() — the trade's own buyer/seller can never sit
   * on the panel judging their own dispute, appeal round or not.
   */
  async assignAppealPanel(disputeId: string, _tradeId: string, round: number, excludeParticipantId?: string): Promise<string> {
    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } })
    if (!dispute) throw new EscrowError(`MarketArbitrationProvider: no dispute found for id ${disputeId}`)
    const escrow = await this.repo.findById(dispute.escrowId)
    if (!escrow) throw new EscrowError(`MarketArbitrationProvider: no escrow found for dispute ${disputeId}`)
    const trade = await tradeRepository.findById(dispute.tradeId)
    if (!trade) throw new EscrowError(`MarketArbitrationProvider: no trade found for dispute ${disputeId}`)

    const excluded = [trade.buyerId, trade.sellerId, ...(excludeParticipantId ? [excludeParticipantId] : [])]
    const eligible = await this.eligibleFor(String(escrow.lockedAmount), excluded)
    if (eligible.length === 0) {
      throw new EscrowError(
        `MarketArbitrationProvider: no eligible arbiter available for appeal round ${round} of dispute ${disputeId} ` +
        '(excluding the original arbiter and the trade\'s own buyer/seller) — more arbiters need to register collateral/reputation.'
      )
    }

    // Normalized 0..1 within the eligible pool so reputation (unbounded
    // integer-ish score) and collateral (a decimal in whatever asset)
    // combine on a comparable scale — a raw sum would let whichever
    // dimension happens to have larger absolute numbers dominate
    // regardless of the intended 70/30 split.
    const maxReputation = Math.max(...eligible.map((c) => c.arbiterReputation), 1)
    const maxCollateral = Math.max(...eligible.map((c) => Number(c.monetaryCollateral)), 1)
    const disputeValue = Number(escrow.lockedAmount)
    const weighted = eligible
      .map((c) => {
        // D4's cost-to-fabricate floor, applied here and only here (see
        // COST_FLOOR_FACTOR's own header comment for why not D3) — a
        // candidate whose cumulativeFeesObserved hasn't cleared the
        // floor for THIS dispute's value gets a zeroed reputation term:
        // worst-case, an unproven reputation score is indistinguishable
        // from a free Sybil loop, so it shouldn't buy weight in the
        // panel that leans 70% on reputation. The 30% capital term is
        // untouched — real posted collateral was never in question.
        const feeFloorCleared = Number(c.cumulativeFeesObserved) >= COST_FLOOR_FACTOR * disputeValue
        const reputationTerm = feeFloorCleared ? c.arbiterReputation / maxReputation : 0
        return {
          candidate: c,
          weight: 0.7 * reputationTerm + 0.3 * (Number(c.monetaryCollateral) / maxCollateral),
        }
      })
      .sort((a, b) => b.weight - a.weight)

    const panelSize = PANEL_SIZE_BASE * 2 ** round
    const panel = weighted.slice(0, panelSize)

    const totalWeight = panel.reduce((sum, p) => sum + p.weight, 0)
    let roll = Math.random() * totalWeight
    for (const p of panel) {
      roll -= p.weight
      if (roll <= 0) return p.candidate.participantId
    }
    return panel[panel.length - 1].candidate.participantId
  }

  /**
   * RFC-021 D6 — real penalty for an overturned ruling: forfeits
   * SLASH_COLLATERAL_FRACTION of posted collateral and OVERTURNED_PENALTY
   * reputation (floored at 0, never negative). `arbiter.slashed` is the
   * durable record (RFC-010's EventStore, not a new audit table) —
   * dispute.service.ts's resolveDispute() is the only real caller today,
   * invoked when an appeal panel's ruling differs from the ruling being
   * appealed.
   *
   * Issue #253 - `tx`, when supplied, runs the write inside the caller's own durable claim+effect
   * transaction (dispute.service.ts's finalizeResolveDispute()) and DEFERS the `arbiter.slashed` emit to
   * that caller (it emits only after the claim commits, from the forfeitedCollateral this method returns —
   * mirrors reputation.service.ts's recordOutcomeOnce()/vouch.service.ts's burnVouchesForOnce()'s own
   * "write inside the transaction, emit after commit" shape). A standalone call (tx omitted) keeps the
   * original behavior byte-for-byte, including emitting here.
   */
  async slash(participantId: string, tx?: Prisma.TransactionClient): Promise<ArbiterCandidate & { forfeitedCollateral: string }> {
    const client = tx ?? prisma
    const existing = await client.arbiterProfile.findUnique({ where: { participantId } })
    if (!existing) throw new EscrowError(`MarketArbitrationProvider.slash: no ArbiterProfile for ${participantId}`)

    const currentCollateral = Number(existing.monetaryCollateral)
    const forfeited = currentCollateral * SLASH_COLLATERAL_FRACTION
    const newCollateral = (currentCollateral - forfeited).toFixed(8)
    const newReputation = Math.max(0, existing.arbiterReputation + OVERTURNED_PENALTY)
    const forfeitedCollateral = forfeited.toFixed(8)

    const updated = await client.arbiterProfile.update({
      where: { participantId },
      data: {
        monetaryCollateral: newCollateral,
        arbiterReputation: newReputation,
        rulingsOverturned: { increment: 1 },
      },
    })

    if (!tx) {
      await eventBus.emit('arbiter.slashed', { participantId, forfeitedCollateral, newCollateral, newReputation }, participantId)
    }

    return { ...this.toCandidate(updated), forfeitedCollateral }
  }

  /**
   * Feeds the rulingsTotal/rulingsOverturned track record — called on
   * every resolution, not just overturned ones, so the ratio means
   * something. `feeObserved` (RFC-021 D4, Phase 3) accrues onto this
   * arbiter's cumulativeFeesObserved when the disputed escrow actually
   * charged a real fee (Phase 0) — absent/zero in the bootstrap phase,
   * same as everywhere else this field is read.
   */
  async recordRuling(participantId: string, feeObserved?: string, tx?: Prisma.TransactionClient): Promise<void> {
    await (tx ?? prisma).arbiterProfile.update({
      where: { participantId },
      data: {
        rulingsTotal: { increment: 1 },
        ...(feeObserved ? { cumulativeFeesObserved: { increment: feeObserved } } : {}),
      },
    })
  }
}

export const marketArbitrationProvider = new MarketArbitrationProvider()
