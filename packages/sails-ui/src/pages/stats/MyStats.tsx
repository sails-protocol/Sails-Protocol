/**
 * "Minhas estatísticas" (Perfil, PO 2026-11-23; Principal data facts). Real mode computes, for display only, from
 * the person's own trades (openp2p.getTrades, GET /v1/openp2p/trades, paged up to MAX_TRADES): completed count,
 * per-asset volume, completion rate and disputes. Average time to release and reputation over time have no source
 * (no escrow events, no reputation history) and stay "Em breve" (LOOSE_WIRES.personalStats). Demo: fictional records
 * with the "Simulado" badge (demo/dashboards.ts).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Trade } from '@satsails/p2p-trading-sdk'
import { useLocation } from 'react-router'
import type { User } from '../../types'
import { StatTile } from '../../components/charts/StatTile'
import { LineAreaChart } from '../../components/charts/LineAreaChart'
import { Skeleton } from '../../components/ui/skeleton'
import { StateBlock } from '../../components/ui/StateBlock'
import { Button } from '../../components/ui/button'
import { WirePlanned } from '../markets/shared'
import { sailsClient } from '../../lib/sailsClient'
import { errorMessage } from '../../lib/errors'
import { isDemoMode } from '../../lib/demoMarkers'
import { ASSET_SHORT_LABELS } from '../../lib/labels'
import { bucketSizeFor, bucketStarts, formatBucket, inRange, type DateRange } from '../../lib/periods'
import { periodFigures, type TradeRecord } from '../../lib/tradeStats'
import { getLocale } from '../../lib/locale'
import { demoPersonalStats, type DemoPersonalStats } from '../../demo/dashboards'
import { t } from '../../i18n'
import { chartCopy, countDelta, DASHBOARD_SECTION, DashboardHeader, DashboardPicker, SoonValue, usePeriod, useResolvedPeriod, VolumeChart, VolumeValue } from './DashboardParts'

/** Sane cap on the trades walked (Principal): past it, the figures say "últimas N negociações". */
export const MAX_TRADES = 2000
const PAGE = 50 // the SDK documents a server clamp of 1-50

function toRecord(tr: Trade): TradeRecord {
  return {
    unit: (ASSET_SHORT_LABELS as Record<string, string>)[tr.asset] ?? tr.asset,
    amount: Number(tr.amount), totalUsd: Number(tr.totalUsd), status: tr.status,
    createdAt: tr.createdAt, completedAt: tr.completedAt, cancelledAt: tr.cancelledAt,
  }
}

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; trades: TradeRecord[]; total: number }

/** Walks every page with hasMore, up to MAX_TRADES. */
function useOwnTrades(enabled: boolean): [Load, () => void] {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setLoad({ state: 'loading' })
    ;(async () => {
      const all: Trade[] = []
      let total = 0
      for (let offset = 0; all.length < MAX_TRADES; offset += PAGE) {
        const page = await sailsClient.openp2p.getTrades({ limit: PAGE, offset })
        all.push(...page.trades)
        total = page.total
        if (!page.hasMore || page.trades.length === 0) break
      }
      return { trades: all.slice(0, MAX_TRADES).map(toRecord), total: Math.max(total, all.length) }
    })().then(
      (r) => { if (!cancelled) setLoad({ state: 'ready', ...r }) },
      (err) => { if (!cancelled) setLoad({ state: 'error', message: errorMessage(err, t('stats.me.error')) }) },
    )
    return () => { cancelled = true }
  }, [enabled, attempt])
  return [load, useCallback(() => setAttempt((a) => a + 1), [])]
}

/** Score at the end of each bucket (carried forward), from the demo history. */
function reputationValues(points: DemoPersonalStats['reputation'], range: DateRange, starts: Date[]) {
  const ends = starts.map((_, i) => (i + 1 < starts.length ? starts[i + 1] : new Date(range.to.getFullYear(), range.to.getMonth(), range.to.getDate() + 1)))
  return ends.map((end) => {
    let score = 0
    for (const p of points) if (p.at < end) score = p.score
    return score
  })
}

