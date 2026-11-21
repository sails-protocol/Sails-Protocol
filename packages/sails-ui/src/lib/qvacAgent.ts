/**
 * Real QVAC agent interaction (2026-08-09) — wraps `sailsClient.agents.*`
 * (`@satsails/p2p-trading-sdk`'s `SailsAgentsModule`, `POST /v1/agents/*` on the real
 * backend, `QvacAgentProvider` / LLAMA_3_2_1B_INST_Q4_0 local inference,
 * no cloud dependency). Was a client-side heuristic simulation until the
 * engineering session shipped the real HTTP surface this same day — a
 * real request relayed from this UI's own backlog (see
 * `docs/BACKLOG.md`'s OpenAgents row for the full history).
 *
 * Same exported function names/shapes as before, deliberately —
 * `AgentIntentionPanel.tsx`/`AgentRiskCard.tsx` don't need to change
 * their call sites, only this file's implementation changed. Both
 * routes require an active session (real inference has a real cost per
 * call, same reasoning the backend applies to capability-grant writes);
 * callers are responsible for not invoking these while logged out — see
 * each component's own `useAuth()` gate.
 *
 * Only `generateTradeIntent()` is used here, for both BUY and SELL
 * goals — this panel's own job is narrowing the Marketplace filter
 * (`onIntentGenerated`), not publishing an offer, so `TradeIntent`'s
 * shape (which includes `currency`) is what this UI actually needs
 * either way. `generateOfferIntent()` (no `currency` field, shaped for
 * an actual offer draft) is real and SDK-exposed too, but has no real
 * consumer in this UI yet — a natural fit for a future "AI-assist" on
 * `PublishOffer.tsx`'s own wizard, not this panel.
 */
import { sailsClient } from './sailsClient'
import { ASSETS, PAYMENT_METHODS } from '../data/mock'
import type { AssetType, FiatCurrency, PaymentMethod, TradeSide } from '../types'
import { t } from '../i18n'

export interface AgentGeneratedIntent {
  asset: AssetType
  side: TradeSide
  minValue: string
  maxValue: string
  currency: FiatCurrency
  fiatMethod: PaymentMethod
}

export type AgentRiskLevel = 'low' | 'medium' | 'high'
export type AgentRiskRecommendation = 'proceed' | 'hold' | 'reject'

export interface AgentRiskAssessment {
  risk: AgentRiskLevel
  reasoning: string
  recommendation: AgentRiskRecommendation
}

// `asset`/`fiatMethod` are real, model-constrained enums server-side
// (qvac-agent.provider.ts's own json_schema) — validated here anyway
// rather than trusted blindly, since the SDK's own return type keeps
// them as plain `string` (it describes what the server can actually
// return, not a stricter shape it doesn't guarantee — see
// packages/sails-sdk/src/modules/agents.ts's own comment). `currency`
// has NO server-side enum at all (same file, same comment) — genuinely
// free-form model output, so it gets the same validate-or-fallback
// treatment the old heuristic parser used, since it flows straight into
// Marketplace's real currency filter and a wrong value there silently
// produces zero matching offers.
const KNOWN_CURRENCIES = new Set<FiatCurrency>(['BRL', 'USD', 'EUR', 'GBP', 'ARS', 'MXN', 'NGN', 'INR', 'VES', 'COP', 'PEN', 'BOB', 'EGP'])

// Narrows to ASSETS's own literal union (the real backend enum, same
// strings @satsails/p2p-trading-sdk's own AssetType is built from) rather than this
// UI's broader AssetType — needed so a narrowed value type-checks
// against the SDK's stricter parameter in assessRiskWithQvac() below,
// not just against this UI's own wider type.
function isKnownAsset(a: string): a is (typeof ASSETS)[number] {
  return (ASSETS as readonly string[]).includes(a)
}

function isKnownPaymentMethod(m: string): m is PaymentMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(m)
}

export async function generateIntentWithQvac(goal: string, side: TradeSide): Promise<AgentGeneratedIntent> {
  const generated = await sailsClient.agents.generateTradeIntent(goal)
  return {
    asset: isKnownAsset(generated.asset) ? generated.asset : 'BTC',
    side,
    minValue: generated.minValue,
    maxValue: generated.maxValue,
    currency: KNOWN_CURRENCIES.has(generated.currency as FiatCurrency) ? (generated.currency as FiatCurrency) : 'BRL',
    fiatMethod: isKnownPaymentMethod(generated.fiatMethod) ? generated.fiatMethod : 'PIX',
  }
}

export async function assessRiskWithQvac(intent: {
  asset: AssetType
  side: TradeSide
  maxValue: number
  minValue: number
}): Promise<AgentRiskAssessment> {
  if (!isKnownAsset(intent.asset)) {
    // Callers only ever pass a real trade's own asset (a value the
    // backend itself produced), so this should never actually fire —
    // guards against the UI's own broader AssetType (DEPIX and other
    // UI-only additions, see types.ts's own comment) reaching a route
    // whose schema is the narrower real backend enum.
    throw new Error(t('agent.risk.unsupportedAsset', { asset: intent.asset }))
  }
  // The real route's response shape (IntentRiskAssessment) already
  // matches AgentRiskAssessment exactly — no reshaping needed, just the
  // number -> decimal-string conversion the real AssessableIntent schema
  // expects (RFC-009 convention, same as every other money-shaped field
  // in this codebase).
  return sailsClient.agents.assessIntentRisk({
    asset: intent.asset,
    side: intent.side,
    maxValue: String(intent.maxValue),
    minValue: String(intent.minValue),
  })
}
