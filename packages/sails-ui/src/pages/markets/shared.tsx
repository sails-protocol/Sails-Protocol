/**
 * Layer C (Sails Market): shared pieces of the markets prototype (DECISIONS.md "Nó não é mercado", "Nós e mercados
 * privados", CTO final correction for plan 1.4, issue #147, issue #361, ADR-001). Markets are the product and live in
 * the Market area; nodes are infrastructure in Configurações → Rede e nós. No contract exists, so every
 * backend-dependent control is disabled and names its loose wire; only demo mode (?demo=1, lib/demoMarkers.ts) adds
 * fictional markets and lets an invite walk through its states. All copy of the prototype lives in Layer C (`markets.*`,
 * built at render so it follows the interface language); NODES_MARKETS_SCREENS is dev-gallery text and stays pt-BR.
 */
import { useEffect, useReducer, useSyncExternalStore } from 'react'
import { KeyRound, Scale, Server, Ticket, UserMinus, Users } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { PlannedItem } from '../../components/ui/PlannedItem'
import { InviteStatus, JoinMarketForm, type JoinMarketCopy } from '../../components/markets/JoinMarket'
import type { MarketListCopy } from '../../components/markets/MarketList'
import type { Fact } from '../../components/markets/FactList'
import { LOOSE_WIRES, type LooseWireId } from '../../lib/looseWires'
import { demoMarkets, isDemoMode, setDemoInviteGranted, subscribeDemoMarkets } from '../../lib/demoMarkers'
import { composeMyMarkets, type MarketView } from '../../lib/myMarkets'
import { INVITE_STATES, nextInviteState, type InviteEvent, type InviteOutcome, type InviteState } from '../../lib/marketInvite'
import { t } from '../../i18n'

/** "Em breve" + the loose wires a disabled control waits for (each wire's label; the contract is in LOOSE_WIRES). */
export function WireNote({ ids }: { ids: readonly LooseWireId[] }) {
  return (
    <p className="text-caption text-brand-text-secondary">
      <Badge variant="outline" className="mr-1.5 border-transparent bg-brand-tonal font-medium text-brand-text">{t('common.soon')}</Badge>
      {t('markets.wireNote', { wires: ids.map((id) => LOOSE_WIRES[id].label).join(', ') })}
    </p>
  )
}

/** A planned item backed by a loose wire; `label` overrides the wire's label when the screen names the feature differently. */
export function WirePlanned({ id, label, description, className }: { id: LooseWireId; label?: string; description?: string; className?: string }) {
  const wire = LOOSE_WIRES[id]
  return <PlannedItem icon={wire.icon} label={label ?? wire.label} soonLabel={t('common.soon')} description={description} className={className} />
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
      validating: inviteState('validating'), pending: inviteState('pending'), granted: inviteState('granted'),
      expired: inviteState('expired'), revoked: inviteState('revoked'),
    },
  }
}

// Each demo answer is labelled with the title of the state it leads to.
const DEMO_OUTCOMES: readonly InviteOutcome[] = ['pending', 'granted', 'expired', 'revoked']

/** Demo only: the viewer answers for the protocol, step by step. Clearly fictional, never rendered in real mode. */
function DemoInviteControls({ state, dispatch }: { state: InviteState; dispatch: (e: InviteEvent) => void }) {
  const buttons = state === 'validating'
    ? DEMO_OUTCOMES.map((o) => ({ key: o, label: inviteState(o).title, run: () => dispatch({ type: 'validated', outcome: o }) }))
    : state === 'pending'
      ? [{ key: 'auth', label: t('markets.invite.demo.authorize'), run: () => dispatch({ type: 'authorized' }) }, { key: 'rev', label: t('markets.invite.demo.revoke'), run: () => dispatch({ type: 'revoked' }) }]
      : state === 'granted'
        ? [{ key: 'rev', label: t('markets.invite.demo.revoke'), run: () => dispatch({ type: 'revoked' }) }]
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
    else if (state === 'revoked') setDemoInviteGranted(false)
  }, [state])
  return (
    <JoinMarketForm
      copy={inviteCopy()}
      state={state}
      contractAvailable={demo}
      unavailableNote={<WireNote ids={['marketInvite', 'marketMembership']} />}
      qrEntry={<WirePlanned id="marketInviteQr" description={t('markets.invite.qrPlanned')} />}
      demoControls={demo && state !== 'idle' ? <DemoInviteControls state={state} dispatch={dispatch} /> : undefined}
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
]

/** Every invite state, static, for the dev gallery. */
export function InviteStateGallery() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {INVITE_STATES.filter((s) => s !== 'idle').map((s) => <InviteStatus key={s} state={s} copy={inviteCopy()} />)}
    </div>
  )
}
