/**
 * Layer C: the ways into markets from the rest of the app (DECISIONS.md "Modelo mundo aberto"):
 * - MarketPortalButton: "Mercado aberto ▾" next to the Market title. Real mode lists only Mercado aberto; demo adds
 *   fictional markets (listed, not selectable: no market offers exist in the protocol) and, after a fictional invite
 *   is granted, that market right after Mercado aberto.
 * - MarketsDiscoveryCard: a small card in the Market, shown until dismissed, then hidden for 30 days.
 * - MarketsCallToAction: the same invitation in natural places (empty offer list, Perfil).
 */
import { useState } from 'react'
import { Link } from 'react-router'
import { X } from 'lucide-react'
import { MarketPortal, type MarketPortalAction, type MarketPortalCopy } from '../../components/markets/MarketPortal'
import { ActionIcon, MARKET_ACTION_ICON } from '../../components/markets/MarketIcon'
import { IconButton } from '../../components/ui/icon-button'
import { buttonVariants } from '../../components/ui/button'
import { MARKETS_ROUTES } from '../../components/layout/navMatch'
import { dismissDiscovery, readDiscoveryDismissedAt, shouldShowDiscovery } from '../../lib/discoveryCard'
import { ownMarkets } from '../../lib/myMarkets'
import { cn } from '../../lib/utils'
import { marketListCopy, marketsValueLine, useVisibleMarkets } from './shared'
import { t } from '../../i18n'

function portalActions(): readonly MarketPortalAction[] {
  return [
    { id: 'explore', label: t('markets.action.explore'), description: t('markets.action.exploreDescription'), icon: MARKET_ACTION_ICON.explore, to: MARKETS_ROUTES.explore },
    { id: 'join', label: t('markets.action.join'), description: t('markets.action.joinDescription'), icon: MARKET_ACTION_ICON.invite, to: MARKETS_ROUTES.join },
    { id: 'create', label: t('markets.action.create'), description: t('markets.action.createDescription'), icon: MARKET_ACTION_ICON.create, to: MARKETS_ROUTES.create },
  ]
}

function portalCopy(): MarketPortalCopy {
  const list = marketListCopy()
  return {
    triggerPrefix: t('markets.portal.triggerPrefix'),
    title: t('markets.title'),
    yourMarkets: t('markets.portal.yourMarkets'),
    actionsTitle: t('markets.portal.actionsTitle'),
    current: t('markets.portal.current'),
    close: t('common.close'),
    marketLine: (m) => m.relation === 'default'
      ? t('markets.default.description')
      : t('markets.portal.marketLine', { visibility: list.visibility[m.visibility], relation: list.relation[m.relation] }),
    unavailable: t('common.soon'),
    unavailableReason: () => t('markets.portal.unavailableReason'),
    illustrative: t('markets.fictionalExample'),
  }
}

export function MarketPortalButton({ className }: { className?: string }) {
  const markets = ownMarkets(useVisibleMarkets())
  return (
    <MarketPortal
      current={markets[0]}
      markets={markets}
      // Until market offers exist (LOOSE_WIRES.marketMembership), only Mercado aberto can be entered.
      isSelectable={(m) => m.relation === 'default'}
      onSelect={() => undefined}
      actions={portalActions()}
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
