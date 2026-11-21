import { Link, useNavigate } from 'react-router'
import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { UserAvatar } from '../components/ui/UserAvatar'
import { CopyButton } from '../components/ui/CopyButton'
import { InfoTooltip } from '../components/ui/InfoTooltip'
import { Button, buttonVariants } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { StatStrip } from '../components/ui/StatStrip'
import { Page, PageHeader } from '../components/layout/PageHeader'
import { cn } from '../lib/utils'
import { Check, Plus } from 'lucide-react'
import { formatMonthYear } from '../lib/format'
import { accountDisputeRateDefinition, formatAccountDisputeRate, RATINGS_DEMO_EXPLANATION, RATINGS_EXPLANATION, REPUTATION_EXPLANATION } from '../lib/reputation'
import { ratingFullText, ratingSrText, sellerRatings } from '../lib/ratings'
import { demoRatingsOf } from '../lib/demoMarkers'
import { RatingSummaryLine } from '../components/ui/RatingSummaryLine'
import { PlannedItem } from '../components/ui/PlannedItem'
import { LOOSE_WIRES } from '../lib/looseWires'
import { ExplanationPopover } from '../components/ui/ExplanationPopover'
import { TRADES_ROUTES } from '../components/layout/navMatch'
import { MyOffersSection } from './MyOffers'
import { MarketsCallToAction } from './markets/MarketsEntry'
import { marketsValueLine } from './markets/shared'
import { t } from '../i18n'

export function Profile() {
  const { user } = useAuth()
  const [keyOpen, setKeyOpen] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    // `state: { from: '/profile' }` added 2026-08-15 — without it, a
    // session lost to a reload bounced here to '/', not back to Profile
    // (Login.tsx's own `handleConnect()` falls back to '/' when
    // `location.state.from` is unset), the same real return-path gap
    // OfferDetail.tsx's handleStartTrade() and Trade.tsx's own reconnect
    // button already close for their pages.
    if (!user) navigate('/login', { state: { from: '/profile' } })
  }, [user, navigate])

  if (!user) return null
  const ratings = sellerRatings({ demoRatings: demoRatingsOf(user) }) // dev demo only; null for real data


  return (
    <Page width="detail">
      <PageHeader
        title={t('profile.title')}
        actions={
          <Link to={TRADES_ROUTES.newOffer} className={cn(buttonVariants({ className: 'shrink-0 min-h-10 touch:min-h-11 px-4' }))}>
            <Plus aria-hidden="true" />
            {t('trades.offers.new')}
          </Link>
        }
      />

      <Card className="p-5">
        <div className="flex gap-4 items-start sm:items-center">
          <UserAvatar user={user} size="lg" />
          <div className="min-w-0">
            <h2 className="text-section-title flex items-center gap-1.5 flex-wrap">
              {user.displayName}
              {user.verified && <Check aria-label={t('profile.verified')} className="h-4 w-4 text-brand-orange-accent" />}
            </h2>
            {/* Real gap found directly by the owner: this key was shown with no label at all. It genuinely is
                the same key: PearNode's own Ed25519 keypair IS the identity keypair (docs/ARCHITECTURE.md,
                pear.service.ts getKeyPair()), so the explainer says so plainly. */}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="flex items-center gap-1 text-xs text-brand-text-muted">
                {t('profile.publicKey')}
                <InfoTooltip text={t('profile.keyExplainer')} />
              </span>
              {/* Start and end of the key always visible (how wallets show addresses); the full key expands in
                  place on any pointer, touch included. Collapsed, screen readers still get the whole key. */}
              <span id="profile-public-key" translate="no" className={cn('mono-id text-body-sm text-brand-text-secondary', keyOpen ? 'basis-full break-all order-last' : 'whitespace-nowrap')}>
                {keyOpen || user.publicKey.length <= 20 ? user.publicKey : <><span aria-hidden="true">{user.publicKey.slice(0, 10)}…{user.publicKey.slice(-8)}</span><span className="sr-only">{user.publicKey}</span></>}
              </span>
              {user.publicKey.length > 20 && (
                <Button variant="ghost" size="sm" aria-expanded={keyOpen} aria-controls="profile-public-key" onClick={() => setKeyOpen((v) => !v)} className="min-h-9 touch:min-h-11 px-2">
                  {t(keyOpen ? 'profile.key.collapse' : 'profile.key.showFull')}
                </Button>
              )}
              <CopyButton value={user.publicKey} className="min-h-9 touch:min-h-11 px-3 shrink-0" />
            </div>
            {formatMonthYear(user.createdAt) && <p className="text-xs text-brand-text-muted mt-1">{t('profile.memberSince', { date: formatMonthYear(user.createdAt) })}</p>}
          </div>
        </div>
        <StatStrip
          className="mt-5 pt-4 border-t border-brand-border-subtle"
          items={[
            { label: t('profile.stat.trades'), value: user.totalTrades },
            // totalVolumeBtc adds up trades in different assets, so it has no unit to show (CTO 437): planned until a USD total exists.
            { label: t('profile.stat.volume'), value: <span className="text-body-sm font-normal text-brand-text-muted">{t('common.soon')}</span> },
            { label: t('trades.history.stat.disputeRate'), value: formatAccountDisputeRate(user), info: accountDisputeRateDefinition() },
            { label: t('profile.stat.reputation'), value: <span className="inline-flex items-center gap-1.5">{user.reputationScore.toFixed(0)}<ExplanationPopover explanation={REPUTATION_EXPLANATION} label={REPUTATION_EXPLANATION.title} /></span> },
          ]}
        />
        {/* Ratings exist (reputation.rate()) but cannot be read back yet: real data gets the planned item, no
            number; only the dev demo carries a summary (lib/ratings.ts). "Membro desde" is already shown above. */}
        {ratings ? (
          <RatingSummaryLine
            className="mt-4 pt-4 border-t border-brand-border-subtle"
            text={ratingFullText(ratings)}
            srText={ratingSrText(ratings)}
            description={t('profile.ratingsDescription')}
            explanation={RATINGS_DEMO_EXPLANATION}
          />
        ) : (
          <PlannedItem
            className="mt-4 pt-4 border-t border-brand-border-subtle"
            icon={LOOSE_WIRES.readRatings.icon}
            label={LOOSE_WIRES.readRatings.label}
            soonLabel={t('common.soon')}
            description={t('profile.ratingsDescription')}
            explanation={RATINGS_EXPLANATION}
          />
        )}
      </Card>

      <MyOffersSection user={user} className="mt-8" />

      {/* Markets invitation in a natural place (DECISIONS.md "Modelo mundo aberto"). */}
      <section aria-labelledby="profile-markets" className="mt-8">
        <h2 id="profile-markets" className="text-section-title">{t('profile.markets')}</h2>
        <p className="mt-1 text-body-sm text-brand-text-secondary">{marketsValueLine()}</p>
        <MarketsCallToAction className="mt-2 -ml-3 justify-start" />
      </section>

    </Page>
  )
}
