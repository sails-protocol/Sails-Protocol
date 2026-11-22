/**
 * Layer C pieces shared by "Painel do espaço" and "Minhas estatísticas" (PO 2026-11-23): the remembered period, the
 * copy handed to the Layer A charts, per-asset formatting and the volume block. Amounts stay per asset.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { ChartColumn } from 'lucide-react'
import { PeriodPicker, type PeriodPickerCopy } from '../../components/charts/PeriodPicker'
import { LineAreaChart, type ChartSeries, type LineAreaChartCopy, type SeriesSlot } from '../../components/charts/LineAreaChart'
import { StateBlock } from '../../components/ui/StateBlock'
import { SimulatedBadge } from '../../components/ui/SimulatedBadge'
import { bucketSizeFor, formatBucket, formatRange, loadPeriod, previousRange, resolvePeriod, savePeriod, type DateRange, type Period } from '../../lib/periods'
import { orderUnits, usdSeries, type TradeRecord } from '../../lib/tradeStats'
import { formatAmount, formatUsd, formatUsdCompact } from '../../lib/format'
import { getLocale } from '../../lib/locale'
import { t } from '../../i18n'

export const DASHBOARD_SECTION = 'rounded-lg bg-brand-surface p-4'

/** The period of one dashboard, remembered in this browser (try/catch inside loadPeriod/savePeriod). */
export function usePeriod(storageKey: string): [Period, (p: Period) => void] {
  const [period, setPeriod] = useState<Period>(() => loadPeriod(storageKey))
  return [period, (p: Period) => { setPeriod(p); savePeriod(storageKey, p) }]
}

export interface ResolvedPeriod {
  range: DateRange
  /** The equal span right before, only when it lies after `start` (otherwise a delta would compare with nothing). */
  previous: DateRange | null
  rangeText: string
}

export function useResolvedPeriod(period: Period, start: Date, now: Date): ResolvedPeriod {
  return useMemo(() => {
    const range = resolvePeriod(period, now, start)
    const prev = previousRange(range)
    return { range, previous: period.kind === 'preset' && period.preset === 'all' ? null : prev.from >= startOfDayOf(start) ? prev : null, rangeText: formatRange(range, getLocale()) }
  }, [period, start, now])
}
const startOfDayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

export function periodPickerCopy(start: Date): PeriodPickerCopy {
  const startText = new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', year: 'numeric' }).format(start)
  return {
    group: t('stats.period.group'),
    presets: { '7d': t('stats.period.7d'), '30d': t('stats.period.30d'), '90d': t('stats.period.90d'), all: t('stats.period.all') },
    custom: t('stats.period.custom'),
    customTitle: t('stats.period.customTitle'),
    from: t('stats.period.from'),
    to: t('stats.period.to'),
    apply: t('stats.period.apply'),
    errors: {
      invalid: t('stats.period.error.invalid'),
      order: t('stats.period.error.order'),
      future: t('stats.period.error.future'),
      beforeStart: t('stats.period.error.beforeStart', { date: startText }),
    },
  }
}

export function chartCopy(explore = t('stats.chart.explore')): LineAreaChartCopy {
  return { explore, showTable: t('stats.chart.showTable'), hideTable: t('stats.chart.hideTable'), bucketHeader: t('stats.chart.bucket'), legend: t('stats.chart.legend') }
}

/** Crypto quantity with its unit, in the interface language ("0,0421 BTC"). */
export function formatUnitAmount(unit: string, value: number): string {
  return `${formatAmount(value, unit === 'USDT' || unit === 'USDC' ? 2 : 8)} ${unit}`
}

/** Fixed colour slot per unit (BTC 1, USDT 2, USDC 3); a fourth unit has no slot and shows in the table only. */
export function unitSlots(units: Iterable<string>): Map<string, SeriesSlot> {
  return new Map(orderUnits(units).slice(0, 3).map((u, i) => [u, (i + 1) as SeriesSlot]))
}

