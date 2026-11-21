/**
 * "Criar mercado" draft and steps (CTO final correction for plan 1.4, issue #147). Visibility, participation and
 * infrastructure are separate settings: visibility never decides who publishes, and infrastructure is secondary.
 * No contract exists (LOOSE_WIRES.createMarket): the real screen can walk the steps but never creates anything.
 * Pure, no I/O.
 */
import type { MarketInfrastructure, MarketVisibility, ParticipationPreset } from './myMarkets'

export type CreateStep = 'identity' | 'visibility' | 'participation' | 'infrastructure' | 'review' | 'invites'

export interface MarketDraft {
  name: string
  description: string
  visibility: MarketVisibility | null
  preset: ParticipationPreset | null
  infrastructure: MarketInfrastructure
}

/** Infrastructure starts on Rede Sails (the default); the rest starts empty. */
export const EMPTY_DRAFT: MarketDraft = { name: '', description: '', visibility: null, preset: null, infrastructure: 'network' }

/** Name limit for the prototype field; the real limit belongs to the contract. */
export const MARKET_NAME_MAX = 60

/** Steps in order. Participants and invites only exist for a private market. */
export function createSteps(visibility: MarketVisibility | null): CreateStep[] {
  const base: CreateStep[] = ['identity', 'visibility', 'participation', 'infrastructure', 'review']
  return visibility === 'private' ? [...base, 'invites'] : base
}

/** Whether the draft lets the person leave `step` forward. 'personalizado' is future, so it never passes. */
export function canAdvance(step: CreateStep, draft: MarketDraft): boolean {
  switch (step) {
    case 'identity': {
      const name = draft.name.trim()
      return name.length > 0 && name.length <= MARKET_NAME_MAX
    }
    case 'visibility':
      return draft.visibility !== null
    case 'participation':
      return draft.preset === 'vitrine' || draft.preset === 'comunidade'
    default:
      return true
  }
}

/** Every step before `step` must pass for the person to reach it (no jumping past an incomplete step). */
export function canReach(step: CreateStep, draft: MarketDraft): boolean {
  const steps = createSteps(draft.visibility)
  const at = steps.indexOf(step)
  return at >= 0 && steps.slice(0, at).every((s) => canAdvance(s, draft))
}
