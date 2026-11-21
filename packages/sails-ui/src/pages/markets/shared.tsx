/**
 * Layer C (Sails Market): shared pieces of the markets prototype (DECISIONS.md "Nó não é mercado", "Nós e mercados
 * privados", CTO final correction for plan 1.4, issue #147, issue #361, ADR-001). Markets are the product and live in
 * the Market area; nodes are infrastructure in Configurações → Rede e nós. No contract exists, so every
 * backend-dependent control is disabled and names its loose wire; only demo mode (?demo=1, lib/demoMarkers.ts) adds
 * fictional markets and lets an invite walk through its states. All pt-BR copy of the prototype lives in Layer C.
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

export const SOON = 'Em breve'

/** "Em breve" + the loose wires a disabled control waits for (each wire's label; the contract is in LOOSE_WIRES). */
export function WireNote({ ids }: { ids: readonly LooseWireId[] }) {
  return (
    <p className="text-caption text-brand-text-secondary">
      <Badge variant="outline" className="mr-1.5 border-transparent bg-brand-tonal font-medium text-brand-text">{SOON}</Badge>
      Depende de: {ids.map((id) => LOOSE_WIRES[id].label).join(', ')}.
    </p>
  )
}

/** A planned item backed by a loose wire; `label` overrides the wire's label when the screen names the feature differently. */
export function WirePlanned({ id, label, description, className }: { id: LooseWireId; label?: string; description?: string; className?: string }) {
  const wire = LOOSE_WIRES[id]
  return <PlannedItem icon={wire.icon} label={label ?? wire.label} soonLabel={SOON} description={description} className={className} />
}

/** The Sails default public market, "Mercado aberto" (DECISIONS.md "Modelo mundo aberto"): the only real one today. */
export const DEFAULT_MARKET: MarketView = {
  id: 'public', name: 'Mercado aberto', visibility: 'public', relation: 'default', infrastructure: 'network', description: 'Ofertas de toda a Rede Sails',
}

/** Default market first, then (demo only) fictional markets, including one joined by a fictional invite. */
export function useVisibleMarkets(): MarketView[] {
  const demo = useSyncExternalStore(subscribeDemoMarkets, demoMarkets)
  return composeMyMarkets(DEFAULT_MARKET, demo)
}

/** The value line of the markets approach (DECISIONS.md "Modelo mundo aberto"); "nó próprio", never "servidor". */
export const MARKETS_VALUE_LINE = 'Crie o mercado da sua comunidade ou empresa, sem precisar de nó próprio.'

export const MARKET_LIST_COPY: MarketListCopy = {
  label: 'Mercados',
  visibility: { public: 'Público', private: 'Privado' },
  relation: { default: 'Padrão da Rede Sails', follows: 'Você segue', admin: 'Você administra', member: 'Você participa', none: 'Aberto para seguir' },
  presetLabel: 'Modelo',
  preset: { vitrine: 'Vitrine', comunidade: 'Comunidade', personalizado: 'Personalizado' },
  infrastructureLabel: 'Detalhe técnico:',
  infrastructure: { network: 'Rede Sails', own: 'nó próprio' },
  illustrative: 'Exemplo ilustrativo',
}

export const GUARANTEES: readonly Fact[] = [
  { icon: KeyRound, title: 'Suas chaves e seus fundos continuam com você.' },
  { icon: Server, title: 'Quem hospeda o mercado não acessa suas chaves nem decide a liquidação sozinho.' },
  { icon: UserMinus, title: 'O administrador pode remover alguém do mercado, sem apagar a identidade portátil nem a reputação global da pessoa.' },
  { icon: Scale, title: 'As permissões são verificadas pelo protocolo, não só escondidas na tela.' },
]

// The three identifiers, in words only: their formats are pending the Principal (never shown or invented here).
export const IDENTIFIERS: readonly Fact[] = [
  { icon: Server, title: 'Sails Node ID', description: 'Identifica a infraestrutura: o nó Sails.' },
  { icon: Users, title: 'Sails Market ID', description: 'Identifica o mercado, independente da infraestrutura.' },
  { icon: Ticket, title: 'Sails Market Invite', description: 'Convida e autoriza a entrada num mercado privado.' },
]

