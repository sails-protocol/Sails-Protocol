/**
 * Demo-mode markers, read only in development builds. The demo backend
 * (demo/demoBackend.ts) tags its stand-in agent output with
 * `modelConsulted: false`; the real route never sends that field, and in a
 * production build `import.meta.env.DEV` is statically false, so demo data
 * can never change what production renders.
 */
import { ratingSummaryOf, type RatingSummary } from './ratings'
import type { NodeView } from './sailsNode'
import type { MarketView } from './myMarkets'
import { DEMO_INVITED_FIXTURE, DEMO_JOIN_REQUEST_KEYS, DEMO_MARKET_FIXTURES, DEMO_MEMBER_KEYS, DEMO_MY_MARKETS, DEMO_NODES, type DemoMarketFixture } from '../demo/nodesMarkets'
import { toMarketView } from './marketContract'
import { meetsDemoVerifiedCriteria } from './marketSpaces'
import { parseAppealView, type DisputeAppealView } from './disputeAppeal'

export interface DemoNoModelMarker {
  modelConsulted: false
}

export function isDemoNoModelOutput(value: unknown): boolean {
  return import.meta.env.DEV && (value as Partial<DemoNoModelMarker> | null)?.modelConsulted === false
}

/** sessionStorage flag demo/demoBackend.ts sets for `?demo=1` (read before the backend installs). */
export const DEMO_FLAG_KEY = 'sails_demo_mode'

/** True only in a dev build with demo mode on for this tab. */
export function isDemoMode(): boolean {
  if (!import.meta.env.DEV) return false
  try { return sessionStorage.getItem(DEMO_FLAG_KEY) === '1' } catch { return false }
}

/** Demo-only multi-method list on a raw offer/summary from the demo backend; undefined for real data. */
export function demoPaymentMethodsOf<T extends string>(raw: unknown): T[] | undefined {
  if (!import.meta.env.DEV) return undefined
  const list = (raw as { demoPaymentMethods?: unknown } | null)?.demoPaymentMethods
  return Array.isArray(list) && list.length > 0 ? (list as T[]) : undefined
}

/** Demo-only rating summary on a raw summary/seller (no read endpoint yet, LOOSE_WIRES.readRatings); undefined for real data. */
export function demoRatingsOf(raw: unknown): RatingSummary | undefined {
  if (!isDemoMode()) return undefined
  return ratingSummaryOf((raw as { demoRatings?: unknown } | null)?.demoRatings) ?? undefined
}

/** Demo-only sign-up date on a raw seller (public data has none, LOOSE_WIRES.publicMemberSince); undefined for real data. */
export function demoMemberSinceOf(raw: unknown): string | undefined {
  if (!isDemoMode()) return undefined
  const v = (raw as { demoMemberSince?: unknown } | null)?.demoMemberSince
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : undefined
}

/** Demo-only flag on one raw escrow: show the gated fee breakdown with "—" amounts (CTO 38 complement 1); false for real data. */
export function demoFeeBreakdownOf(raw: unknown): boolean {
  return isDemoMode() && (raw as { demoFeeBreakdown?: unknown } | null)?.demoFeeBreakdown === true
}

/**
 * Demo-only contest view on a raw dispute from the demo backend (no endpoint yet, LOOSE_WIRES.disputeAppealView);
 * undefined for real data, so real mode never sees a fictional deadline or permission.
 */
export function demoAppealViewOf(raw: unknown): DisputeAppealView | undefined {
  if (!isDemoMode()) return undefined
  return parseAppealView((raw as { demoAppealView?: unknown } | null)?.demoAppealView) ?? undefined
}

/** Demo-only node list (no node catalogue yet, LOOSE_WIRES.nodeCatalog); empty for real data. */
export function demoNodes(): readonly NodeView[] {
  if (!import.meta.env.DEV || !isDemoMode()) return []
  return DEMO_NODES
}

const NO_MARKETS: readonly MarketView[] = []
const fixtureView = (f: DemoMarketFixture, extra?: Partial<MarketView>): MarketView => toMarketView(
  f.market,
  DEMO_MY_MARKETS.find((e) => e.marketId === f.market.id),
  {
    preset: f.preset, infrastructure: f.infrastructure ?? 'network', illustrative: true,
    entryType: f.market.visibility === 'PRIVATE' ? 'invite' : f.entry ?? 'open', activity30d: f.activity30d, ...extra,
  },
)
// Listed demo markets: public ones (discoverable) plus the private ones the demo user belongs to.
const DEMO_VIEWS: readonly MarketView[] = DEMO_MARKET_FIXTURES.map((f) => fixtureView(f))
  .filter((m) => m.visibility === 'public' || m.relation !== 'none')
