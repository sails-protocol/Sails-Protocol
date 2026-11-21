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
  /** Private market only: identifiers typed by the creator (demo only; real mode cannot add any, LOOSE_WIRES.marketInvite). */
  participants: readonly string[]
}

/** Infrastructure starts on Rede Sails (the default); the rest starts empty. */
export const EMPTY_DRAFT: MarketDraft = { name: '', description: '', visibility: null, preset: null, infrastructure: 'network', participants: [] }

/** Prototype cap on invites listed in one draft; the real limit belongs to the contract. */
export const PARTICIPANTS_MAX = 20

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

/** Adds a trimmed identifier once; empty, duplicate or over-the-cap input leaves the list as it was. */
export function addParticipant(list: readonly string[], raw: string): readonly string[] {
  const id = raw.trim()
  return !id || list.includes(id) || list.length >= PARTICIPANTS_MAX ? list : [...list, id]
}

/** Loose wires the created market would need (each a LOOSE_WIRES id). */
export type PreviewDependency = 'createMarket' | 'marketBranding' | 'marketMembership' | 'marketInvite'

/**
 * "Prévia do mercado criado" (DECISIONS.md "Criar mercado, fluxo completo com dados reais"): the market page as its
 * participants would see it, built only from the draft. Nothing is persisted and nothing is invented: no Sails Market
 * ID (format pending the Principal), no offers, no participant count; every invite is only "pending".
 */
export interface MarketPreviewModel {
  name: string
  description: string | null
  visibility: MarketVisibility
  preset: Exclude<ParticipationPreset, 'personalizado'>
  infrastructure: MarketInfrastructure
  /** Always null: the Sails Market ID format is not defined yet. */
  marketId: null
  /** Always empty: a market that does not exist has no offers. */
  offers: readonly never[]
  /** Private market: the invites screen (one pending invite per participant). Public market: null (no invites screen). */
  invites: readonly { identifier: string; state: 'pending' }[] | null
  dependsOn: readonly PreviewDependency[]
}

/** Null until the draft can reach its final step (every earlier step passes). */
export function marketPreview(draft: MarketDraft): MarketPreviewModel | null {
  const steps = createSteps(draft.visibility)
  if (!canReach(steps[steps.length - 1], draft) || !draft.visibility) return null
  if (draft.preset !== 'vitrine' && draft.preset !== 'comunidade') return null
  const isPrivate = draft.visibility === 'private'
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    visibility: draft.visibility,
    preset: draft.preset,
    infrastructure: draft.infrastructure,
    marketId: null,
    offers: [],
    invites: isPrivate ? draft.participants.map((identifier) => ({ identifier, state: 'pending' as const })) : null,
    dependsOn: isPrivate ? ['createMarket', 'marketBranding', 'marketMembership', 'marketInvite'] : ['createMarket', 'marketBranding', 'marketMembership'],
  }
}
