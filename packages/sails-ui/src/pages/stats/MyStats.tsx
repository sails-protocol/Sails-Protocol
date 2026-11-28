/**
 * "Minhas estatísticas" (Perfil, PO 2026-11-23; Principal data facts). Real mode computes, for display only, from
 * the person's own trades (openp2p.getTrades, GET /v1/openp2p/trades, paged up to MAX_TRADES): completed count,
 * per-asset volume, completion rate and disputes. Average time to release reads each completed trade's escrow events
 * (settlement.get, at most RELEASE_SAMPLE_CAP per period, 4 at a time); reputation over time has no source (no
 * reputation history) and stays "Em breve" (LOOSE_WIRES.personalStats). Demo: the same calls answered by the demo
 * backend, so the figures agree with the Perfil header and "Seu caminho"; release times and the reputation line are
 * fictional, with the "Simulado" badge.
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
import { averageDuration, durationParts, inFlightOnce, mapLimited, periodFigures, releaseDurationMs, releaseSample, type TradeRecord } from '../../lib/tradeStats'
import { getLocale } from '../../lib/locale'
import { t } from '../../i18n'
import { chartCopy, countDelta, DASHBOARD_SECTION, DashboardHeader, DashboardPicker, usePeriod, useResolvedPeriod, VolumeChart, VolumeValue } from './DashboardParts'

/** Sane cap on the trades walked (Principal): past it, the figures say "últimas N negociações". */
export const MAX_TRADES = 2000
const PAGE = 50 // the SDK documents a server clamp of 1-50

export function toRecord(tr: Trade): TradeRecord {
  return {
    unit: (ASSET_SHORT_LABELS as Record<string, string>)[tr.asset] ?? tr.asset,
    amount: Number(tr.amount), totalUsd: Number(tr.totalUsd), status: tr.status,
    createdAt: tr.createdAt, completedAt: tr.completedAt, cancelledAt: tr.cancelledAt, escrowId: tr.escrowId,
  }
}

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; trades: TradeRecord[]; total: number }

/** Walks every page with hasMore, up to MAX_TRADES; one walk per identity while it runs (shared by the Perfil sections). */
const walkOwnTrades = inFlightOnce(async () => {
  const all: Trade[] = []
  let total = 0
  for (let offset = 0; all.length < MAX_TRADES; offset += PAGE) {
    const page = await sailsClient.openp2p.getTrades({ limit: PAGE, offset })
    all.push(...page.trades)
    total = page.total
    if (!page.hasMore || page.trades.length === 0) break
  }
  return { trades: all.slice(0, MAX_TRADES).map(toRecord), total: Math.max(total, all.length) }
})

/** The signed-in person's trades (`identity` = their public key; nothing is read without one). */
export function useOwnTrades(identity: string | null | undefined): [Load, () => void] {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!identity) return
    let cancelled = false
    setLoad({ state: 'loading' })
    walkOwnTrades(identity).then(
      (r) => { if (!cancelled) setLoad({ state: 'ready', ...r }) },
      (err) => { if (!cancelled) setLoad({ state: 'error', message: errorMessage(err, t('stats.me.error')) }) },
    )
    return () => { cancelled = true }
  }, [identity, attempt])
  return [load, useCallback(() => setAttempt((a) => a + 1), [])]
}

type ReleaseLoad = { state: 'loading' } | { state: 'error' } | { state: 'ready'; avg: { ms: number; count: number } | null }

/**
 * Average release time from the escrows' own events (display only). A failed read fails the tile, never the page.
 * The SDK's Escrow type does not declare `events` yet, though the route returns them: read defensively.
 */
function useReleaseTime(escrowIds: string[], enabled: boolean): [ReleaseLoad, () => void] {
  const [load, setLoad] = useState<ReleaseLoad>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const key = escrowIds.join(',')
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setLoad({ state: 'loading' })
    mapLimited(escrowIds, 4, async (id) => releaseDurationMs((await sailsClient.settlement.get(id) as { events?: unknown }).events)).then(
      (durations) => { if (!cancelled) setLoad({ state: 'ready', avg: averageDuration(durations) }) },
      () => { if (!cancelled) setLoad({ state: 'error' }) },
    )
    return () => { cancelled = true }
    // escrowIds is read through its key: a new array with the same ids must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, attempt])
  return [load, useCallback(() => setAttempt((a) => a + 1), [])]
}

/** "18 min", "2 h 05 min" (words from the catalog, numbers in the interface's locale). */
function formatDuration(ms: number): string {
  const { hours, minutes, totalMinutes } = durationParts(ms)
  if (totalMinutes < 1) return t('stats.kpi.durationUnderMinute')
  if (hours === 0) return t('stats.kpi.minutes', { count: minutes })
  return t('stats.kpi.durationHours', { hours: hours.toLocaleString(getLocale()), minutes: String(minutes).padStart(2, '0') })
}

type ScorePoint = { at: Date; score: number }

