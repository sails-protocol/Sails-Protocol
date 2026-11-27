/**
 * Layer C: Perfil → "Programa Merchant" (CTO 36, 2026-11-22; Merchant journey, PO 2026-11-23). The whole program is a
 * proposal: no level is active, no target is set, no fee or discount is applied, and the only number from the economic
 * studies is the one reference fee, worded as proposed and not charged (CTO 38). The journey shows the level track
 * (everyone is "Padrão" today), what each level may include, and "Seu caminho": the criteria under study with the
 * person's real values where the account already has them (trades, reputation, member since) and "Ainda não medido"
 * elsewhere. No target, progress bar, ranking or streak. In the demo, the values come from demo data, marked "Simulado".
 */
import { useEffect } from 'react'
import { Link, useLocation } from 'react-router'
import { CheckCircle2, Minus } from 'lucide-react'
import { Alert } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Card } from '../../components/ui/card'
import { LevelTrack } from '../../components/ui/LevelTrack'
import { PlannedItem } from '../../components/ui/PlannedItem'
import { SimulatedBadge } from '../../components/ui/SimulatedBadge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { buttonVariants } from '../../components/ui/button'
import { MARKETS_ROUTES } from '../../components/layout/navMatch'
import { cn } from '../../lib/utils'
import { demoRatingsOf, isDemoMode } from '../../lib/demoMarkers'
import { formatMonthYear } from '../../lib/format'
import { formatReputation } from '../../lib/reputation'
import { ratingFullText, sellerRatings } from '../../lib/ratings'
import { LOOSE_WIRES } from '../../lib/looseWires'
import { faqPath } from '../../lib/faq'
import type { User } from '../../types'
import { RoleLinks } from './shared'
import { useOwnTrades } from '../stats/MyStats'
import { formatUnitAmount } from '../stats/DashboardParts'
import { orderUnits, periodFigures } from '../../lib/tradeStats'
import { getLocale } from '../../lib/locale'
import { t, type MessageKey } from '../../i18n'

const TAG = 'border-transparent bg-brand-tonal font-medium text-brand-text-secondary'
const LINK = 'inline-flex min-h-8 touch:min-h-11 items-center font-medium text-brand-link underline underline-offset-2 hover:decoration-2'
// Level names are proposed product names, the same in every language (never translated); "Padrão" is translated.
// Wherever a level name renders on its own it carries translate="no" so browser translation leaves it alone.
const noTranslate = (id: string) => (id === 'standard' ? undefined : 'no')
const LEVELS = [
  { id: 'standard', name: () => t('profile.merchant.level.standard') },
  { id: 'merchant', name: () => 'Merchant' },
  { id: 'pro', name: () => 'Merchant Pro' },
  { id: 'elite', name: () => 'Merchant Elite' },
] as const
type LevelId = (typeof LEVELS)[number]['id']
// PO-approved matrix (2026-11-23): the levels each perk is planned for. Only "Previsto" or "Não inclui", never a number.
const PERKS: readonly (readonly [perk: string, levels: readonly LevelId[]])[] = [
  ['profile', ['merchant', 'pro', 'elite']],
  ['tools', ['merchant', 'pro', 'elite']],
  ['stats', ['merchant', 'pro', 'elite']],
  ['api', ['pro', 'elite']],
  ['visibility', ['merchant', 'pro', 'elite']],
  ['fees', ['merchant', 'pro', 'elite']],
]
const m = (key: string, vars?: Record<string, string>) => t(`profile.merchant.${key}` as MessageKey, vars)

function PerkState({ planned }: { planned: boolean }) {
  const Icon = planned ? CheckCircle2 : Minus
  return (
    <span className={cn('inline-flex items-center gap-1.5', planned ? 'text-brand-text' : 'text-brand-text-muted')}>
      <Icon aria-hidden="true" className="size-icon-sm shrink-0" />
      {m(planned ? 'perks.planned' : 'perks.none')}
    </span>
  )
}