/** The private market a fictional invite grants. */
export const DEMO_INVITED_MARKET_ID = DEMO_INVITED_FIXTURE.market.id
const DEMO_INVITED: MarketView = fixtureView(DEMO_INVITED_FIXTURE, { relation: 'member', joinedByInvite: true })
// Demo state below lives in this module and in sessionStorage (like the demo backend's), so a reload keeps it.
const MARKETS_KEY = 'sails_demo_markets_v1'
interface DemoInvite { identifier: string; code: string }
interface Persisted {
  granted: boolean; created: MarketView[]; joined: string[]; pending: string[]; left: string[]
  requests: string[]; members: Record<string, string[]>; invites: Record<string, DemoInvite[]>; offerMarkets: Record<string, string>
}
function loadPersisted(): Partial<Persisted> {
  try { return JSON.parse(sessionStorage.getItem(MARKETS_KEY) ?? '{}') as Partial<Persisted> } catch { return {} }
}
const saved = loadPersisted()
let granted = saved.granted ?? false
// Local previews a created demo market uses: the wizard must not revoke them when it unmounts.
const retainedPreviews = new Set<string>()
export const isRetainedPreview = (url: string) => retainedPreviews.has(url)
// blob: previews do not survive a reload; the market falls back to its generated icon and banner.
let created: readonly MarketView[] = (saved.created ?? []).map((m) => ({ ...m, brandImage: undefined, bannerImage: undefined }))
const demoListeners = new Set<() => void>()
// Demo joins (Regras da comunidade → Aceito e entrar; Solicitar entrada → Pedido enviado → aprovado) and leaves.
const joined = new Set<string>(saved.joined)
const pending = new Set<string>(saved.pending)
const left = new Set<string>(saved.left)
const withJoins = (m: MarketView): MarketView => (left.has(m.id) ? { ...m, relation: 'none' } : joined.has(m.id) ? { ...m, relation: 'member' } : pending.has(m.id) ? { ...m, joinPending: true } : m)
const NO_KEYS: readonly string[] = []
// Admin side (markets the demo user administers): fictional requests, members (public keys) and invites per market.
let requests: readonly string[] = saved.requests ?? DEMO_JOIN_REQUEST_KEYS
let members: Readonly<Record<string, readonly string[]>> = saved.members ?? { 'demo-market-meu': DEMO_MEMBER_KEYS }
let invites: Readonly<Record<string, readonly DemoInvite[]>> = saved.invites ?? {}
// Offers published inside a market (PublishOffer ?market=): listed only there, never in the open market.
let offerMarkets: Readonly<Record<string, string>> = saved.offerMarkets ?? {}
const snapshotNow = () => [...DEMO_VIEWS.map(withJoins), ...(granted ? [withJoins(DEMO_INVITED)] : []), ...created]
let demoSnapshot: readonly MarketView[] = snapshotNow()
const publish = () => {
  demoSnapshot = snapshotNow()
  try {
    const p: Persisted = { granted, created: [...created], joined: [...joined], pending: [...pending], left: [...left], requests: [...requests], members: members as Persisted['members'], invites: invites as Persisted['invites'], offerMarkets: { ...offerMarkets } }
    sessionStorage.setItem(MARKETS_KEY, JSON.stringify(p))
  } catch { /* stays in memory */ }
  demoListeners.forEach((l) => l())
}

/**
 * Demo-only markets besides the default one (no discovery or membership yet, LOOSE_WIRES.marketDiscovery /
 * marketMembership); empty for real data. Returns a stable array (safe for useSyncExternalStore).
 */
export function demoMarkets(): readonly MarketView[] {
  if (!import.meta.env.DEV || !isDemoMode()) return NO_MARKETS
  return demoSnapshot
}

export function subscribeDemoMarkets(listener: () => void): () => void {
  demoListeners.add(listener)
  return () => { demoListeners.delete(listener) }
}

/** Demo only: a fictional invite was granted (true) or failed/removed (false). In memory, gone on reload; no-op for real data. */
export function setDemoInviteGranted(value: boolean): void {
  if (!import.meta.env.DEV || !isDemoMode()) return
  granted = value
  publish()
}

/** Demo only: join an open community after accepting its rules, or send/cancel a request, or the admin approves it. */
export function demoJoin(id: string, action: 'join' | 'request' | 'cancel' | 'approved' | 'leave'): void {
  if (!import.meta.env.DEV || !isDemoMode()) return
  if (action === 'join' || action === 'approved') { joined.add(id); pending.delete(id); left.delete(id) }
  else if (action === 'request') pending.add(id)
  else if (action === 'leave') { joined.delete(id); left.add(id) }
  else pending.delete(id)
  publish()
}
/** Requests exist only on a "Com aprovação" community the demo user administers (never on a new private market). */
export const demoJoinRequests = (id: string) => (id === 'demo-market-meu' ? requests : NO_KEYS)
const membersOf = (id: string) => members[id] ?? NO_KEYS
export function demoDecideRequest(key: string, approve: boolean): void {
  requests = requests.filter((k) => k !== key)
  if (approve) members = { ...members, 'demo-market-meu': [...membersOf('demo-market-meu'), key] }
  publish()
}
export function demoRemoveMember(id: string, key: string): void {
  members = { ...members, [id]: membersOf(id).filter((k) => k !== key) }
  publish()
}