/** "+3 vs período anterior" / "Igual ao período anterior": neutral text, never a good/bad colour. */
export function countDelta(now: number, before: number) {
  const diff = now - before
  if (diff === 0) return { text: t('stats.delta.same'), direction: 'flat' as const }
  const value = new Intl.NumberFormat(getLocale(), { signDisplay: 'exceptZero' }).format(diff)
  return { text: t('stats.delta', { value }), direction: diff > 0 ? ('up' as const) : ('down' as const) }
}

/** Volume per asset as stacked lines, one per asset (never one total). */
export function VolumeValue({ amounts }: { amounts: Map<string, number> }) {
  const units = orderUnits(amounts.keys())
  if (units.length === 0) return <span className="text-body-sm font-normal text-brand-text-muted">{t('stats.kpi.volumeNone')}</span>
  return <>{units.map((u) => <span key={u} className="block text-subheading">{formatUnitAmount(u, amounts.get(u) ?? 0)}</span>)}</>
}

export function SoonValue() {
  return <span className="text-body-sm font-normal text-brand-text-muted">{t('common.soon')}</span>
}

/** Section heading row: title, the "Simulado" badge in the demo, the lead line, then the period selector. */
export function DashboardHeader({ id, title, lead, simulated, picker }: { id: string; title: string; lead: string; simulated: boolean; picker?: ReactNode }) {
  return (
    <div className="space-y-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={id} className="text-section-title">{title}</h2>
          {simulated && <SimulatedBadge label={t('spaces.simulated')} />}
        </div>
        <p className="mt-1 text-body-sm text-brand-text-secondary">{lead}</p>
      </div>
      {picker}
    </div>
  )
}

export function DashboardPicker({ period, setPeriod, resolved, start, now }: { period: Period; setPeriod: (p: Period) => void; resolved: ResolvedPeriod; start: Date; now: Date }) {
  return <PeriodPicker value={period} onChange={setPeriod} start={start} today={now} range={resolved.range} rangeText={resolved.rangeText} copy={periodPickerCopy(start)} />
}

export function EmptyPeriod() {
  return <StateBlock bare kind="empty" icon={ChartColumn} title={t('stats.empty.title')} description={t('stats.empty.hint')} />
}

/** USD volume by asset over time: one series per asset, the trade's own totalUsd, never one total. */
export function VolumeChart({ trades, range, rangeText }: { trades: readonly TradeRecord[]; range: DateRange; rangeText: string }) {
  const size = bucketSizeFor(range)
  const { starts, series } = useMemo(() => usdSeries(trades, range, size), [trades, range, size])
  const slots = unitSlots(series.keys())
  const units = orderUnits(series.keys())
  const chartSeries: ChartSeries[] = units.filter((u) => slots.has(u)).map((u) => ({ key: u, name: u, slot: slots.get(u) as SeriesSlot, values: series.get(u) ?? [] }))
  if (chartSeries.length === 0) return <EmptyPeriod />
  const locale = getLocale()
  const totals = chartSeries.map((s) => `${s.name} ${formatUsd(s.values.reduce((a, b) => a + b, 0))}`).join(', ')
  // shortcut: three colour slots; a fourth asset is named as outside the chart (only BTC is tradable today), add slots when more rails open.
  const hidden = units.length - chartSeries.length
  return (
    <div>
      <h3 className="text-subheading text-brand-text">{t('stats.chart.volumeTitle')}</h3>
      <p className="mt-0.5 mb-3 text-caption text-brand-text-muted">{t('stats.chart.volumeNote')}</p>
      <LineAreaChart
        labels={starts.map((d) => formatBucket(d, size, locale))}
        series={chartSeries}
        formatValue={formatUsd}
        formatTick={formatUsdCompact}
        summary={t('stats.chart.volumeSummary', { range: rangeText, values: totals })}
        copy={chartCopy()}
      />
      {hidden > 0 && <p className="mt-1 text-caption text-brand-text-muted">{t('stats.chart.moreAssets', { count: hidden })}</p>}
    </div>
  )
}
