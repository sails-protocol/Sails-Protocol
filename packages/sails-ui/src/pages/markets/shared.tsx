/**
 * Layer C (Sails Market): shared pieces of the markets prototype (DECISIONS.md "Nó não é mercado", "Nós e mercados
 * privados", CTO final correction for plan 1.4, issue #147, issue #361, ADR-001). Markets are the product and live in
 * the Market area; nodes are infrastructure in Configurações → Rede e nós. No contract exists, so every
 * backend-dependent control is disabled and names its loose wire; only demo mode (?demo=1, lib/demoMarkers.ts) adds
 * fictional markets and lets an invite walk through its states. All copy of the prototype lives in Layer C (`markets.*`,
 * built at render so it follows the interface language); NODES_MARKETS_SCREENS is dev-gallery text and stays pt-BR.
 */
import { useEffect, useReducer, useSyncExternalStore, type ReactNode } from 'react'
import { Activity, KeyRound, Scale, Server, Ticket, UserMinus, Users } from 'lucide-react'
import { Link } from 'react-router'
import { Badge } from '../../components/ui/badge'
import { Button, buttonVariants } from '../../components/ui/button'
import { marketPath } from '../../components/layout/navMatch'
import { cn } from '../../lib/utils'
import { PlannedItem } from '../../components/ui/PlannedItem'
import { ExplanationPopover } from '../../components/ui/ExplanationPopover'
import type { MarketCardCopy } from '../../components/markets/MarketCard'
import type { AdminImageCopy } from '../../components/markets/AdminImage'
import { DEMO_VERIFIED_CRITERIA, kycSummary, type KycSummary } from '../../lib/marketSpaces'
import type { EntryPolicy, SocialLogin } from '../../lib/marketContract'
import { formatUsd } from '../../lib/format'
import { getLocale } from '../../lib/locale'
import { InviteStatus, JoinMarketForm, type JoinMarketCopy } from '../../components/markets/JoinMarket'
import type { MarketListCopy } from '../../components/markets/MarketList'
import type { Fact } from '../../components/markets/FactList'
import { LOOSE_WIRES, type LooseWireId } from '../../lib/looseWires'
import { plannedBadge } from '../../lib/wiringMap'
import { toast } from '../../components/ui/toast'
import { DEMO_INVITED_MARKET_ID, demoMarkets, isDemoMode, setDemoInviteGranted, subscribeDemoMarkets } from '../../lib/demoMarkers'
import { composeMyMarkets, type MarketView } from '../../lib/myMarkets'
import { INVITE_STATES, nextInviteState, type InviteEvent, type InviteOutcome, type InviteState } from '../../lib/marketInvite'
import { t } from '../../i18n'

/** "Em breve" (or `badge`, e.g. "Em preparação") + the loose wires a disabled control waits for (the contract is in LOOSE_WIRES). */
export function WireNote({ ids, badge }: { ids: readonly LooseWireId[]; badge?: string }) {
  // Demo: a note whose wires are all simulated says "Simulado", never an unexplained "Em breve" (lib/wiringMap.ts).
  const demo = isDemoMode()
  const label = badge ?? (ids.every((id) => plannedBadge(id, demo) === 'simulated') ? t('spaces.simulated') : t('common.soon'))
  // A div, not a p: Badge renders a div (a p cannot contain it).
  return (
    <div className="text-caption text-brand-text-secondary">
      <Badge variant="outline" className="mr-1.5 border-transparent bg-brand-tonal font-medium text-brand-text-secondary">{label}</Badge>
      {t('markets.wireNote', { wires: ids.map((id) => LOOSE_WIRES[id].label).join(', ') })}
    </div>
  )
}

/** A planned item backed by a loose wire; `label` overrides the wire's label when the screen names the feature differently. */
export function WirePlanned({ id, label, description, badge, className }: { id: LooseWireId; label?: string; description?: string; badge?: string; className?: string }) {
  const wire = LOOSE_WIRES[id]
  const soon = badge ?? (plannedBadge(id, isDemoMode()) === 'simulated' ? t('spaces.simulated') : t('common.soon'))
  return <PlannedItem icon={wire.icon} label={label ?? wire.label} soonLabel={soon} description={description} className={className} />
}

/** Every simulated action says so (PO, 2026-11-22). */
export function simulatedToast(message?: string) {
  toast.info(message ?? t('spaces.simulated.toast'))
}

// --- Market Spaces (Comunidades, Mercados privados): copy shared by Explore, Meus mercados and the market page. ---