function PerksMatrix() {
  return (
    <>
      {/* From md: rows = perks, columns = levels (a header for each column and each row). */}
      <Card className="hidden overflow-hidden md:block">
        <Table className="text-body-sm">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{m('perks.col')}</TableHead>
              {LEVELS.map((l) => <TableHead key={l.id} scope="col" translate={noTranslate(l.id)}>{l.name()}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {PERKS.map(([perk, levels]) => (
              <TableRow key={perk}>
                <th scope="row" className="px-4 py-3 text-left align-top font-medium text-brand-text">{m(`perk.${perk}`)}</th>
                {LEVELS.map((l) => <TableCell key={l.id} className="align-top"><PerkState planned={levels.includes(l.id)} /></TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      {/* Phones: one card per level with its six perks. */}
      <ul className="space-y-3 md:hidden">
        {LEVELS.map((l) => (
          <li key={l.id}>
            <Card className="p-4">
              <h4 className="text-sm font-semibold text-brand-text" translate={noTranslate(l.id)}>{l.name()}</h4>
              <ul className="mt-2 divide-y divide-brand-border-subtle text-body-sm">
                {PERKS.map(([perk, levels]) => (
                  <li key={perk} className="flex items-start justify-between gap-3 py-2">
                    <span className="min-w-0 text-brand-text-secondary">{m(`perk.${perk}`)}</span>
                    <span className="shrink-0 text-caption"><PerkState planned={levels.includes(l.id)} /></span>
                  </li>
                ))}
              </ul>
            </Card>
          </li>
        ))}
      </ul>
    </>
  )
}

/** "Seu caminho": the criteria under study, real values only, "Meta: a homologar" on every row. */
function YourPath({ user, demo }: { user: User | null; demo: boolean }) {
  const [load] = useOwnTrades(!!user)
  const heading = (
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-sm font-semibold text-brand-text">{m('path.title')}</h3>
      {user && demo && <SimulatedBadge label={t('spaces.simulated')} />}
    </div>
  )
  if (!user) {
    return (
      <Card className="p-4">
        {heading}
        <p className="mt-1 text-body-sm text-brand-text-secondary">{m('path.lead')}</p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md bg-brand-tonal px-3 py-2">
          <p className="text-body-sm text-brand-text">{m('path.signedOut')}</p>
          <Link to="/login" state={{ from: '/profile' }} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>{t('auth.login.title')}</Link>
        </div>
      </Card>
    )
  }
  const ratings = sellerRatings({ demoRatings: demoRatingsOf(user) }) // dev demo only; null for real data
  const since = formatMonthYear(user.createdAt)
  // Same figures as "Minhas estatísticas" (all time, from the person's own trades); until they load, "Ainda não medido".
  const fig = load.state === 'ready' ? periodFigures(load.trades, { from: new Date(0), to: new Date() }) : null
  const volume = fig && fig.amountByUnit.size ? orderUnits(fig.amountByUnit.keys()).map((u) => formatUnitAmount(u, fig.amountByUnit.get(u) ?? 0)).join(' · ') : null
  const completion = fig?.completionRate != null ? new Intl.NumberFormat(getLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(fig.completionRate) : null
  const rows: [label: string, value: string | null, hint?: string][] = [
    [m('path.trades'), String(user.totalTrades)],
    [m('path.volume'), volume],
    [m('path.completion'), completion],
    // Ratings cannot be read back yet (LOOSE_WIRES.readRatings): the real value is the reputation score.
    [m('path.quality'), ratings ? ratingFullText(ratings) : formatReputation(user.reputationScore)],
    [m('path.tenure'), since ? m('path.tenureSince', { date: since }) : null],
    [m('path.integrity'), null, m('path.integrityHint')],
  ]
  return (
    <Card className="p-4">
      {heading}
      <p className="mt-1 text-body-sm text-brand-text-secondary">{m('path.lead')}</p>
      {user.totalTrades === 0 && (
        <p className="mt-3 text-body-sm text-brand-text">
          {m('path.empty')} <Link to={MARKETS_ROUTES.explore} className={LINK}>{m('path.emptyAction')}</Link>
        </p>
      )}
      <ul className="mt-3 divide-y divide-brand-border-subtle">
        {rows.map(([label, value, hint]) => (
          <li key={label} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-brand-text">{label}</p>
              {hint && <p className="text-caption text-brand-text-muted">{hint}</p>}
            </div>
            <div className="shrink-0 sm:text-right">
              <p className={cn('text-body-sm tabular-nums', value ? 'text-brand-text' : 'text-brand-text-muted')}>{value ? m('path.today', { value }) : m('path.notMeasured')}</p>
              <p className="text-caption text-brand-text-muted">{m('path.target')}</p>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-x-4">
        <Link to="/profile#my-stats" className={LINK}>{t('stats.me.link')}</Link>
        <Link to={faqPath('merchant-how')} className={LINK}>{m('path.faq')}</Link>
      </div>
    </Card>
  )
}

export function MerchantProgramSection({ user, className }: { user: User | null; className?: string }) {
  const demo = isDemoMode()
  const { hash } = useLocation()
  // "/profile#merchant" (FAQ answers, the role links) brings the card into view.
  useEffect(() => {
    if (hash !== '#merchant') return
    const timer = setTimeout(() => {
      const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      document.getElementById('merchant')?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })
    }, 0)
    return () => clearTimeout(timer)
  }, [hash])

  const INCENTIVES: [string, string, levelName?: boolean][] = [
    [t('profile.merchant.incentives.standard'), t('profile.merchant.incentives.standardWhat')],
    [t('profile.merchant.incentives.space'), t('profile.merchant.incentives.spaceWhat')],
    ['Merchant', t('profile.merchant.incentives.merchantWhat'), true],
    ['Merchant Pro', t('profile.merchant.incentives.proWhat'), true],
    ['Merchant Elite', t('profile.merchant.incentives.eliteWhat'), true],
    [t('profile.merchant.incentives.operator'), t('profile.merchant.incentives.operatorWhat')],
  ]
  // Everyone is "Padrão" today: no level is active.
  const levels = LEVELS.map((l, i) => ({
    id: l.id,
    label: l.name(),
    current: i === 0,
    noTranslate: l.id !== 'standard',
    note: i === 0 ? m('level.current', { level: l.name() }) : m('level.preparing'),
  }))
  return (
    <section id="merchant" aria-labelledby="profile-merchant" className={cn('scroll-mt-20', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="profile-merchant" className="text-section-title">{t('profile.merchant.title')}</h2>
        <Badge variant="outline" className={TAG}>{t('profile.merchant.tag')}</Badge>
      </div>
      <p className="mt-1 max-w-[68ch] text-body-sm text-brand-text-secondary">{t('profile.merchant.lead')}</p>
      {/* Always visible, never dismissible (CTO 38 UI conditions). */}
      <Alert tone="info" className="mt-3">
        <p>{t('profile.merchant.honesty')}</p>
        <p className="mt-1">{t('profile.merchant.noTopTier')} {t('profile.merchant.noAdvantage')}</p>
      </Alert>

      <Card className="mt-4 p-4 md:p-5">
        <LevelTrack levels={levels} label={t('profile.merchant.levels.label')} />
      </Card>

      <h3 className="mb-2 mt-6 text-sm font-semibold text-brand-text">{t('profile.merchant.perks.title')}</h3>
      <PerksMatrix />

      <div className="mt-6">
        <YourPath user={user} demo={demo} />
      </div>

      {/* CTO 38 complement 1: who gets what, as a proposal with no numbers; the protocol (never a node) sets base fee and benefits. */}
      <h3 className="mt-6 text-sm font-semibold text-brand-text">{t('profile.merchant.incentives.title')}</h3>
      <dl className="mt-1 divide-y divide-brand-border-subtle text-body-sm">
        {INCENTIVES.map(([who, what, levelName]) => (
          <div key={what} className="py-1.5 sm:grid sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-3">
            <dt className="font-medium text-brand-text" translate={levelName ? 'no' : undefined}>{who}</dt>
            <dd className="text-brand-text-secondary">{what}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1 text-caption text-brand-text-muted">{t('profile.merchant.incentives.note')}</p>
      <p className="mt-3 text-caption text-brand-text-secondary">{t('profile.merchant.globalPolicy')}</p>
      <p className="mt-1 text-caption text-brand-text-muted">{t('profile.merchant.referenceFee')}</p>
      <PlannedItem
        className="mt-4"
        icon={LOOSE_WIRES.merchantBadge.icon}
        label={LOOSE_WIRES.merchantBadge.label}
        soonLabel={t('common.soon')}
        description={t('profile.merchant.badgeNote')}
      />
      <RoleLinks here="merchant" className="mt-3" />
    </section>
  )
}
