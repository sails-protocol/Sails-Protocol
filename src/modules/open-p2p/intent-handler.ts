/**
 * OpenP2PTradeIntentHandler — Sails OpenP2P's real IntentHandler.
 * PROTOCOL_SPECIFICATION.md §2.7 (plugin architecture), RFC-018 Phase 3
 * (docs/rfcs/RFC-018-intent-as-canonical-trade-entry-point.md).
 *
 * Extracts what core/intent-engine.ts's validateStructure() previously
 * hardcoded inline for 'TradeIntent' into a real, registered module
 * handler — closing the gap §2.6 already disclosed ("registerHandler's
 * plugin pattern is implemented but only one real IntentHandler exists —
 * none yet, actually"). Behavior-preserving refactor, not a new
 * capability: identical validation rules and error strings, moved to
 * where §2.7's own principle ("the Core never imports a module") says
 * they belong — the Core no longer needs to know what a TradeIntent's
 * fields are.
 *
 * onCreated/onFulfilled/onExpired are intentionally no-ops here, not
 * gaps hidden behind an empty function: RFC-018 Phases 1-2 already wired
 * OpenP2P's real reactions to a TradeIntent's lifecycle directly inside
 * liquidity.service.ts's createOffer() and trade.service.ts's
 * createTrade()/updateStatus() — both call intentEngine.create()/
 * transition() themselves, as the callers, not as handler reactions.
 * Running that logic a second time from here would double it up, not
 * complete it. discover() is left unimplemented for the same reason:
 * OpenLiquidity's own order-book aggregation (liquidity.service.ts) is
 * Discovery's real implementation today, not something this handler
 * intercepts.
 */
import type { IntentHandler, IntentPayload, Intent, TradeIntentPayload } from '../../common/types/intent'

// UX-048: sanity bound for a reputation threshold (the score itself has no ceiling).
const MAX_REPUTATION_THRESHOLD = 1e9

// ─── CISO Byzantine Rule, now module-local: reject malformed
// TradeIntents at the entry boundary — identical checks previously
// inlined in core/intent-engine.ts's validateStructure(). ────────────────
function validate(payload: IntentPayload): { valid: boolean; errors?: string[] } {
  const p = payload as TradeIntentPayload
  const errors: string[] = []
  if (!p.asset || typeof p.asset !== 'string') errors.push('asset is required')
  if (p.side !== 'BUY' && p.side !== 'SELL') errors.push("side must be 'BUY' or 'SELL'")
  if (p.maxValue !== undefined && typeof p.maxValue !== 'string') errors.push('maxValue must be a decimal string, not a number (RFC-009)')
  if (p.minValue !== undefined && typeof p.minValue !== 'string') errors.push('minValue must be a decimal string, not a number (RFC-009)')
  // RFC-023 — same decimal-string convention as maxValue/minValue above.
  if (p.maxPriceUsd !== undefined && typeof p.maxPriceUsd !== 'string') errors.push('maxPriceUsd must be a decimal string, not a number (RFC-009)')
  if (p.minPriceUsd !== undefined && typeof p.minPriceUsd !== 'string') errors.push('minPriceUsd must be a decimal string, not a number (RFC-009)')
  // UX-048 (CTO): the threshold is compared with the canonical OpenReputation score (users.reputationScore), which is
  // cumulative, has no ceiling and can be negative. A number, not a decimal string (a threshold, not an amount).
  if (p.minReputationScore !== undefined) {
    if (typeof p.minReputationScore !== 'number' || !Number.isFinite(p.minReputationScore)) {
      errors.push('minReputationScore must be a finite number')
    } else if (Math.abs(p.minReputationScore) > MAX_REPUTATION_THRESHOLD) {
      errors.push(`minReputationScore must be between -${MAX_REPUTATION_THRESHOLD} and ${MAX_REPUTATION_THRESHOLD}`)
    }
  }
  // Deprecated alias, unchanged for existing clients: the same number against the same score (never rescaled), 0-5.
  if (p.minReputationRating !== undefined) {
    if (typeof p.minReputationRating !== 'number' || !Number.isFinite(p.minReputationRating)) {
      errors.push('minReputationRating must be a finite number')
    } else if (p.minReputationRating < 0 || p.minReputationRating > 5) {
      errors.push('minReputationRating must be between 0 and 5')
    }
  }
  if (p.minReputationScore !== undefined && p.minReputationRating !== undefined && p.minReputationScore !== p.minReputationRating) {
    errors.push('minReputationScore and minReputationRating (deprecated alias) must be equal when both are sent')
  }
  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}

export const OpenP2PTradeIntentHandler: IntentHandler<TradeIntentPayload> = {
  moduleId: 'openp2p',
  intentTypes: ['TradeIntent'],
  validate,

  async onCreated(_intent: Intent<TradeIntentPayload>): Promise<void> {
    // No-op — see file header. liquidity.service.ts/trade.service.ts
    // already drive OpenP2P's real reaction to Intent creation as the
    // callers of intentEngine.create(), not as a handler reaction.
  },

  async onFulfilled(_intent: Intent<TradeIntentPayload>, _settlement: unknown): Promise<void> {
    // No-op — see file header. The settlement.escrow.* reactions in
    // common/events/handlers.ts already drive FULFILLED's real
    // consequences (reputation scoring, Timeline).
  },

  async onExpired(_intent: Intent<TradeIntentPayload>): Promise<void> {
    // No-op — no expiry-driven cleanup exists in OpenP2P today
    // (BACKLOG.md has no such item); nothing to wire here yet, not a
    // hidden gap this handler is papering over.
  },
}
