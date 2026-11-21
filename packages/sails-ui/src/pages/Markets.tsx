/**
 * Markets hub (/markets, CTO final correction for plan 1.4, issue #147): markets are the product and live inside the
 * Market area, under the same "Market" menu item. Four route tabs: Explorar mercados, Meus mercados, Criar mercado,
 * Entrar com convite. The offer list at '/' stays the Market's landing. Everything here is a prototype: no market
 * contract exists, so real mode shows only the default public market and every backend action is "Em breve"; demo
 * mode (?demo=1) adds fictional markets and lets the create and invite flows be walked, clearly marked.
 */
import { useState } from 'react'
import { Link, useLocation } from 'react-router'
import { ArrowLeft, UsersRound } from 'lucide-react'
import { Page, PageHeader } from '../components/layout/PageHeader'
import { MARKETS_ROUTES } from '../components/layout/navMatch'
import { TabLinks } from '../components/ui/tabs'
import { Card } from '../components/ui/card'
import { Alert } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { buttonVariants } from '../components/ui/button'
import { MarketList } from '../components/markets/MarketList'
import { FactList } from '../components/markets/FactList'
import { CreateMarketWizard, type CreateMarketCopy } from '../components/markets/CreateMarketWizard'
import { isDemoMode } from '../lib/demoMarkers'
import { cn } from '../lib/utils'
import { GUARANTEES, IDENTIFIERS, JoinMarketPanel, MARKET_LIST_COPY, MARKETS_VALUE_LINE, SOON, WireNote, WirePlanned, useVisibleMarkets } from './markets/shared'
import { MarketIcon, MARKET_ACTION_ICON } from '../components/markets/MarketIcon'
import { ownMarkets } from '../lib/myMarkets'

const TAB_ICON = 'h-4 w-4 shrink-0'
const TABS = [
  { to: MARKETS_ROUTES.explore, label: <><MARKET_ACTION_ICON.explore aria-hidden="true" className={TAB_ICON} />Explorar mercados</> },
  { to: MARKETS_ROUTES.mine, label: <><UsersRound aria-hidden="true" className={TAB_ICON} />Meus mercados</> },
  { to: MARKETS_ROUTES.create, label: <><MARKET_ACTION_ICON.create aria-hidden="true" className={TAB_ICON} />Criar mercado</> },
  { to: MARKETS_ROUTES.join, label: <><MARKET_ACTION_ICON.invite aria-hidden="true" className={TAB_ICON} />Entrar com convite</> },
]

const SURFACE = 'border-brand-border-subtle bg-brand-surface p-4'

const CREATE_COPY: CreateMarketCopy = {
  steps: {
    identity: 'Nome, descrição e identidade visual',
    visibility: 'Visibilidade',
    participation: 'Participação e permissões',
    infrastructure: 'Infraestrutura',
    review: 'Revisão',
    invites: 'Participantes e convites',
  },
  progress: (at, total, title) => `Passo ${at} de ${total}: ${title}`,
  name: 'Nome do mercado',
  nameHelp: (max) => `Até ${max} caracteres. As pessoas vão reconhecer o mercado por este nome.`,
  description: 'Descrição',
  descriptionOptional: '(opcional)',
  visibility: [
    { value: 'public', label: 'Público', description: 'Qualquer pessoa na Rede Sails pode encontrar o mercado e ver as ofertas.' },
    { value: 'private', label: 'Privado', description: 'Só quem tiver um convite Sails autorizado entra e vê as ofertas.' },
  ],
  visibilityNote: 'A visibilidade não define quem publica. Isso é o próximo passo.',
  participation: [
    { value: 'vitrine', label: 'Vitrine', description: 'Publicam o administrador ou participantes autorizados. Negociam clientes e membros autorizados.' },
    { value: 'comunidade', label: 'Comunidade', description: 'Todos os membros autorizados publicam e negociam.' },
    { value: 'personalizado', label: 'Personalizado (futuro)', description: 'Permissões configuradas uma a uma.', disabled: true },
  ],
  participationNote: 'Atalhos opcionais para configurar permissões, não limites do protocolo.',
  infrastructure: [
    { value: 'network', label: 'Rede Sails (padrão)', description: 'O mercado usa a Rede Sails. Você não mantém nenhuma máquina, quando a rede oferecer hospedagem.' },
    { value: 'own', label: 'Nó próprio', description: 'O mercado roda num nó Sails que você mantém. Adicione o nó em Configurações → Rede e nós.' },
  ],
  infrastructureNote: 'Configuração técnica. Pode ficar no padrão.',
  review: { name: 'Nome', description: 'Descrição', visibility: 'Visibilidade', participation: 'Participação', infrastructure: 'Infraestrutura', empty: 'Não informado' },
  back: 'Voltar',
  next: 'Continuar',
  create: 'Criar mercado',
}

