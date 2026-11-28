/**
 * Layer C: one market's page (/markets/:id, DECISIONS.md "Mercados (Market Spaces)"). Future reads:
 * sails.markets.get(id), liquidity.discover({ marketId }) and, for the admin, sails.markets.members(id) (public keys
 * only). None exists yet, so real mode shows the honest "Em preparação" state, and only demo mode (?demo=1) renders
 * fictional markets, every one marked. A private market the person has not joined answers like the backend will
 * (404): "não encontrado ou sem acesso", never confirming that it exists. The group chat is demonstration/roadmap,
 * apart from the per-trade chat (the only real chat).
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router'
import { ArrowLeft, ExternalLink, MessageCircle, SearchX, Ticket, UserMinus } from 'lucide-react'
import { Page, PageHeader } from '../components/layout/PageHeader'
import { MARKETS_ROUTES, TRADES_ROUTES, marketPath } from '../components/layout/navMatch'
import { Badge } from '../components/ui/badge'
import { buttonVariants } from '../components/ui/button'
import { StateBlock } from '../components/ui/StateBlock'
import { IdentityAvatar } from '../components/ui/IdentityAvatar'
import { Input } from '../components/ui/input'
import { MarketBanner } from '../components/markets/MarketBanner'
import { MarketIcon } from '../components/markets/MarketIcon'
import { AdminImage } from '../components/markets/AdminImage'
import { IconButton } from '../components/ui/icon-button'
import { MarketChats, type OpenPrivateRequest } from './markets/MarketChats'
import { Tabs, tabPanelProps } from '../components/ui/tabs'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { FilterChip } from '../components/ui/filter-chip'
import { Button } from '../components/ui/button'
import { demoDecideRequest, demoJoin, demoJoinRequests, demoMarketPage, demoMarkets, demoRemoveMember, isDemoMode, subscribeDemoMarkets } from '../lib/demoMarkers'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { RadioCard, RadioGroup } from '../components/ui/radio-group'
import { useAuth } from '../context/AuthContext'
import { canSeeOffers, kycSummary, offersForMarket } from '../lib/marketSpaces'
import { fetchOffers } from '../lib/realOffers'
import { OfferCard } from '../components/marketplace/OfferCard'
import { sellerTrust } from '../components/marketplace/offerList'
import { ListSkeleton } from '../components/ui/skeleton'
import { pairForAssetType } from '../lib/assetCatalog'
import { offerPaymentMethods } from '../lib/paymentMethods'
import { PAYMENT_METHOD_LABELS } from '../lib/labels'
import { formatPrice } from '../lib/currency'
import type { Offer } from '../types'
import { formatMonthYear } from '../lib/format'
import { cn } from '../lib/utils'
import { adminImageCopy, categoryLabel, DemoVerifiedSeal, kycDetails, kycText, marketListCopy, profileLabel, simulatedToast, socialNames, WireNote } from './markets/shared'
import { t } from '../i18n'

const SECTION = 'rounded-lg bg-brand-surface p-3 sm:p-4'
const TAG = 'border-transparent bg-brand-tonal font-medium text-brand-text-secondary'
// The community's house rules (demo), cited when the admin removes someone.
const RULES = ['spaces.rules.inTrade', 'spaces.rules.respect', 'spaces.rules.noSpam'] as const
// The viewer's side, as in the Market list: a sell offer is bought.
const viewerSide = (offerSide: 'BUY' | 'SELL'): 'BUY' | 'SELL' => (offerSide === 'SELL' ? 'BUY' : 'SELL')

/** Start and end always visible, the whole key for screen readers (DECISIONS.md "Chave pública no Perfil"). */
function MonoKey({ value }: { value: string }) {
  return (
    <span translate="no" className="font-mono text-caption text-brand-text">
      {value.length <= 12 ? value : <><span aria-hidden="true">{value.slice(0, 4)}…{value.slice(-4)}</span><span className="sr-only">{value}</span></>}
    </span>
  )
}

function Fact({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="text-caption text-brand-text-muted sm:w-44 sm:shrink-0">{k}</dt>
      <dd className="min-w-0 break-words text-body-sm text-brand-text">{children}</dd>
    </div>
  )
}

function ExternalAdminLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="inline-flex min-h-8 touch:min-h-11 items-center gap-1 text-brand-link underline-offset-2 hover:underline">
      {label}<ExternalLink aria-hidden="true" className="size-icon-xs shrink-0" />
      <span className="text-caption text-brand-text-muted">({t('spaces.adminLink')})</span>
    </a>
  )
}

function NotFound() {
  return (
    <StateBlock
      kind="empty"
      icon={SearchX}
      title={t('spaces.page.notFoundTitle')}
      description={t('spaces.page.notFoundBody')}
      action={
        <Link to={MARKETS_ROUTES.join} className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'touch:min-h-11')}>
          <Ticket aria-hidden="true" />{t('markets.action.join')}
        </Link>
      }
    />
  )
}

export function MarketPage() {
  const { id = '' } = useParams()
  const snapshot = useSyncExternalStore(subscribeDemoMarkets, demoMarkets)
  const idBase = useId()
  // ?tab=chat&peer=…&name=… ("Voltar à conversa"): reopen Conversas › Privadas on that thread.
  const [params] = useSearchParams()
  const [tab, setTab] = useState<'offers' | 'chat' | 'about'>(() => (params.get('tab') === 'chat' ? 'chat' : 'offers'))
  const [side, setSide] = useState<'all' | 'BUY' | 'SELL'>('all')
  const [asset, setAsset] = useState<string | null>(null)
  const [chatRequest, setChatRequest] = useState<OpenPrivateRequest | null>(() => {
    const peer = params.get('peer')
    return peer ? { peer: { author: (params.get('name') ?? '').slice(0, 60), seed: peer }, key: 1 } : null
  })
  const { user } = useAuth()
  const [rulesOpen, setRulesOpen] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [removeRule, setRemoveRule] = useState<string | null>(null)
  // These dialogs open without a Radix trigger: remember who opened them and give focus back on close.
  const opener = useRef<HTMLElement | null>(null)
  const remember = () => { opener.current = document.activeElement as HTMLElement | null }
  const returnFocus = (e: Event) => { e.preventDefault(); opener.current?.focus() }
  const [inviteOpen, setInviteOpen] = useState(false)
  const [invites, setInvites] = useState<readonly string[]>([])
  const [inviteKey, setInviteKey] = useState('')
  // Demo: the demo backend's offers, a share of them per market (lib/marketSpaces.ts offersForMarket).
  const [demoOffers, setDemoOffers] = useState<Offer[] | null>(null)
  const [offersError, setOffersError] = useState(false)
  useEffect(() => {
    if (!isDemoMode()) return
    let cancelled = false
    fetchOffers('Todos', 'Todos').then(({ offers, hadError }) => { if (!cancelled) { setDemoOffers(offers); setOffersError(hadError && offers.length === 0) } })
    return () => { cancelled = true }
  }, [])
  if (id === 'public') return <Navigate to="/" replace />
  const demo = isDemoMode()
  const page = demo ? demoMarketPage(id, snapshot) : null
  const back = (
    <Link to={MARKETS_ROUTES.explore} className="inline-flex touch:min-h-11 items-center gap-1 text-body-sm text-brand-text-secondary hover:text-brand-text">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t('spaces.page.back')}
    </Link>
  )

  // Real mode: no market can be read yet (sails.markets.get), so no page claims to exist.
  if (!demo) {
    return (
      <Page width="detail">
        <PageHeader title={t('spaces.page.preparingTitle')} back={back} />
        <div className={cn(SECTION, 'space-y-3')}>
          <p className="text-body-sm text-brand-text-secondary">{t('spaces.page.preparingBody')}</p>
          <WireNote ids={['marketPage', 'marketMembership']} badge={t('spaces.preparing')} />
        </div>
      </Page>
    )
  }
  // Unknown id, or a private market the person has not joined: the same answer (the backend will return 404).
  if (!page || !canSeeOffers(page.market)) {
    return (
      <Page width="detail">
        <PageHeader title={t('spaces.page.back')} back={back} />
        <NotFound />
      </Page>
    )
  }

  const m = page.market
  const requests = m.relation === 'admin' ? demoJoinRequests(m.id) : []
  const list = marketListCopy()
  const kyc = kycSummary(m.entryPolicy)
  const social = m.entryPolicy?.social ?? []
  const category = categoryLabel(m)
  const profile = profileLabel(m)
  const presetRules = m.preset === 'vitrine'
    ? { publishes: t('markets.preview.rules.vitrinePublishes'), trades: t('markets.preview.rules.vitrineTrades') }
    : { publishes: t('markets.preview.rules.members'), trades: t('markets.preview.rules.members') }
  // Keeps 3:1 in the detail column; capped on wide screens so it never pushes the content below the fold.
  const banner = <MarketBanner market={m} image={m.bannerImage} className="md:max-h-40" />

  const all = page.hasOffers ? offersForMarket(demoOffers ?? [], m.id) : []
  const offers = all.filter((o) => (side === 'all' || viewerSide(o.side) === side) && (!asset || o.asset === asset))
  const assets = [...new Set(all.map((o) => o.asset))]
  const talk = (o: Offer) => {
    const name = sellerTrust(o).name ?? t('market.offer.seller')
    setChatRequest({
      peer: { author: name, seed: o.userId || o.id },
      context: t('spaces.offers.context', { side: viewerSide(o.side) === 'BUY' ? t('labels.side.buy') : t('labels.side.sell'), asset: pairForAssetType(o.asset)?.label ?? o.asset, price: formatPrice(o.priceFiat, o.fiatCurrency), method: offerPaymentMethods(o).map((x) => PAYMENT_METHOD_LABELS[x]).join(', ') }),
      side: viewerSide(o.side),
      offerId: o.id,
      key: Date.now(),
    })
    setTab('chat')
  }

  // Join action: inline with the title on phones (so the first offer is above the fold), under the description from sm.
  const join = m.relation !== 'none' || m.visibility !== 'public' ? null : m.joinPending ? (
    <>
      <Badge variant="outline" className={TAG}>{t('spaces.join.pending')}</Badge>
      <Button type="button" size="sm" variant="ghost" onClick={() => { demoJoin(m.id, 'cancel'); simulatedToast() }} className="touch:min-h-11">{t('spaces.join.cancel')}</Button>
      <Button type="button" size="sm" variant="secondary" onClick={() => { demoJoin(m.id, 'approved'); simulatedToast(t('spaces.join.approvedToast')) }} className="touch:min-h-11">{t('spaces.join.simulateApprove')}</Button>
    </>
  ) : (
    <Button type="button" size="sm" variant="secondary" onClick={() => { remember(); setRulesOpen(true) }} className="touch:min-h-11">{m.entryType === 'approval' ? t('spaces.join.request') : t('spaces.join.join')}</Button>
  )

  return (
    <Page width="detail">
      <PageHeader className="max-sm:mb-4" title={m.name} titleAside={join && <div className="flex flex-wrap items-center gap-2 sm:hidden">{join}</div>} meta={m.visibility === 'private' ? list.visibility.private : list.visibility.public} back={back} />
      <div className="space-y-3 sm:space-y-4">
        <section aria-label={m.name} className={SECTION}>
          {/* Phones (< 640 px): a compact hero without the banner, so the first offers fit above the fold. */}
          <div className="hidden sm:block">{m.remoteBanner ? <AdminImage url={m.remoteBanner} placeholder={banner} copy={adminImageCopy()} alt="" /> : banner}</div>
          <div className="flex items-start gap-3 sm:mt-3">
            <MarketIcon market={m} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] sm:flex-wrap [&>*]:shrink-0 [&>*]:whitespace-nowrap">
                {profile && <Badge variant="outline" className="border-transparent bg-brand-tonal font-medium text-brand-text">{profile}</Badge>}
                {page.verified && <DemoVerifiedSeal explain calculatedAt={page.verifiedAt} />}
                {m.ownedByYou ? <Badge variant="outline" className={TAG}>{t('spaces.ownedByYou')}</Badge> : m.illustrative && <Badge variant="outline" className={TAG}>{list.illustrative}</Badge>}
              </div>
              {m.description && <p className="mt-1 line-clamp-1 break-words text-body-sm text-brand-text-secondary sm:line-clamp-none">{m.description}</p>}
              <p className="mt-1 tabular-nums text-caption text-brand-text-muted">{m.participants !== undefined ? t('spaces.participants', { count: m.participants }) : ''}{m.relation !== 'none' ? ` · ${list.relation[m.relation]}` : ''}</p>
              {join && <div className="mt-2 hidden flex-wrap items-center gap-2 sm:flex">{join}</div>}
            </div>
          </div>
        </section>

        {/* Offers first (PO 2026-11-22): what is available, at once; the chat is optional. */}
        <Tabs
          idBase={idBase}
          label={m.name}
          value={tab}
          onChange={setTab}
          items={[{ value: 'offers', label: t('spaces.page.tabOffers') }, { value: 'chat', label: t('spaces.page.tabChats') }, { value: 'about', label: t('spaces.page.tabAbout') }]}
        />

        <div {...tabPanelProps(idBase, 'offers')} hidden={tab !== 'offers'} className={cn(SECTION, 'space-y-3')}>
          {page.hasOffers && demoOffers === null && !offersError ? <ListSkeleton label={t('spaces.offers.loading')} rows={3} /> : offersError ? (
            <StateBlock kind="error" bare title={t('spaces.offers.error')} />
          ) : all.length === 0 ? (
            <div className="space-y-3 py-4 text-center">
              <p className="text-body-sm text-brand-text">{t('spaces.offers.empty')}</p>
              <Link to={`${TRADES_ROUTES.newOffer}?market=${encodeURIComponent(m.id)}&back=${encodeURIComponent(marketPath(m.id))}`} className={cn(buttonVariants({ variant: 'secondary' }), 'touch:min-h-11')}>{t('spaces.offers.publishHere')}</Link>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <SegmentedControl label={t('spaces.offers.sideLabel')} value={side} onChange={setSide} options={[{ value: 'all', label: t('spaces.offers.all') }, { value: 'BUY', label: t('labels.side.buy') }, { value: 'SELL', label: t('labels.side.sell') }]} />
                {assets.length > 1 && (
                  <div role="group" aria-label={t('spaces.offers.assetLabel')} className="flex flex-wrap gap-2">
                    {assets.map((a) => <FilterChip key={a} label={pairForAssetType(a)?.label ?? a} selected={asset === a} onToggle={() => setAsset(asset === a ? null : a)} />)}
                  </div>
                )}
              </div>
              {m.visibility === 'private' && <p className="text-caption text-brand-text-muted">{t('spaces.page.privateAccess')}</p>}
              {offers.length === 0 ? <p className="text-body-sm text-brand-text-secondary">{t('spaces.offers.noMatch')}</p> : (
                // The Market's own rows (OfferCard): the action opens the demo trade flow, like the main list.
                <ul className="divide-y divide-brand-border-subtle">
                  {offers.map((o) => (
                    <li key={o.id}>
                      <OfferCard offer={o} />
                      <div className="flex justify-end pb-2">
                        <Button type="button" size="sm" variant="ghost" onClick={() => talk(o)} aria-label={t('spaces.chat.privateWith', { name: sellerTrust(o).name ?? t('market.offer.seller') })} className="touch:min-h-11"><MessageCircle aria-hidden="true" />{t('spaces.offers.talk')}</Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <div {...tabPanelProps(idBase, 'chat')} hidden={tab !== 'chat'} className={SECTION}>
          <MarketChats openWith={chatRequest} backTo={marketPath(m.id)} canPin={m.relation === 'admin'} />
        </div>

        <div {...tabPanelProps(idBase, 'about')} hidden={tab !== 'about'} className="space-y-4">
          <section aria-labelledby="market-facts" className={SECTION}>
            <h2 id="market-facts" className="sr-only">{t('spaces.page.tabAbout')}</h2>
            <dl className="divide-y divide-brand-border-subtle">
              {category && <Fact k={t('spaces.create.category')}>{category}</Fact>}
              <Fact k={t('spaces.page.participants')}><span className="tabular-nums">{m.participants !== undefined ? t('spaces.participants', { count: m.participants }) : t('common.soon')}</span></Fact>
              {m.preset && <Fact k={t('spaces.page.model')}>{list.preset[m.preset]}</Fact>}
              <Fact k={t('spaces.page.createdAt')}>{formatMonthYear(page.createdAt)}</Fact>
              <Fact k={list.infrastructureLabel.replace(/:$/, '')}>{list.infrastructure[m.infrastructure]}</Fact>
            </dl>
            {m.visibility === 'private' && <p className="mt-2 text-caption text-brand-text-secondary">{t('spaces.page.singleNode')}</p>}
          </section>

          <section aria-labelledby="market-rules" className={SECTION}>
            <h2 id="market-rules" className="text-section-title">{t('spaces.page.rulesTitle')}</h2>
            <dl className="mt-2 divide-y divide-brand-border-subtle">
              <Fact k={t('markets.preview.publishes')}>{presetRules.publishes}</Fact>
              <Fact k={t('markets.preview.trades')}>{presetRules.trades}</Fact>
              <Fact k={t('spaces.page.kyc')}>
                {kycText(kyc)}
                {kycDetails(m.entryPolicy).map((line) => <span key={line} className="block text-caption text-brand-text-secondary">{line}</span>)}
                {kyc.kind !== 'none' && kyc.formUrl && <div><ExternalAdminLink href={kyc.formUrl} label={t('spaces.page.kycForm')} /></div>}
              </Fact>
              <Fact k={t('spaces.page.social')}>{social.length > 0 ? socialNames(social) : t('spaces.page.socialNone')}</Fact>
            </dl>
            <p className="mt-2 text-caption text-brand-text-secondary">{t('spaces.page.policyNote')}</p>
          </section>

          {m.relation === 'admin' && m.visibility === 'private' && (
            <section aria-labelledby="market-invites" className={SECTION}>
              <h2 id="market-invites" className="text-section-title">{t('spaces.invite.title')}</h2>
              <p className="mt-1 text-caption text-brand-text-secondary">{t('markets.create.invites.identifierHelp')}</p>
              <Button type="button" variant="secondary" onClick={() => { remember(); setInviteOpen(true) }} className="mt-2 touch:min-h-11">{t('spaces.invite.open')}</Button>
              {invites.length > 0 && (
                <ul className="mt-2 divide-y divide-brand-border-subtle">
                  {invites.map((k) => <li key={k} className="flex items-center gap-2 py-1.5"><span translate="no" className="min-w-0 flex-1 break-all font-mono text-caption text-brand-text">{k}</span><Badge variant="outline" className={TAG}>{t('markets.create.invites.pending')}</Badge></li>)}
                </ul>
              )}
            </section>
          )}
          {m.relation === 'admin' && requests.length > 0 && (
            <section aria-labelledby="market-requests" className={SECTION}>
              <h2 id="market-requests" className="text-section-title">{t('spaces.admin.requests', { count: requests.length })}</h2>
              <ul className="mt-2 divide-y divide-brand-border-subtle">
                {requests.map((k) => (
                  <li key={k} className="flex flex-wrap items-center gap-2 py-1.5">
                    <IdentityAvatar seed={k} size={28} />
                    <span className="min-w-0 flex-1 text-caption text-brand-text-secondary">{t('spaces.admin.requestRow')} · <MonoKey value={k} /></span>
                    <Button type="button" size="sm" variant="ghost" onClick={() => { demoDecideRequest(k, false); simulatedToast() }} className="touch:min-h-11">{t('spaces.admin.reject')}</Button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => { demoDecideRequest(k, true); simulatedToast() }} className="touch:min-h-11">{t('spaces.admin.approve')}</Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {m.relation === 'admin' && (
            <section aria-labelledby="market-members" className={SECTION}>
              <h2 id="market-members" className="text-section-title">{t('spaces.page.membersTitle')}</h2>
              <p className="mt-1 text-caption text-brand-text-secondary">{t('spaces.page.membersLead')}</p>
              {page.memberKeys.length === 0 ? (
                <p className="mt-2 text-body-sm text-brand-text-secondary">{t('markets.create.invites.empty')}</p>
              ) : (
                <ul aria-label={t('spaces.page.membersTitle')} className="mt-2 divide-y divide-brand-border-subtle">
                  {page.memberKeys.map((k) => (
                    <li key={k} className="flex items-center gap-2 py-1">
                      <IdentityAvatar seed={k} size={28} />
                      <span className="min-w-0 flex-1 text-caption text-brand-text-secondary">{t('spaces.admin.memberRow')} · <MonoKey value={k} /></span>
                      <IconButton
                        label={t('spaces.chat.privateWith', { name: `${k.slice(0, 10)}…` })}
                        size="sm"
                        onClick={() => { setChatRequest({ peer: { author: `${k.slice(0, 10)}…${k.slice(-8)}`, seed: k }, key: Date.now() }); setTab('chat') }}
                      >
                        <MessageCircle aria-hidden="true" />
                      </IconButton>
                      <IconButton label={t('spaces.admin.removeWho', { name: `${k.slice(0, 10)}…` })} size="sm" onClick={() => { remember(); setRemoving(k) }}>
                        <UserMinus aria-hidden="true" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>
      {/* "Regras da comunidade": one decision, one button. */}
      <Dialog open={rulesOpen} onOpenChange={setRulesOpen}>
        <DialogContent className="max-w-lg" onCloseAutoFocus={returnFocus}>
          <DialogHeader className="pr-10 text-left">
            <DialogTitle>{t('spaces.join.rulesTitle')}</DialogTitle>
            <DialogDescription>{m.entryType === 'approval' ? t('spaces.join.rulesLeadApproval') : t('spaces.join.rulesLead')}</DialogDescription>
          </DialogHeader>
          <ul className="space-y-1.5 text-body-sm text-brand-text">
            <li>{presetRules.publishes}</li>
            <li>{kycText(kyc)}</li>
            {kycDetails(m.entryPolicy, { dataHandling: true }).map((line) => <li key={line}>{line}</li>)}
            {RULES.map((r) => <li key={r}>{t(r)}</li>)}
          </ul>
          <p className="text-caption text-brand-text-secondary">{t('spaces.page.policyNote')}</p>
          <Button type="button" variant={user ? 'default' : 'secondary'} onClick={() => { setRulesOpen(false); demoJoin(m.id, m.entryType === 'approval' ? 'request' : 'join'); simulatedToast(m.entryType === 'approval' ? t('spaces.join.requestedToast') : undefined) }} className="touch:min-h-11">
            {m.entryType === 'approval' ? t('spaces.join.acceptRequest') : t('spaces.join.accept')}
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="max-w-lg" onCloseAutoFocus={returnFocus}>
          <DialogHeader className="pr-10 text-left">
            <DialogTitle>{t('spaces.invite.open')}</DialogTitle>
            <DialogDescription>{t('markets.create.invites.identifierHelp')}</DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); const v = inviteKey.trim(); if (!v) return; setInvites((l) => (l.includes(v) ? l : [...l, v])); setInviteKey(''); setInviteOpen(false); simulatedToast() }}>
            <label htmlFor="invite-identifier" className="text-sm font-medium text-brand-text">{t('markets.create.invites.identifier')}</label>
            <Input id="invite-identifier" name="invite-identifier" autoComplete="off" spellCheck={false} value={inviteKey} onChange={(e) => setInviteKey(e.target.value)} />
            <div className="flex justify-end"><Button type="submit" variant="secondary" disabled={!inviteKey.trim()} className="touch:min-h-11">{t('markets.create.invites.generate')}</Button></div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={removing !== null} onOpenChange={(o) => { if (!o) setRemoving(null) }}>
        <DialogContent className="max-w-lg" onCloseAutoFocus={returnFocus}>
          <DialogHeader className="pr-10 text-left">
            <DialogTitle>{t('spaces.admin.removeTitle')}</DialogTitle>
            <DialogDescription>{t('spaces.admin.removeLead')}</DialogDescription>
          </DialogHeader>
          <RadioGroup legend={t('spaces.admin.ruleLegend')} listClassName="grid gap-2">
            {RULES.map((r) => <RadioCard key={r} name="remove-rule" value={r} checked={removeRule === r} onChange={() => setRemoveRule(r)}>{t(r)}</RadioCard>)}
          </RadioGroup>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={() => setRemoving(null)} className="touch:min-h-11">{t('common.cancel')}</Button>
            <Button type="button" variant="destructive" disabled={!removeRule} onClick={() => { if (removing) demoRemoveMember(removing); setRemoving(null); setRemoveRule(null); simulatedToast(t('spaces.admin.removedToast')) }} className="touch:min-h-11">{t('spaces.admin.remove')}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </Page>
  )
}
