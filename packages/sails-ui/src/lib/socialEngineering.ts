/**
 * Mocked reflection of the real `SocialEngineeringAgent`
 * (RFC-017, `docs/rfcs/RFC-017-timeline-and-social-engineering-agent.md`,
 * `src/modules/open-agents/social-engineering-agent.ts`) — the real
 * agent calls QVAC (local LLM, `assessSocialEngineeringRisk()`) to
 * classify a chat message; this file uses a plain keyword regex instead,
 * purely so this UI has *something* to react to without a live backend
 * connection. Same honesty boundary this codebase applies everywhere a
 * gap like this exists (`aiNegotiator.ts`'s old simulation was the same
 * kind of disclosed gap — closed for real by RFC-023, unlike this one):
 * no HTTP/WS route exists yet for a browser to receive a real
 * `RISK_WARNING` from (`config.features.socialEngineeringDetection`,
 * off by default even on the backend). Detects the same two patterns
 * the real agent detects today — `unexpected_flow_deviation` isn't
 * detected by the real agent yet either (RFC-017's own scope note), so
 * it's not simulated here.
 */
import { t } from '../i18n'

export type RiskPattern = 'off_channel_migration' | 'payment_instruction_change'

export interface RiskWarning {
  pattern: RiskPattern
  riskScore: number
  reasoning: string
}

const OFF_CHANNEL_HINTS = /whatsapp|telegram|\bzap\b|\bsignal\b|fora do chat|liga(r)? no meu|meu (n[uú]mero|telefone)/i
const PAYMENT_CHANGE_HINTS = /nova chave pix|outra chave pix|troca(r)? a chave|novo pix|conta diferente|outro banco|nova conta/i

export function detectRiskLocally(content: string): RiskWarning | null {
  if (OFF_CHANNEL_HINTS.test(content)) {
    return {
      pattern: 'off_channel_migration',
      riskScore: 78,
      reasoning: t('escrow.risk.offChannelReason'),
    }
  }
  if (PAYMENT_CHANGE_HINTS.test(content)) {
    return {
      pattern: 'payment_instruction_change',
      riskScore: 70,
      reasoning: t('escrow.risk.paymentChangeReason'),
    }
  }
  return null
}

// Getters: each read uses the current language.
export const RISK_PATTERN_LABEL: Record<RiskPattern, string> = {
  get off_channel_migration() { return t('escrow.risk.offChannelLabel') },
  get payment_instruction_change() { return t('escrow.risk.paymentChangeLabel') },
}