/**
 * Demo only: the reputation line from the demo trades, +2 per completed trade, anchored so it ends at the score the
 * Perfil header shows (fictional history, "Simulado").
 */
function demoReputation(trades: readonly TradeRecord[], final: number): ScorePoint[] {
  const done = trades.filter((tr) => tr.status === 'COMPLETED' && tr.completedAt).sort((a, b) => (a.completedAt as string).localeCompare(b.completedAt as string))
  return done.map((tr, i) => ({ at: new Date(tr.completedAt as string), score: final - 2 * (done.length - 1 - i) }))
}

/** Demo only: a fictional, stable release time per completed trade (minutes). */
const demoReleaseMinutes = (tr: TradeRecord) => 8 + (Math.round(tr.amount * 1000) + tr.createdAt.length * 7) % 30

/** Score at the end of each bucket (carried forward), from the demo history. */
function reputationValues(points: readonly ScorePoint[], range: DateRange, starts: Date[]) {
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
  const [load, retry] = useOwnTrades(user.publicKey)
  const accountStart = useMemo(() => {
    const d = new Date(user.createdAt)
    return Number.isNaN(d.getTime()) ? now : d
  }, [user.createdAt, now])
  const start = accountStart
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

  const trades = load.state === 'ready' ? load.trades : []
  const fixture = useMemo(() => (demo ? { reputation: demoReputation(trades, user.reputationScore) } : null), [demo, trades, user.reputationScore])
  const capped = load.state === 'ready' && load.total > load.trades.length
  const sample = useMemo(() => releaseSample(trades, resolved.range), [trades, resolved.range])
  const [releaseLoad, retryRelease] = useReleaseTime(sample.escrowIds, !demo && load.state === 'ready')
  const muted = (text: string) => <span className="text-body-sm font-normal text-brand-text-muted">{text}</span>
  const releaseValue = () => {
    if (demo) return null
    if (releaseLoad.state === 'loading') return <div role="status"><span className="sr-only">{t('stats.kpi.releaseLoading')}</span><Skeleton className="h-7 w-24" /></div>
    if (releaseLoad.state === 'error') {
      return (
        <span className="flex flex-wrap items-center gap-2">
          {muted(t('stats.kpi.releaseError'))}
          <Button type="button" variant="secondary" size="sm" onClick={retryRelease} className="touch:min-h-11">{t('trades.retry')}</Button>
        </span>
      )
    }
    return releaseLoad.avg ? formatDuration(releaseLoad.avg.ms) : muted(t('stats.kpi.releaseNone'))
  }

  const body = () => {
    if (load.state === 'loading') {
      return (
        <div role="status" aria-label={t('stats.me.loading')} className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14" />)}
        </div>
      )
    }
    if (load.state === 'error') {
      return <StateBlock bare kind="error" title={t('stats.me.error')} description={load.message} action={<Button type="button" variant="secondary" size="sm" onClick={retry} className="touch:min-h-11">{t('trades.retry')}</Button>} />
    }
    const fig = periodFigures(trades, resolved.range)
    const prev = resolved.previous ? periodFigures(trades, resolved.previous) : null
    const release = demo ? trades.filter((tr) => tr.status === 'COMPLETED' && tr.completedAt && inRange(new Date(tr.completedAt), resolved.range)).map(demoReleaseMinutes) : []
    const avgRelease = release.length ? Math.round(release.reduce((a, r) => a + r, 0) / release.length) : null
    return (
      <>
        {capped && <p className="mt-3 text-caption text-brand-text-secondary">{t('stats.me.capped', { count: load.trades.length })}</p>}
        {/* Real mode only: the demo's numbers are fictional and come from this device. */}
        {!demo && <p className="mt-3 text-caption text-brand-text-muted">{t('stats.me.source')}</p>}
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3">
          <StatTile label={t('stats.kpi.completed')} value={fig.completed} delta={prev ? countDelta(fig.completed, prev.completed) : undefined} />
          <StatTile label={t('stats.kpi.volume')} value={<VolumeValue amounts={fig.amountByUnit} />} />
          <StatTile label={t('stats.kpi.completionRate')} value={fig.completionRate === null ? <span className="text-body-sm font-normal text-brand-text-muted">{t('stats.kpi.noRate')}</span> : percent(fig.completionRate)} help={t('stats.kpi.completionRateHelp')} />
          {/* Real mode: escrow events only (completedAt - createdAt is not "time to release"). */}
          <StatTile
            label={t('stats.kpi.releaseTime')}
            value={demo ? (avgRelease === null ? '—' : t('stats.kpi.minutes', { count: avgRelease })) : releaseValue()}
            help={!demo && sample.capped ? `${t('stats.kpi.releaseHelp')} ${t('stats.kpi.releaseCapped', { count: sample.escrowIds.length })}` : t('stats.kpi.releaseHelp')}
          />
          <StatTile label={t('stats.kpi.disputes')} value={fig.disputed} help={t('stats.kpi.disputesHelp')} />
        </dl>
      </>
    )
  }

  const ready = load.state === 'ready'
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
