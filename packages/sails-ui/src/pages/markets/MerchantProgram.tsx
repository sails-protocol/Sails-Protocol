/**
 * Layer C: Perfil → "Programa Merchant (proposta)" (CTO 36, 2026-11-22). Names, criteria and benefits are a proposal still to
 * be ratified: no tier is active, no fee or discount is applied, and no number from the economic simulations is shown
 * except the one reference fee, worded as proposed and not charged. The demo adds a fictional progress, marked "Simulado".
 */
import { Badge } from '../../components/ui/badge'
import { Progress } from '../../components/ui/progress'
import { SimulatedBadge } from '../../components/ui/SimulatedBadge'
import { cn } from '../../lib/utils'
import { isDemoMode } from '../../lib/demoMarkers'
import { RoleLinks } from './shared'
import { t } from '../../i18n'

const TAG = 'border-transparent bg-brand-tonal font-medium text-brand-text-secondary'
// Tier names are proposed product names, the same in every language (never translated).
const TIERS = 'Merchant · Merchant Pro · Merchant Elite'
const BENEFITS = ['profile', 'tools', 'stats', 'api', 'visibility', 'discounts'] as const
// Demo only: fictional progress toward the first tier (the real criteria are not ratified).
const DEMO_PROGRESS = { done: 18, goal: 50 }

export function MerchantProgramSection({ className }: { className?: string }) {
  const demo = isDemoMode()
  const INCENTIVES: [string, string][] = [
    [t('profile.merchant.incentives.standard'), t('profile.merchant.incentives.standardWhat')],
    [t('profile.merchant.incentives.space'), t('profile.merchant.incentives.spaceWhat')],
    ['Merchant', t('profile.merchant.incentives.merchantWhat')],
    ['Merchant Pro', t('profile.merchant.incentives.proWhat')],
    ['Merchant Elite', t('profile.merchant.incentives.eliteWhat')],
    [t('profile.merchant.incentives.operator'), t('profile.merchant.incentives.operatorWhat')],
  ]
  return (
    <section id="merchant" aria-labelledby="profile-merchant" className={cn('scroll-mt-20', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="profile-merchant" className="text-section-title">{t('profile.merchant.title')}</h2>
        <Badge variant="outline" className={TAG}>{t('profile.merchant.tag')}</Badge>
      </div>
      <p className="mt-1 text-body-sm text-brand-text-secondary">{t('profile.merchant.lead')}</p>
      <p className="mt-2 text-body-sm font-medium text-brand-text">{TIERS}</p>
      <h3 className="mt-3 text-sm font-medium text-brand-text">{t('profile.merchant.benefitsTitle')}</h3>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-body-sm text-brand-text-secondary">
        {BENEFITS.map((b) => <li key={b}>{t(`profile.merchant.benefit.${b}`)}</li>)}
      </ul>
      <p className="mt-3 text-caption text-brand-text-secondary">{t('profile.merchant.basis')}</p>
      <p className="mt-1 text-caption text-brand-text-secondary">{t('profile.merchant.noTopTier')} {t('profile.merchant.noAdvantage')} {t('profile.merchant.globalPolicy')}</p>
      <p className="mt-1 text-caption text-brand-text-muted">{t('profile.merchant.referenceFee')}</p>
      {/* CTO 38 complement 1: who gets what, as a proposal with no numbers; the protocol (never a node) sets base fee and benefits. */}
      <h3 className="mt-3 text-sm font-medium text-brand-text">{t('profile.merchant.incentives.title')}</h3>
      <dl className="mt-1 divide-y divide-brand-border-subtle text-body-sm">
        {INCENTIVES.map(([who, what]) => (
          <div key={what} className="py-1.5 sm:grid sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-3">
            <dt className="font-medium text-brand-text">{who}</dt>
            <dd className="text-brand-text-secondary">{what}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1 text-caption text-brand-text-muted">{t('profile.merchant.incentives.note')}</p>
      {demo && (
        <div className="mt-3 rounded-lg bg-brand-surface p-3">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-brand-text">{t('profile.merchant.progressTitle')}<SimulatedBadge label={t('spaces.simulated')} /></p>
          <Progress className="mt-2" value={(DEMO_PROGRESS.done / DEMO_PROGRESS.goal) * 100} label={t('profile.merchant.progress', DEMO_PROGRESS)} />
          <p className="mt-1 tabular-nums text-caption text-brand-text-secondary">{t('profile.merchant.progress', DEMO_PROGRESS)}</p>
          <p className="mt-1 text-caption text-brand-text-muted">{t('profile.merchant.progressNote')}</p>
        </div>
      )}
      <RoleLinks here="merchant" className="mt-3" />
    </section>
  )
}