/**
 * Where a private market runs (PO 2026-11-22): the Satsails-managed Sails node is "Em breve" (never selectable, no
 * provisioning, no availability promise); the person's own node is the choice that exists. `own` is the caller's line.
 */
export function PrivateHostingNote({ own }: { own: ReactNode }) {
  return (
    <div className="space-y-2 rounded-lg bg-brand-elevated p-3">
      <p className="text-sm font-medium text-brand-text">{t('spaces.hosting.title')}</p>
      <WirePlanned id="managedNode" label={t('spaces.hosting.managed')} description={t('spaces.hosting.managedNote')} />
      {own}
    </div>
  )
}

export const categoryLabel = (m: Pick<MarketView, 'category'>) => (m.category ? t(`spaces.category.${m.category}`) : null)
export const profileLabel = (m: Pick<MarketView, 'profile'>) => (m.profile ? t(`spaces.profile.${m.profile}`) : null)
const SOCIAL_NAME: Record<SocialLogin, string> = { X: 'X', LINKEDIN: 'LinkedIn', GITHUB: 'GitHub' }
export const socialNames = (list: readonly SocialLogin[]) => list.map((s) => SOCIAL_NAME[s]).join(', ')
export const SOCIAL_OPTIONS = (Object.keys(SOCIAL_NAME) as SocialLogin[]).map((value) => ({ value, label: SOCIAL_NAME[value] }))

export function kycText(k: KycSummary): string {
  return k.kind === 'none' ? t('spaces.kyc.none') : k.kind === 'all' ? t('spaces.kyc.all') : t('spaces.kyc.above', { amount: formatUsd(k.thresholdUsd) })
}
export const entryText = (p: EntryPolicy | undefined) => {
  const kyc = kycText(kycSummary(p))
  return p && p.social.length > 0 ? t('spaces.create.summarySocial', { kyc, list: socialNames(p.social) }) : kyc
}

export function marketCardCopy(): MarketCardCopy {
  const list = marketListCopy()
  return {
    illustrative: list.illustrative,
    ownedByYou: t('spaces.ownedByYou'),
    category: categoryLabel,
    profile: profileLabel,
    meta: (m) => {
      const parts = [m.relation === 'default' ? list.relation.default : list.visibility[m.visibility]]
      if (m.relation !== 'default' && m.relation !== 'none') parts.push(list.relation[m.relation])
      if (m.participants !== undefined) parts.push(t('spaces.participants', { count: m.participants }))
      return parts.join(' · ')
    },
  }
}

export const adminImageCopy = (): AdminImageCopy => ({
  load: t('spaces.image.load'), privacy: t('spaces.image.privacy'), failed: t('spaces.image.failed'), linkLabel: t('spaces.adminLink'),
})

/** Demo only: the "Verificado" seal by fictional goals (DECISIONS.md "Perfil do mercado"); real mode never renders it. */
export function DemoVerifiedSeal({ explain = false }: { explain?: boolean }) {
  if (!isDemoMode()) return null
  const c = DEMO_VERIFIED_CRITERIA
  return (
    <span className="relative z-10 inline-flex items-center gap-1">
      <Badge variant="outline" className="gap-1 border-transparent bg-brand-info-bg font-medium text-brand-info-fg">
        <Activity aria-hidden="true" className="size-icon-xs" />{t('spaces.verified')}
      </Badge>
      {explain && (
        <ExplanationPopover
          label={t('spaces.verified.trigger')}
          explanation={{
            title: t('spaces.verified.title'),
            lines: [
              t('spaces.verified.rating', { rating: c.minRating.toLocaleString(getLocale(), { minimumFractionDigits: 1 }), ratings: c.minRatings }),
              t('spaces.verified.trades', { trades: c.minTrades }),
              t('spaces.verified.volume', { volume: formatUsd(c.minVolumeUsd) }),
            ],
            footer: t('spaces.verified.footer'),
          }}
        />
      )}
    </span>
  )
}

/** The Sails default public market, "Mercado aberto" (DECISIONS.md "Modelo mundo aberto"): the only real one today. */
export function defaultMarket(): MarketView {
  return { id: 'public', name: t('markets.default.name'), visibility: 'public', relation: 'default', infrastructure: 'network', description: t('markets.default.description') }
}

/** Default market first, then (demo only) fictional markets, including one joined by a fictional invite. */
export function useVisibleMarkets(): MarketView[] {
  const demo = useSyncExternalStore(subscribeDemoMarkets, demoMarkets)
  return composeMyMarkets(defaultMarket(), demo)
}