// The 2×2 of visibility × infrastructure (CTO final correction): one example each, all independent choices.
const EXAMPLES: readonly { visibility: string; infrastructure: string; example: string }[] = [
  { visibility: 'Público', infrastructure: 'Rede Sails', example: 'Empresa com vitrine e marca própria, sem manter infraestrutura' },
  { visibility: 'Público', infrastructure: 'Nó próprio', example: 'Operador com um mercado aberto independente' },
  { visibility: 'Privado', infrastructure: 'Rede Sails', example: 'Grupo de amigos ou comunidade fechada' },
  { visibility: 'Privado', infrastructure: 'Nó próprio', example: 'Empresa com mercado exclusivo para parceiros' },
]

const PRESET_LABEL = MARKET_LIST_COPY.preset
const TAG = 'border-transparent bg-brand-tonal font-medium text-brand-text-secondary'

/** Showcase of public markets (DECISIONS.md "Modelo mundo aberto"): its own shareable route, /markets. */
function ExploreView() {
  const publics = useVisibleMarkets().filter((m) => m.visibility === 'public')
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-brand-surface p-4">
        <p className="min-w-0 flex-1 basis-60 text-body-sm text-brand-text">{MARKETS_VALUE_LINE}</p>
        <Link to={MARKETS_ROUTES.create} className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'shrink-0 touch:min-h-11')}>
          <MARKET_ACTION_ICON.create aria-hidden="true" />Criar mercado
        </Link>
      </div>
      <ul aria-label="Mercados públicos" className="grid gap-3 sm:grid-cols-2">
        {publics.map((m) => (
          <li key={m.id} className="flex flex-col gap-3 rounded-lg bg-brand-surface p-4">
            <div className="flex items-start gap-3">
              <MarketIcon market={m} size="lg" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h2 className="text-sm font-medium text-brand-text">{m.name}</h2>
                  {m.illustrative && <Badge variant="outline" className={TAG}>{MARKET_LIST_COPY.illustrative}</Badge>}
                </div>
                <p className="mt-0.5 text-caption text-brand-text-secondary">{m.description}</p>
              </div>
            </div>
            <dl className="flex flex-wrap gap-x-4 gap-y-1 text-caption">
              <div className="flex gap-1">
                <dt className="text-brand-text-muted">Participantes:</dt>
                <dd className="tabular-nums text-brand-text">{m.participants !== undefined ? m.participants.toLocaleString('pt-BR') : SOON}</dd>
              </div>
              <div className="flex gap-1">
                <dt className="text-brand-text-muted">Modelo:</dt>
                <dd className="text-brand-text">{m.preset ? PRESET_LABEL[m.preset] : m.relation === 'default' ? 'Aberto a todos' : SOON}</dd>
              </div>
            </dl>
            <div className="mt-auto">
              {m.relation === 'default'
                ? <Link to="/" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'touch:min-h-11')}>Abrir<span className="sr-only"> {m.name}</span></Link>
                : <Badge variant="outline" className="border-transparent bg-brand-tonal font-medium text-brand-text">{SOON}</Badge>}
            </div>
          </li>
        ))}
      </ul>
      {publics.length === 1 && <WirePlanned id="marketDiscovery" description="Mercados públicos de comunidades e empresas aparecem aqui, com marca, descrição e participantes, para você seguir." />}
    </div>
  )
}

