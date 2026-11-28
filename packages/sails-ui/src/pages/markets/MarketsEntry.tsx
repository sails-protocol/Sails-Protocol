/**
 * Layer C: the ways into markets from the rest of the app (DECISIONS.md "Modelo mundo aberto"):
 * - MarketPortalButton: "Mercado aberto ▾" next to the Market title. Navigation only (PO 2026-11-22): the current
 *   market, then the actions (Meus mercados shows how many markets the person has). The list itself lives in
 *   Meus mercados.
 * - MarketsDiscoveryCard: a small card in the Market, shown until dismissed, then hidden for 30 days.
 * - MarketsCallToAction: the same invitation in natural places (empty offer list, Perfil).
 */
import { useState } from 'react'
import { Link } from 'react-router'
import { UsersRound, X } from 'lucide-react'
import { MarketPortal, type MarketPortalAction, type MarketPortalCopy } from '../../components/markets/MarketPortal'
import { ActionIcon, MARKET_ACTION_ICON } from '../../components/markets/MarketIcon'
import { IconButton } from '../../components/ui/icon-button'
import { buttonVariants } from '../../components/ui/button'
import { MARKETS_ROUTES } from '../../components/layout/navMatch'
import { dismissDiscovery, readDiscoveryDismissedAt, shouldShowDiscovery } from '../../lib/discoveryCard'
import { ownMarkets } from '../../lib/myMarkets'
import { cn } from '../../lib/utils'
import { marketsValueLine, useVisibleMarkets } from './shared'
import { isDemoMode } from '../../lib/demoMarkers'
import { t } from '../../i18n'

function portalActions(mineCount: number, demo: boolean): readonly MarketPortalAction[] {
  return [
    { id: 'explore', label: t('markets.action.explore'), description: t('markets.action.exploreDescription'), icon: MARKET_ACTION_ICON.explore, to: MARKETS_ROUTES.explore },
    { id: 'mine', label: t('markets.action.mine'), description: t('spaces.portal.mineDescription'), icon: UsersRound, to: MARKETS_ROUTES.mine, meta: t('spaces.portal.mineCount', { count: mineCount }) },
    { id: 'join', label: t('markets.action.join'), description: t('markets.action.joinDescription'), icon: MARKET_ACTION_ICON.invite, to: MARKETS_ROUTES.join },
    // Buying a space is part of creating a market (PO 2026-11-22): one entry, its price learned in the first step (demo).
    { id: 'create', label: t('markets.action.create'), description: demo ? t('spaces.portal.createDescription') : t('markets.action.createDescription'), icon: MARKET_ACTION_ICON.create, to: MARKETS_ROUTES.create },
  ]
}

function portalCopy(): MarketPortalCopy {
  return {
    triggerPrefix: t('markets.portal.triggerPrefix'),
    title: t('markets.title'),
    currentTitle: t('spaces.portal.currentTitle'),
    actionsTitle: t('markets.portal.actionsTitle'),
    current: t('markets.portal.current'),
    close: t('common.close'),
    currentLine: (m) => (m.relation === 'default' ? t('markets.default.description') : m.description ?? ''),
  }
}

export function MarketPortalButton({ className }: { className?: string }) {
  const markets = ownMarkets(useVisibleMarkets())
  return (
    <MarketPortal
      // Until market offers exist (LOOSE_WIRES.marketMembership), the current market is always Mercado aberto.
      current={markets[0]}
      actions={portalActions(markets.filter((m) => m.relation !== 'default').length, isDemoMode())}
      renderLink={({ to, className: c, onClick, children }) => <Link to={to} className={c} onClick={onClick}>{children}</Link>}
      copy={portalCopy()}
      className={className}
    />
  )
}

export function MarketsDiscoveryCard({ className }: { className?: string }) {
  const [visible, setVisible] = useState(() => shouldShowDiscovery(Date.now(), readDiscoveryDismissedAt()))
  if (!visible) return null
  return (
    <aside aria-labelledby="markets-discovery-title" className={cn('flex items-start gap-3 rounded-lg bg-brand-surface p-3', className)}>
      <ActionIcon icon={MARKET_ACTION_ICON.explore} />
      <div className="min-w-0 flex-1">
        <h2 id="markets-discovery-title" className="text-sm font-medium text-brand-text">{t('markets.discovery.title')}</h2>
        <p className="mt-0.5 text-caption text-brand-text-secondary">{marketsValueLine()}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Link to={MARKETS_ROUTES.explore} className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'touch:min-h-11')}>{t('markets.action.explore')}</Link>
          <Link to={MARKETS_ROUTES.create} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'touch:min-h-11')}>{t('markets.action.create')}</Link>
        </div>
      </div>
      <IconButton label={t('common.close')} size="sm" onClick={() => { dismissDiscovery(Date.now()); setVisible(false) }}>
        <X />
      </IconButton>
    </aside>
  )
}

/** Compact invitation for natural places (empty offer list, Perfil). */
export function MarketsCallToAction({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-2', className)}>
      <Link to={MARKETS_ROUTES.explore} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'touch:min-h-11')}>
        <MARKET_ACTION_ICON.explore aria-hidden="true" />{t('markets.action.explore')}
      </Link>
      <Link to={MARKETS_ROUTES.create} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'touch:min-h-11')}>
        <MARKET_ACTION_ICON.create aria-hidden="true" />{t('markets.action.create')}
      </Link>
    </div>
  )
}