/** The value line of the markets approach (DECISIONS.md "Modelo mundo aberto"); "nó próprio", never "servidor". */
export const marketsValueLine = () => t('markets.valueLine')

export function marketListCopy(): MarketListCopy {
  return {
    label: t('markets.title'),
    visibility: { public: t('markets.list.visibility.public'), private: t('markets.list.visibility.private') },
    relation: {
      default: t('markets.list.relation.default'), follows: t('markets.list.relation.follows'), admin: t('markets.list.relation.admin'),
      member: t('markets.list.relation.member'), none: t('markets.list.relation.none'),
    },
    presetLabel: t('markets.list.presetLabel'),
    preset: { vitrine: t('markets.list.preset.vitrine'), comunidade: t('markets.list.preset.comunidade'), personalizado: t('markets.list.preset.personalizado') },
    infrastructureLabel: t('markets.list.infrastructureLabel'),
    infrastructure: { network: 'Rede Sails', own: t('markets.list.infrastructure.own') },
    illustrative: t('markets.list.illustrative'),
  }
}

export function guarantees(): readonly Fact[] {
  return [
    { icon: KeyRound, title: t('markets.guarantees.keys') },
    { icon: Server, title: t('markets.guarantees.host') },
    { icon: UserMinus, title: t('markets.guarantees.admin') },
    { icon: Scale, title: t('markets.guarantees.permissions') },
  ]
}

// The three identifiers, in words only: their formats are pending the Principal (never shown or invented here).
export function identifiers(): readonly Fact[] {
  return [
    { icon: Server, title: 'Sails Node ID', description: t('markets.identifiers.node') },
    { icon: Users, title: 'Sails Market ID', description: t('markets.identifiers.market') },
    { icon: Ticket, title: 'Sails Market Invite', description: t('markets.identifiers.invite') },
  ]
}

type ShownInvite = Exclude<InviteState, 'idle'>
const inviteState = (s: ShownInvite) => ({ title: t(`markets.invite.${s}.title`), description: t(`markets.invite.${s}.description`) })

function inviteCopy(): JoinMarketCopy {
  return {
    invite: t('markets.invite.label'),
    inviteHelp: t('markets.invite.help'),
    submit: t('markets.invite.submit'),
    another: t('markets.invite.another'),
    states: {
      validating: inviteState('validating'), pending: inviteState('pending'), granted: inviteState('granted'), failed: inviteState('failed'),
    },
  }
}

// Each demo answer is labelled with the title of the state it leads to; 'failed' stands for invalid, expired or revoked.
const DEMO_OUTCOMES: readonly InviteOutcome[] = ['pending', 'granted', 'failed']

/** Demo only: the viewer answers for the protocol, step by step. Clearly fictional, never rendered in real mode. */
function DemoInviteControls({ state, dispatch }: { state: InviteState; dispatch: (e: InviteEvent) => void }) {
  const buttons = state === 'validating'
    ? DEMO_OUTCOMES.map((o) => ({ key: o, label: inviteState(o).title, run: () => dispatch({ type: 'validated', outcome: o }) }))
    : state === 'pending'
      ? [{ key: 'auth', label: t('markets.invite.demo.authorize'), run: () => dispatch({ type: 'authorized' }) }, { key: 'fail', label: t('markets.invite.demo.refuse'), run: () => dispatch({ type: 'failed' }) }]
      : state === 'granted'
        ? [{ key: 'fail', label: t('markets.invite.demo.revoke'), run: () => dispatch({ type: 'failed' }) }]
        : []
  return (
    <div className="rounded-lg bg-brand-elevated p-3">
      <p className="text-caption text-brand-text-secondary">
        <Badge variant="outline" className="mr-1.5 border-transparent bg-brand-tonal font-medium text-brand-text">{t('markets.invite.demo.badge')}</Badge>
        {t('markets.invite.demo.note')}
      </p>
      {buttons.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {buttons.map((b) => <Button key={b.key} type="button" size="sm" variant="secondary" onClick={b.run} className="touch:min-h-11">{b.label}</Button>)}
        </div>
      )}
    </div>
  )
}