function MineView() {
  const markets = ownMarkets(useVisibleMarkets())
  return (
    <Card className={cn(SURFACE, 'space-y-4')}>
      <MarketList markets={markets} copy={{ ...MARKET_LIST_COPY, label: 'Meus mercados' }} />
      {markets.length === 1 && <WirePlanned id="marketMembership" description="Os mercados públicos que você segue ou administra e os privados de que você participa aparecem aqui." />}
      <WirePlanned id="marketPortability" description="Reconhecer seus mercados depois de trocar de aplicativo ou de nó, quando houver suporte verificável. Não é recuperação automática." />
    </Card>
  )
}

function CreateView() {
  const demo = isDemoMode()
  const [created, setCreated] = useState<string | null>(null)
  return (
    <div className="space-y-6">
      <Card className={SURFACE}>
        {created ? (
          <Alert tone="info" live title="Demonstração: mercado fictício">
            “{created}” foi criado só nesta demonstração. Nada foi enviado ao protocolo.
          </Alert>
        ) : (
          <CreateMarketWizard
            copy={CREATE_COPY}
            brandingSlot={<WirePlanned id="marketBranding" description="Logo e cores do mercado." />}
            invitesSlot={<WirePlanned id="marketInvite" label="Gerenciar participantes e convites" description="Convidar participantes com convites Sails, ver quem entrou e revogar acessos." />}
            createAvailable={demo}
            unavailableNote={<WireNote ids={['createMarket']} />}
            onCreate={(d) => setCreated(d.name.trim())}
          />
        )}
      </Card>
      <section aria-labelledby="markets-examples">
        <h2 id="markets-examples" className="text-section-title">Exemplos</h2>
        <p className="mt-1 text-body-sm text-brand-text-secondary">Visibilidade e infraestrutura são escolhas separadas.</p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {EXAMPLES.map((e) => (
            <li key={`${e.visibility}-${e.infrastructure}`} className="rounded-lg bg-brand-surface p-3">
              <p className="text-caption text-brand-text-secondary">{e.visibility} · {e.infrastructure}</p>
              <p className="mt-0.5 text-body-sm text-brand-text">{e.example}</p>
            </li>
          ))}
        </ul>
      </section>
      <div className="grid gap-6 md:grid-cols-2">
        <FactList title="Garantias" facts={GUARANTEES} />
        <div>
          <FactList title="Como o Sails identifica cada parte" facts={IDENTIFIERS} />
          <p className="mt-2 text-caption text-brand-text-muted">Os formatos ainda estão em definição.</p>
        </div>
      </div>
    </div>
  )
}

function JoinView() {
  return (
    <div className="space-y-6">
      <Card className={SURFACE}>
        <p className="mb-4 text-body-sm text-brand-text-secondary">Mercados privados são separados do nó que os hospeda. Para entrar, você precisa de um convite Sails.</p>
        <JoinMarketPanel />
      </Card>
      <FactList title="Garantias" facts={GUARANTEES} />
    </div>
  )
}

export function Markets() {
  const { pathname } = useLocation()
  const view = pathname.replace(/\/+$/, '')
  return (
    <Page width="detail">
      <PageHeader
        title="Mercados"
        meta="Explore, participe ou crie mercados. O Mercado aberto continua sendo o padrão do Market."
        back={
          <Link to="/" className="inline-flex min-h-11 items-center gap-1 text-body-sm text-brand-text-secondary hover:text-brand-text md:min-h-0">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Market
          </Link>
        }
      >
        <TabLinks label="Mercados" items={TABS} className="overflow-x-auto overflow-y-hidden whitespace-nowrap [scrollbar-width:none]" />
      </PageHeader>
      {view === MARKETS_ROUTES.mine ? <MineView /> : view === MARKETS_ROUTES.create ? <CreateView /> : view === MARKETS_ROUTES.join ? <JoinView /> : <ExploreView />}
    </Page>
  )
}