/** Demo only: invites the admin generated for a market (identifier + a fictional `sails-invite-…` code, never a real credential). */
export const demoInvites = (id: string): readonly DemoInvite[] => invites[id] ?? []
export function demoAddInvite(id: string, identifier: string): void {
  if (demoInvites(id).some((i) => i.identifier === identifier)) return
  const code = `sails-invite-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')}`
  invites = { ...invites, [id]: [...demoInvites(id), { identifier, code }] }
  publish()
}
/** The invited person accepts (simulated): the invite row becomes a member. */
export function demoAcceptInvite(id: string, identifier: string): void {
  invites = { ...invites, [id]: demoInvites(id).filter((i) => i.identifier !== identifier) }
  members = { ...members, [id]: [...membersOf(id), identifier] }
  publish()
}

/** Demo only: an offer published inside a market is listed only there. */
export function tagDemoOfferMarket(offerId: string, marketId: string): void {
  if (!import.meta.env.DEV || !isDemoMode()) return
  offerMarkets = { ...offerMarkets, [offerId]: marketId }
  publish()
}
/** The market an offer was published in (demo), or undefined (open market / real data). */
export const demoOfferMarket = (offerId: string): string | undefined => (import.meta.env.DEV && isDemoMode() ? offerMarkets[offerId] : undefined)

/** Demo only: the market "Criar mercado" just created (fictional, admin = the demo user, in memory). Returns its id. */
export function addDemoCreatedMarket(m: Omit<MarketView, 'id' | 'relation' | 'illustrative' | 'ownedByYou'>): string | null {
  if (!import.meta.env.DEV || !isDemoMode()) return null
  const id = `demo-created-${created.length + 1}`
  created = [...created, { ...m, id, relation: 'admin', ownedByYou: true }]
  for (const u of [m.brandImage, m.bannerImage]) if (u) retainedPreviews.add(u)
  publish()
  return id
}

/**
 * Demo-only market page data (sails.markets.get + liquidity.discover({ marketId }) later); null for real data and for
 * an unknown id. A private market the demo user has not joined comes back with relation 'none': the page then shows
 * "not found or no access", never confirming that it exists (the backend will answer 404).
 */
export interface DemoMarketPage {
  market: MarketView
  createdAt: string
  /** Lists offers (picked from the demo backend's, lib/marketSpaces.ts offersForMarket); a just-created market has none. */
  hasOffers: boolean
  /** "Mercado ativo" criteria met on the fixture stats (lib/marketSpaces.ts, CTO 33); demo only. */
  verified: boolean
  /** Last computation of the badge (fixture date), when it is shown. */
  verifiedAt?: string
  /** Admin view only: members as public keys. */
  memberKeys: readonly string[]
}
export function demoMarketPage(id: string, snapshot: readonly MarketView[] = demoMarkets()): DemoMarketPage | null {
  if (!import.meta.env.DEV || !isDemoMode()) return null
  const fixture = [...DEMO_MARKET_FIXTURES, DEMO_INVITED_FIXTURE].find((f) => f.market.id === id)
  if (!fixture) {
    const own = snapshot.find((m) => m.id === id && m.id.startsWith('demo-created-'))
    // The creator plus the members who accepted an invite.
    return own ? { market: { ...own, participants: 1 + membersOf(id).length }, createdAt: new Date().toISOString(), hasOffers: false, verified: false, memberKeys: membersOf(id) } : null
  }
  const market = snapshot.find((m) => m.id === id) ?? fixtureView(fixture)
  return {
    market,
    createdAt: fixture.market.createdAt,
    hasOffers: true,
    verified: meetsDemoVerifiedCriteria(fixture.stats),
    verifiedAt: meetsDemoVerifiedCriteria(fixture.stats) ? fixture.stats?.calculatedAt : undefined,
    memberKeys: market.relation === 'admin' ? membersOf(id) : [],
    // The administered community counts its (demo) members, so approve and remove change the number.
    ...(id === 'demo-market-meu' ? { market: { ...market, participants: membersOf(id).length } } : {}),
  }
}

/** A received market invite as Configurações → Mercados lists it (no contract yet, LOOSE_WIRES.marketInvite). */
export interface ReceivedInviteView { id: string; market: string; from: string }
const NO_INVITES: readonly ReceivedInviteView[] = []
// Fictional names from DECISIONS.md "Identidade" (Alice); the market is the same fictional one the join flow grants.
const DEMO_RECEIVED: readonly ReceivedInviteView[] = [{ id: 'demo-invite-1', market: DEMO_INVITED.name, from: 'Alice' }]

/** Demo-only pending invite; empty for real data (no invite can be read yet). */
export function demoReceivedInvites(): readonly ReceivedInviteView[] {
  if (!import.meta.env.DEV || !isDemoMode()) return NO_INVITES
  return DEMO_RECEIVED
}