/** The Sails Market Invite flow. State lives in memory; leaving the page starts over at 'idle'. */
export function JoinMarketPanel() {
  const demo = isDemoMode()
  const [state, dispatch] = useReducer(nextInviteState, 'idle')
  // Demo only: a granted fictional invite adds its market to the portal (right after Mercado aberto); revoked removes it.
  useEffect(() => {
    if (state === 'granted') setDemoInviteGranted(true)
    else if (state === 'failed') setDemoInviteGranted(false)
  }, [state])
  return (
    <JoinMarketForm
      copy={inviteCopy()}
      state={state}
      contractAvailable={demo}
      // Private markets have no access-control contract yet: "Em preparação", not just "Em breve" (CTO 31).
      unavailableNote={<WireNote ids={['marketInvite', 'marketMembership']} badge={t('spaces.preparing')} />}
      qrEntry={<WirePlanned id="marketInviteQr" description={t('markets.invite.qrPlanned')} />}
      demoControls={demo && state !== 'idle' ? <DemoInviteControls state={state} dispatch={dispatch} /> : undefined}
      grantedAction={demo ? (
        <Link to={marketPath(DEMO_INVITED_MARKET_ID)} className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'touch:min-h-11')}>{t('spaces.page.openInvited')}</Link>
      ) : undefined}
      onSubmit={() => dispatch({ type: 'submit' })}
      onReset={() => dispatch({ type: 'reset' })}
    />
  )
}

/** Each prototype screen and the loose wires it waits for (rendered on /dev/design-system). */
export const NODES_MARKETS_SCREENS: readonly { screen: string; where: string; wires: readonly LooseWireId[] }[] = [
  { screen: 'Portal de mercados', where: 'Market (ao lado do título)', wires: ['marketDiscovery', 'marketMembership'] },
  { screen: 'Cartão de descoberta e chamadas', where: 'Market, lista vazia, Perfil, Configurações → Mercados', wires: ['marketDiscovery', 'createMarket'] },
  { screen: 'Explorar mercados', where: 'Market → Mercados (/markets)', wires: ['marketDiscovery'] },
  { screen: 'Meus mercados', where: 'Market → Mercados (/markets/mine)', wires: ['marketMembership', 'marketPortability'] },
  { screen: 'Criar mercado', where: 'Market → Mercados (/markets/new)', wires: ['createMarket', 'marketBranding', 'marketInvite'] },
  { screen: 'Prévia do mercado criado (e convites, nos privados)', where: 'Market → Mercados (/markets/new, último passo)', wires: ['createMarket', 'marketBranding', 'marketMembership', 'marketInvite'] },
  { screen: 'Entrar com convite', where: 'Market → Mercados (/markets/join)', wires: ['marketInvite', 'marketInviteQr', 'marketMembership'] },
  { screen: 'Preferências de mercados (padrão, convites recebidos, privacidade)', where: 'Configurações → Mercados', wires: ['marketMembership', 'marketInvite', 'marketParticipationPrivacy'] },
  { screen: 'Rede Sails e conexão', where: 'Configurações → Rede e nós', wires: ['nodeCatalog'] },
  { screen: 'Adicionar nó manualmente', where: 'Configurações → Rede e nós', wires: ['nodeCatalog', 'manualServer'] },
  { screen: 'Avançado: nós, operadores e diagnóstico', where: 'Configurações → Rede e nós', wires: ['nodeCatalog', 'nodeStateSync', 'connectionDiagnostics'] },
  // Market Spaces (Principal contract draft, lib/marketContract.ts; proposal pending the CTO's Day 0 cut). Each wire's
  // contract names the SDK call: this table is the screen -> endpoint/field map for the Principal.
  { screen: 'Comunidades (filtro por categoria, paginação)', where: 'Market → Mercados (/markets)', wires: ['marketDiscovery', 'marketBranding'] },
  { screen: 'Meus mercados em grade ou lista', where: 'Market → Mercados (/markets/mine)', wires: ['marketMembership'] },
  { screen: 'Página do mercado (identidade, regras, ofertas, participantes)', where: '/markets/:id', wires: ['marketPage', 'marketEntryPolicy', 'marketMembership', 'marketVerification'] },
  { screen: 'Chat do grupo (demonstração)', where: '/markets/:id', wires: ['marketGroupChat'] },
  { screen: 'Criar mercado: categoria, perfil, ícone, banner, KYC e login social', where: 'Market → Mercados (/markets/new)', wires: ['createMarket', 'marketBranding', 'marketEntryPolicy'] },
  { screen: 'Comprar espaço (serviço Satsails, só demonstração)', where: '/markets/space', wires: ['spacePurchase'] },
  { screen: 'Nó Sails gerenciado', where: 'Configurações → Rede e nós', wires: ['managedNode'] },
]

/** Every invite state, static, for the dev gallery. */
export function InviteStateGallery() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {INVITE_STATES.filter((s) => s !== 'idle').map((s) => <InviteStatus key={s} state={s} copy={inviteCopy()} />)}
    </div>
  )
}
