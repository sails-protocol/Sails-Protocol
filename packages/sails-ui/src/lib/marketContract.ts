/**
 * Market Spaces contract draft (Principal proposal, 2026-11-22; CTO ratification of the Day 0 cut pending). None of
 * these endpoints exist yet: the UI reads only demo fixtures shaped like this, so the later SDK swap is mechanical
 * (replace the fixture readers in lib/demoMarkers.ts with the SDK calls named below). Ids and keys are opaque strings:
 * the UI never parses, shortens into a format or invents one. Pure, no I/O.
 *
 * Future SDK names (not called anywhere yet): sails.markets.discover / get / mine / create / update / publish /
 * follow / unfollow / invite / redeemInvite / revokeInvite / removeMember / members, and liquidity.discover({ marketId }).
 */
import type { MarketRelation, MarketView } from './myMarkets'

/** Opaque on purpose (uuid on the node today, maybe not tomorrow). */
export type MarketId = string
/** The admin's Ed25519 key, the same one used to sign in (the draft's field name may change; opaque here). */
export type AdminIdentity = string

export type MarketCategory = 'GENERAL' | 'P2P_TRADER' | 'BUSINESS_OTC' | 'REGIONAL'
export type MarketProfile = 'P2P' | 'EMPRESA_OTC'
export type MarketContractVisibility = 'PUBLIC' | 'PRIVATE'
export type SocialLogin = 'X' | 'LINKEDIN' | 'GITHUB'
export type KycMode = 'none' | 'above_threshold' | 'all'

/** Media is referenced, never embedded: where it is stored is the node's choice (DECISIONS.md "Mídia"). */
export interface MediaRef { url: string; sha256: string }

export interface MarketSummary {
  id: MarketId
  name: string
  description: string
  category: MarketCategory
  profile: MarketProfile
  visibility: MarketContractVisibility
  iconRef?: MediaRef
  bannerRef?: MediaRef
  participantsCount: number
  adminIdentity: AdminIdentity
  createdAt: string
}

/**
 * Declarative entry policy: the admin (or the provider they choose) evaluates it. It restricts who can join or start
 * new trades; it never changes where funds go, authorizes anything economic or touches a trade already in escrow.
 */
export interface EntryPolicy {
  kyc: KycMode
  thresholdUsd?: number
  providerUrl?: string
  social: readonly SocialLogin[]
}

export interface Market extends MarketSummary {
  entryPolicy: EntryPolicy
  listed: boolean
  state: 'DRAFT' | 'PUBLISHED' | 'CLOSED'
}

export type MyMarketRelation = 'admin' | 'member' | 'follower'
export interface MyMarketEntry { marketId: MarketId; relation: MyMarketRelation; joinedAt: string }

/** sails.markets.discover answer: ready for pagination even when the fixture is small. */
export interface DiscoverPage<T> { items: readonly T[]; total: number; limit: number; offset: number }

const RELATION: Record<MyMarketRelation, MarketRelation> = { admin: 'admin', member: 'member', follower: 'follows' }

/** Contract market + the person's entry (if any) into the UI view-model. Unknown relation = discoverable only. */
export function toMarketView(m: MarketSummary & Partial<Pick<Market, 'entryPolicy'>>, mine?: MyMarketEntry, extra?: Partial<MarketView>): MarketView {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    visibility: m.visibility === 'PUBLIC' ? 'public' : 'private',
    relation: mine ? RELATION[mine.relation] : 'none',
    // Hosting is not in the draft; Rede Sails is the default until the contract says otherwise.
    infrastructure: 'network',
    category: m.category,
    profile: m.profile,
    // Admin links are never loaded by themselves (GK): kept apart from the local-preview fields.
    remoteIcon: m.iconRef?.url,
    remoteBanner: m.bannerRef?.url,
    participants: m.participantsCount,
    entryPolicy: m.entryPolicy,
    ...extra,
  }
}