const percent = (n: number) => new Intl.NumberFormat(getLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(n)

export function MyStatsSection({ user, className }: { user: User; className?: string }) {
  const demo = isDemoMode()
  const now = useMemo(() => new Date(), [])
  const fixture = useMemo(() => (demo ? demoPersonalStats(now) : null), [demo, now])
  const [load, retry] = useOwnTrades(!demo)
  const accountStart = useMemo(() => {
    const d = new Date(user.createdAt)
    return Number.isNaN(d.getTime()) ? now : d
  }, [user.createdAt, now])
  const start = fixture?.start ?? accountStart
  const [period, setPeriod] = usePeriod('sails_dashboard_period_me')
  const resolved = useResolvedPeriod(period, start, now)
  const headingId = 'my-stats-title'
  const { hash } = useLocation()
  // "/profile#my-stats" (Programa Merchant › Seu caminho) brings the section into view, as #merchant does.
  useEffect(() => {
    if (hash !== '#my-stats') return
    const timer = setTimeout(() => {
      const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      document.getElementById('my-stats')?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })
    }, 0)
    return () => clearTimeout(timer)
  }, [hash])

  const trades = fixture?.trades ?? (load.state === 'ready' ? load.trades : [])
  const capped = !demo && load.state === 'ready' && load.total > load.trades.length

  const body = () => {
    if (!demo && load.state === 'loading') {
      return (
        <div role="status" aria-label={t('stats.me.loading')} className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14" />)}
        </div>
      )
    }
    if (!demo && load.state === 'error') {
      return <StateBlock bare kind="error" title={t('stats.me.error')} description={load.message} action={<Button type="button" variant="secondary" size="sm" onClick={retry} className="touch:min-h-11">{t('trades.retry')}</Button>} />
    }
    const fig = periodFigures(trades, resolved.range)
    const prev = resolved.previous ? periodFigures(trades, resolved.previous) : null
    const release = fixture?.releaseMinutes.filter((r) => inRange(r.at, resolved.range)) ?? []
    const avgRelease = release.length ? Math.round(release.reduce((a, r) => a + r.minutes, 0) / release.length) : null
    return (
      <>
        {capped && <p className="mt-3 text-caption text-brand-text-secondary">{t('stats.me.capped', { count: load.trades.length })}</p>}
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3">
          <StatTile label={t('stats.kpi.completed')} value={fig.completed} delta={prev ? countDelta(fig.completed, prev.completed) : undefined} />
          <StatTile label={t('stats.kpi.volume')} value={<VolumeValue amounts={fig.amountByUnit} />} />
          <StatTile label={t('stats.kpi.completionRate')} value={fig.completionRate === null ? <span className="text-body-sm font-normal text-brand-text-muted">{t('stats.kpi.noRate')}</span> : percent(fig.completionRate)} help={t('stats.kpi.completionRateHelp')} />
          {/* Real mode: no escrow-events source, so no number (completedAt - createdAt is not "time to release"). */}
          <StatTile label={t('stats.kpi.releaseTime')} value={demo ? (avgRelease === null ? '—' : t('stats.kpi.minutes', { count: avgRelease })) : <SoonValue />} help={t('stats.kpi.releaseHelp')} />
          <StatTile label={t('stats.kpi.disputes')} value={fig.disputed} help={t('stats.kpi.disputesHelp')} />
        </dl>
      </>
    )
  }

  const ready = demo || load.state === 'ready'
  const size = bucketSizeFor(resolved.range)
  const starts = bucketStarts(resolved.range, size)
  const repValues = fixture ? reputationValues(fixture.reputation, resolved.range, starts) : []
  const locale = getLocale()

  return (
    <section id="my-stats" aria-labelledby={headingId} className={`scroll-mt-20 space-y-4 ${className ?? ''}`}>
      <div className={DASHBOARD_SECTION}>
        <DashboardHeader
          id={headingId}
          title={t('stats.me.title')}
          lead={t('stats.me.lead')}
          simulated={demo}
          picker={<DashboardPicker period={period} setPeriod={setPeriod} resolved={resolved} start={start} now={now} />}
        />
        {body()}
      </div>
      {ready && (
        <div className={DASHBOARD_SECTION}>
          <VolumeChart trades={trades} range={resolved.range} rangeText={resolved.rangeText} />
        </div>
      )}
      <div className={DASHBOARD_SECTION}>
        {fixture && fixture.reputation.some((p) => inRange(p.at, resolved.range) || p.at < resolved.range.from) ? (
          <>
            <h3 className="text-subheading text-brand-text">{t('stats.me.reputationTitle')}</h3>
            <p className="mt-0.5 mb-3 text-caption text-brand-text-muted">{t('stats.me.reputationNote')}</p>
            <LineAreaChart
              labels={starts.map((d) => formatBucket(d, size, locale))}
              series={[{ key: 'reputation', name: t('stats.me.reputationSeries'), slot: 1, values: repValues }]}
              formatValue={(n) => n.toLocaleString(locale)}
              formatTick={(n) => n.toLocaleString(locale)}
              summary={t('stats.me.reputationSummary', { range: resolved.rangeText, first: (repValues[0] ?? 0).toLocaleString(locale), last: (repValues[repValues.length - 1] ?? 0).toLocaleString(locale) })}
              copy={chartCopy(t('stats.chart.exploreReputation'))}
            />
          </>
        ) : (
          <WirePlanned id="personalStats" label={t('stats.me.reputationTitle')} description={t('stats.me.reputationNote')} />
        )}
      </div>
    </section>
  )
}