const INVITE_COPY: JoinMarketCopy = {
  invite: 'Convite Sails',
  inviteHelp: 'Cole o convite que você recebeu de quem administra o mercado. Conhecer o nome ou um identificador público do mercado não basta para entrar.',
  submit: 'Validar convite',
  another: 'Usar outro convite',
  states: {
    validating: { title: 'Validando convite…', description: 'O protocolo confere se o convite é válido e se foi emitido para você.' },
    pending: { title: 'Autorização pendente', description: 'O convite é válido. Falta o administrador do mercado autorizar a sua entrada.' },
    granted: { title: 'Acesso concedido', description: 'O mercado aparece no seu portal de mercados, logo depois do Mercado aberto, que continua igual.' },
    expired: { title: 'Convite expirado', description: 'Este convite passou do prazo. Peça um novo a quem administra o mercado.' },
    revoked: { title: 'Acesso revogado', description: 'O administrador retirou este acesso. Sua identidade e sua reputação global continuam as mesmas.' },
  },
}

const DEMO_OUTCOMES: { outcome: InviteOutcome; label: string }[] = [
  { outcome: 'pending', label: 'Autorização pendente' },
  { outcome: 'granted', label: 'Acesso concedido' },
  { outcome: 'expired', label: 'Convite expirado' },
  { outcome: 'revoked', label: 'Acesso revogado' },
]

/** Demo only: the viewer answers for the protocol, step by step. Clearly fictional, never rendered in real mode. */
function DemoInviteControls({ state, dispatch }: { state: InviteState; dispatch: (e: InviteEvent) => void }) {
  const buttons = state === 'validating'
    ? DEMO_OUTCOMES.map((o) => ({ key: o.outcome, label: o.label, run: () => dispatch({ type: 'validated', outcome: o.outcome }) }))
    : state === 'pending'
      ? [{ key: 'auth', label: 'Administrador autoriza', run: () => dispatch({ type: 'authorized' }) }, { key: 'rev', label: 'Administrador revoga', run: () => dispatch({ type: 'revoked' }) }]
      : state === 'granted'
        ? [{ key: 'rev', label: 'Administrador revoga', run: () => dispatch({ type: 'revoked' }) }]
        : []
  return (
    <div className="rounded-lg bg-brand-elevated p-3">
      <p className="text-caption text-brand-text-secondary">
        <Badge variant="outline" className="mr-1.5 border-transparent bg-brand-tonal font-medium text-brand-text">Demonstração</Badge>
        Convite fictício: aqui você responde no lugar do protocolo. Nada disso é real.
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
      copy={INVITE_COPY}
      state={state}
      contractAvailable={demo}
      unavailableNote={<WireNote ids={['marketInvite', 'marketMembership']} />}
      qrEntry={<WirePlanned id="marketInviteQr" description="Para ler um convite com a câmera do aparelho." />}
      demoControls={demo && state !== 'idle' ? <DemoInviteControls state={state} dispatch={dispatch} /> : undefined}
      onSubmit={() => dispatch({ type: 'submit' })}
      onReset={() => dispatch({ type: 'reset' })}
    />
  )
}

/** Each prototype screen and the loose wires it waits for (rendered on /dev/design-system). */
export const NODES_MARKETS_SCREENS: readonly { screen: string; where: string; wires: readonly LooseWireId[] }[] = [
  { screen: 'Portal de mercados', where: 'Market (ao lado do título)', wires: ['marketDiscovery', 'marketMembership'] },
  { screen: 'Cartão de descoberta e chamadas', where: 'Market, lista vazia, Perfil, Configurações → Comunidades', wires: ['marketDiscovery', 'createMarket'] },
  { screen: 'Explorar mercados', where: 'Market → Mercados (/markets)', wires: ['marketDiscovery'] },
  { screen: 'Meus mercados', where: 'Market → Mercados (/markets/mine)', wires: ['marketMembership', 'marketPortability'] },
  { screen: 'Criar mercado', where: 'Market → Mercados (/markets/new)', wires: ['createMarket', 'marketBranding', 'marketInvite'] },
  { screen: 'Entrar com convite', where: 'Market → Mercados (/markets/join)', wires: ['marketInvite', 'marketInviteQr', 'marketMembership'] },
  { screen: 'Rede Sails e conexão', where: 'Configurações → Rede e nós', wires: ['nodeCatalog'] },
  { screen: 'Adicionar nó manualmente', where: 'Configurações → Rede e nós', wires: ['nodeCatalog', 'manualServer'] },
  { screen: 'Avançado: nós, operadores e diagnóstico', where: 'Configurações → Rede e nós', wires: ['nodeCatalog', 'nodeStateSync', 'connectionDiagnostics'] },
]

/** Every invite state, static, for the dev gallery. */
export function InviteStateGallery() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {INVITE_STATES.filter((s) => s !== 'idle').map((s) => <InviteStatus key={s} state={s} copy={INVITE_COPY} />)}
    </div>
  )
}
