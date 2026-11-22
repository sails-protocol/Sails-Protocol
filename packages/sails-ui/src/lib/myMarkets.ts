/**
 * Markets view-model (DECISIONS.md "Nó não é mercado", CTO final correction for plan 1.4, ADR-001 §1, issue #147).
 * Sails Market = the product; Público/Privado = the market's visibility; Rede Sails or own node = its infrastructure,
 * a secondary technical detail that never decides order, access or who publishes. Several public markets may exist
 * (a company storefront on Rede Sails); the Sails default public market always comes first. Pure, no I/O.
 */
import { getLocale } from './locale'
import type { EntryPolicy, MarketCategory, MarketProfile } from './marketContract'
export type MarketVisibility = 'public' | 'private'
/** How the person relates to the market: the default one, one they follow, administer or belong to, or none (discoverable only). */
export type MarketRelation = 'default' | 'follows' | 'admin' | 'member' | 'none'
/** Only two choices (a shared public node is part of Rede Sails). */
export type MarketInfrastructure = 'network' | 'own'
/** Optional UX presets (DECISIONS.md "Modelos iniciais de experiência"), never protocol limits. */
export type ParticipationPreset = 'vitrine' | 'comunidade' | 'personalizado'

export interface MarketView {
  id: string
  name: string
  visibility: MarketVisibility
  relation: MarketRelation
  infrastructure: MarketInfrastructure
  description?: string
  preset?: ParticipationPreset
  /** The market's own brand image (replaces the generic icon); none exists in real data yet (LOOSE_WIRES.marketBranding). */
  brandImage?: string
  /** Participant count; only demo data has one (real: "Em breve"). */
  participants?: number
  /** Joined through a Sails Market Invite: listed right after the default market (DECISIONS.md "Modelo mundo aberto"). */
  joinedByInvite?: boolean
  /** Demo/illustrative entry: the screen marks it so it is never read as real membership. */
  illustrative?: boolean
  /** Market Spaces (lib/marketContract.ts draft): demo fixtures only until the contract exists. */
  category?: MarketCategory
  profile?: MarketProfile
  /** The 3:1 banner: an object URL of the person's own local file (preview only). */
  bannerImage?: string
  /** Links supplied by the admin (iconRef/bannerRef): shown only after the person asks to load them (AdminImage). */
  remoteIcon?: string
  remoteBanner?: string
  entryPolicy?: EntryPolicy
  /** Demo: a market the person created in this session ("Criado por você" instead of "Exemplo ilustrativo"). */
  ownedByYou?: boolean
  /** How a person gets in: open (accept the rules), admin approval, or a Sails invite (private). Demo data only. */
  entryType?: 'open' | 'approval' | 'invite'
  /** Demo: a join request is waiting for the admin. */
  joinPending?: boolean
  /** Demo: "negociações em 30 dias" (Explore's default "Mais ativas" sort). */
  activity30d?: number
  /** Demo: accepted assets as the asset catalog writes them ("BTC · On-chain"). */
  assets?: readonly string[]
}

/**
 * Default public market first (exactly one, the caller's), then markets joined by invite, then other public markets,
 * then private markets, each by name. Drops any other 'default' entry and duplicate ids; never mutates the input.
 */
export function composeMyMarkets(defaultMarket: MarketView, others: readonly MarketView[]): MarketView[] {
  const seen = new Set([defaultMarket.id])
  const rest = others.filter((m) => {
    if (m.relation === 'default' || seen.has(m.id)) return false
    seen.add(m.id)
    return true
  })
  const byName = (a: MarketView, b: MarketView) => a.name.localeCompare(b.name, getLocale())
  return [
    defaultMarket,
    ...rest.filter((m) => m.joinedByInvite).sort(byName),
    ...rest.filter((m) => !m.joinedByInvite && m.visibility === 'public').sort(byName),
    ...rest.filter((m) => !m.joinedByInvite && m.visibility === 'private').sort(byName),
  ]
}

/** The person's own markets (portal, Meus mercados): everything except markets they only could discover. */
export function ownMarkets(markets: readonly MarketView[]): MarketView[] {
  return markets.filter((m) => m.relation !== 'none')
}
