/**
 * "Painel do espaço" (PO 2026-11-23), owner only: aggregates of THIS market. Never per-member volume, member names or
 * a ranking of members; members are counts. Demo: fictional records (demo/dashboards.ts) with the "Simulado" badge.
 * Real mode: "Em breve" (LOOSE_WIRES.marketDashboard): trades carry no marketId and no aggregate endpoint exists.
 * Small numbers (aggregatesHidden): the breakdown, chart and top assets hide behind one privacy message.
 */
import { useMemo } from 'react'
import { StatTile } from '../../components/charts/StatTile'
import { BarList } from '../../components/charts/BarList'
import { WirePlanned } from '../markets/shared'
import { isDemoMode } from '../../lib/demoMarkers'
import { inRange } from '../../lib/periods'
import { aggregatesHidden, MIN_AGGREGATE_COUNT, orderUnits, periodFigures } from '../../lib/tradeStats'
import { formatUsd } from '../../lib/format'
import { getLocale } from '../../lib/locale'
import { demoMarketDashboard } from '../../demo/dashboards'
import { t } from '../../i18n'
import {
  countDelta, DASHBOARD_SECTION, DashboardHeader, DashboardPicker, EmptyPeriod, SoonValue, unitSlots, usePeriod,
  useResolvedPeriod, VolumeChart, VolumeValue,
} from './DashboardParts'

const percent = (n: number) => new Intl.NumberFormat(getLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(n)

export function MarketDashboard({ marketId, activity30d, participants, activeOffers, className }: {
  marketId: string
  activity30d?: number
  participants?: number
  /** Offers listed on this market page right now; null while they load. */
  activeOffers: number | null
  className?: string
}) {
  const demo = isDemoMode()
  const now = useMemo(() => new Date(), [])
  const data = useMemo(() => (demo ? demoMarketDashboard(marketId, activity30d, participants, now) : null), [demo, marketId, activity30d, participants, now])
  const start = data?.start ?? now
  const [period, setPeriod] = usePeriod(`sails_dashboard_period_market_${marketId}`)
  const resolved = useResolvedPeriod(period, start, now)
  const headingId = `market-dashboard-${marketId}`

  if (!demo) {
    return (
      <section aria-labelledby={headingId} className={`${DASHBOARD_SECTION} ${className ?? ''}`}>
        <DashboardHeader id={headingId} title={t('stats.space.title')} lead={t('stats.space.lead')} simulated={false} />
        <WirePlanned id="marketDashboard" label={t('stats.space.title')} description={t('stats.space.soon')} className="mt-3" />
      </section>
    )
  }

  const trades = data?.trades ?? []
  const fig = periodFigures(trades, resolved.range)
  const prev = resolved.previous ? periodFigures(trades, resolved.previous) : null
  const joins = (data?.memberJoins ?? []).filter((d) => inRange(d, resolved.range)).length
  const openDisputes = trades.filter((tr) => tr.status === 'DISPUTED').length
  const slots = unitSlots(fig.usdByUnit.keys())
  const top = orderUnits(fig.usdByUnit.keys())
    .map((u) => ({ key: u, label: u, value: fig.usdByUnit.get(u) ?? 0, valueText: formatUsd(fig.usdByUnit.get(u) ?? 0), slot: slots.get(u) }))
    .sort((a, b) => b.value - a.value)
  const hidden = aggregatesHidden({ completed: fig.completed, members: participants })
  const tradesByUnit = new Map<string, number>()
  for (const tr of trades) if (tr.status === 'COMPLETED' && tr.completedAt && inRange(new Date(tr.completedAt), resolved.range)) tradesByUnit.set(tr.unit, (tradesByUnit.get(tr.unit) ?? 0) + 1)

  return (
    <section aria-labelledby={headingId} className={`space-y-4 ${className ?? ''}`}>
      <div className={DASHBOARD_SECTION}>
        <DashboardHeader
          id={headingId}
          title={t('stats.space.title')}
          lead={t('stats.space.lead')}
          simulated
          picker={<DashboardPicker period={period} setPeriod={setPeriod} resolved={resolved} start={start} now={now} />}
        />
        {hidden && <p role="status" className="mt-3 text-body-sm text-brand-text-secondary">{t('stats.space.privacyHidden')}</p>}
        {hidden ? (
          // Only counts that single nobody out; the offers count is the market page's own public listing.
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3">
            <StatTile label={t('stats.kpi.completed')} value={fig.completed < MIN_AGGREGATE_COUNT ? t('stats.space.fewerThan', { count: MIN_AGGREGATE_COUNT }) : fig.completed} />
            <StatTile label={t('stats.space.activeOffers')} value={activeOffers ?? '—'} help={t('stats.space.now')} />
            <StatTile label={t('stats.space.members')} value={participants ?? <SoonValue />} />
          </dl>
        ) : (
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3">
          <StatTile label={t('stats.kpi.completed')} value={fig.completed} delta={prev ? countDelta(fig.completed, prev.completed) : undefined} />
          <StatTile label={t('stats.kpi.volume')} value={<VolumeValue amounts={fig.amountByUnit} />} />
          <StatTile label={t('stats.space.activeOffers')} value={activeOffers ?? '—'} help={t('stats.space.now')} />
          <StatTile label={t('stats.space.members')} value={participants ?? <SoonValue />} help={t('stats.space.membersNew', { count: joins })} />
          <StatTile label={t('stats.kpi.completionRate')} value={fig.completionRate === null ? <span className="text-body-sm font-normal text-brand-text-muted">{t('stats.kpi.noRate')}</span> : percent(fig.completionRate)} help={t('stats.kpi.completionRateHelp')} />
          <StatTile label={t('stats.space.openDisputes')} value={openDisputes} help={t('stats.space.now')} />
        </dl>
        )}
      </div>
      {!hidden && (
        <>
          <div className={DASHBOARD_SECTION}>
            <VolumeChart trades={trades} range={resolved.range} rangeText={resolved.rangeText} />
          </div>
          <div className={DASHBOARD_SECTION}>
            <h3 className="text-subheading text-brand-text">{t('stats.space.topAssets')}</h3>
            <p className="mt-0.5 mb-3 text-caption text-brand-text-muted">{t('stats.space.topAssetsNote')}</p>
            {top.length === 0 ? <EmptyPeriod /> : <BarList label={t('stats.space.topAssets')} items={top.map((i) => ({ ...i, meta: t('stats.kpi.tradesCount', { count: tradesByUnit.get(i.key) ?? 0 }) }))} />}
            {top.length > 0 && <p className="mt-2 text-caption text-brand-text-muted">{t('stats.chart.usdSource')}</p>}
          </div>
        </>
      )}
    </section>
  )
}
