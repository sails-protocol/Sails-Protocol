import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from '../ui/toast'
import type { TradeIntentPayload, TradeProposal, CounterProposal } from '@satsails/p2p-trading-sdk'
import { useAuth } from '../../context/AuthContext'
import { sailsClient } from '../../lib/sailsClient'
import { errorMessage } from '../../lib/errors'
import { generateIntentWithQvac, type AgentGeneratedIntent } from '../../lib/qvacAgent'
import { InfoTooltip } from '../ui/InfoTooltip'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { Bot, ArrowDown, ChevronUp, ChevronDown, CheckCircle2, SearchX } from 'lucide-react'
import { ASSET_LABELS, ASSET_SHORT_LABELS, PAYMENT_METHOD_LABELS } from '../../lib/labels'
import type { AssetType, FiatCurrency, TradeSide } from '../../types'
import { useT } from '../../i18n'

// Corrected 2026-08-15 (RFC-023) — "a negociação automática... ainda é
// uma simulação" was true when this copy was written; POST
// /v1/intents/:id/propose is now real (see this component's own
// handleDelegate). "Negociar" here means a real, policy-constrained
// search — the best real Offer within the price/reputation limits below
// — not a back-and-forth of counter-offers (this protocol has no such
// mechanism). QVAC never creates the trade or touches escrow itself: it
// always returns a concrete proposal for you to approve first.
// The boundary copy itself lives in i18n (agent.boundary).

interface Props {
  // Real fix: this panel used to live disconnected from the offer grid
  // below it on Marketplace — generating an intent here never affected
  // what offers were shown, and vice versa, so the two features felt
  // bolted together rather than one flow. Calling this as soon as an
  // intent is generated lets Marketplace narrow its own asset/side/
  // currency filters to match, so the grid updates live.
  onIntentGenerated?: (asset: AssetType, side: TradeSide, currency: FiatCurrency) => void
  // Real bug found in a cold-start UX walkthrough: a goal mentioning a
  // currency the heuristic parser got wrong (qvacAgent.ts's own fix)
  // could silently narrow Marketplace to zero matching offers, with
  // nothing in this panel telling the user why — they'd only see a
  // generic empty grid below, easy to miss or misread as "there's
  // nothing to buy" rather than "this filter is too narrow." Marketplace
  // passes the live post-filter count back in so this panel can say so
  // directly, right where the filter was just set.
  matchCount?: number
  onResetFilters?: () => void
}

export function AgentIntentionPanel({ onIntentGenerated, matchCount, onResetFilters }: Props) {
  const t = useT()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [side, setSide] = useState<TradeSide>('BUY')
  const [goal, setGoal] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<AgentGeneratedIntent | null>(null)

  const [quantity, setQuantity] = useState('')
  const [limitPrice, setLimitPrice] = useState('')
  // RFC-023 — new real mandate field; nothing before this fed a backend
  // that could enforce it. Optional: an empty value means no reputation
  // floor, not zero.
  const [minReputationRating, setMinReputationRating] = useState('')

  // undefined = mandate not yet submitted (still editing); null = a real
  // propose call ran and found nothing within the declared limits; an
  // object = a real matched TradeProposal. intentId is the persisted
  // Intent this proposal came from — kept only to display, never reused
  // across a "Delegar" resubmission (changed limits need a fresh Intent).
  const [intentId, setIntentId] = useState<string | null>(null)
  const [proposal, setProposal] = useState<TradeProposal | null | undefined>(undefined)
  // Missão 02.5 — previously invisible: handleDelegate() called
  // proposeTrade(), which discards the backend's counterProposal, so a
  // real "your price was close, here's what would clear it" result
  // rendered identically to "nothing found at all." Same undefined/null/
  // object lifecycle as `proposal` above, kept in lockstep with it.
  const [counterProposal, setCounterProposal] = useState<CounterProposal | null>(null)
  const [proposing, setProposing] = useState(false)
  const [approving, setApproving] = useState(false)

  const isUsd = result?.currency === 'USD'

  const handleGenerate = async () => {
    if (!goal.trim()) {
      toast.error(t('agent.toast.describeGoal'))
      return
    }
    // Real inference call now (2026-08-09) — requires an active session,
    // same as any other real @satsails/p2p-trading-sdk write/compute call in this app.
    if (!user) {
      toast.error(t('agent.toast.connectWallet'))
      return
    }
    setLoading(true)
    setResult(null)
    setIntentId(null)
    setProposal(undefined)
    setCounterProposal(null)
    try {
      const intent = await generateIntentWithQvac(goal.trim(), side)
      setResult(intent)
      setLimitPrice('')
      setQuantity('')
      setMinReputationRating('')
      onIntentGenerated?.(intent.asset, intent.side, intent.currency)
    } catch (err) {
      toast.error(errorMessage(err, t('agent.toast.generateFailed')))
    } finally {
      setLoading(false)
    }
  }

  // RFC-023 — real: persists a TradeIntent carrying the mandate's own
  // limits (POST /v1/intents, already existed, previously unused by this
  // panel), then asks the backend to search+match against it
  // (proposeTrade -> POST /v1/intents/:id/propose). Never calls
  // openp2p.trade() itself — approving is a separate, explicit step
  // (handleApprove below), preserving the CTO's own boundary: QVAC
  // negotiates, the human approves, only then does escrow ever enter
  // the picture.
  const handleDelegate = async () => {
    if (!result) return
    const qty = Number(quantity)
    if (!qty || qty <= 0) {
      toast.error(t('agent.toast.enterQuantity'))
      return
    }

    let priceLimit: string | undefined
    if (isUsd) {
      const price = Number(limitPrice)
      if (!price || price <= 0) {
        toast.error(t(side === 'BUY' ? 'agent.toast.enterMaxPrice' : 'agent.toast.enterMinPrice'))
        return
      }
      priceLimit = limitPrice
    }

    let minReputation: number | undefined
    const repInput = minReputationRating.trim()
    if (repInput) {
      minReputation = Number(repInput)
      if (!Number.isFinite(minReputation) || minReputation < 0 || minReputation > 5) {
        toast.error(t('agent.toast.reputationRange'))
        return
      }
    }

    setProposing(true)
    try {
      const payload: TradeIntentPayload = {
        asset: result.asset,
        side: result.side,
        currency: result.currency,
        fiatMethod: result.fiatMethod,
        minReputationRating: minReputation,
        ...(priceLimit !== undefined
          ? side === 'BUY' ? { maxPriceUsd: priceLimit } : { minPriceUsd: priceLimit }
          : {}),
      }
      const intent = await sailsClient.createIntent('TradeIntent', payload)
      // Missão 02.5 — proposeTradeOutcome() instead of proposeTrade(): the
      // exact same route and request, but this also surfaces
      // counterProposal instead of silently discarding it.
      const { proposal: found, counterProposal: counter } = await sailsClient.proposeTradeOutcome(intent.id, quantity)
      setIntentId(intent.id)
      setProposal(found)
      setCounterProposal(counter)
      if (found) {
        toast.success(t('agent.toast.found'), { icon: <Bot aria-hidden="true" className="size-icon shrink-0 text-brand-inverse-success" /> })
      } else if (counter) {
        toast.info(t('agent.toast.counter'), { icon: <Bot aria-hidden="true" className="size-icon shrink-0 text-brand-inverse-info" /> })
      }
    } catch (err) {
      toast.error(errorMessage(err, t('agent.toast.searchFailed')))
    } finally {
      setProposing(false)
    }
  }

  // Real, unmodified path: the exact same sailsClient.openp2p.trade()
  // call OfferDetail.tsx's handleStartTrade() already makes for a
  // manually-picked offer — this is the human's explicit approval
  // gate, the only route from a QVAC proposal to a real Trade/Escrow.
  const handleApprove = async () => {
    if (!proposal) return
    setApproving(true)
    try {
      // proposal.amount, not the quantity input state — the proposal
      // already echoes back the exact amount it was matched for; reading
      // from it directly removes any implicit dependency on `quantity`
      // not having changed between the propose and approve calls (it
      // can't today, since no input re-renders once a proposal exists,
      // but this doesn't rely on that staying true).
      const trade = await sailsClient.openp2p.trade(proposal.offerId, proposal.amount)
      toast.success(t('agent.toast.tradeStarted'))
      navigate(`/trade/${trade.id}`)
    } catch (err) {
      toast.error(errorMessage(err, t('agent.toast.startFailed')))
    } finally {
      setApproving(false)
    }
  }

  // Back to the mandate-editing screen — keeps the already-generated
  // QVAC intent and the quantity/price/reputation values as-is, so
  // adjusting one field doesn't force re-describing the whole goal.
  const handleAdjust = () => {
    setIntentId(null)
    setProposal(undefined)
    setCounterProposal(null)
  }

  const handleReset = () => {
    setResult(null)
    setGoal('')
    setQuantity('')
    setLimitPrice('')
    setMinReputationRating('')
    setIntentId(null)
    setProposal(undefined)
    setCounterProposal(null)
  }

  return (
    // UI-FOUNDATION-1-VISUAL-CORRECTION §4.4 — was a bare shadcn Card
    // (bg-card, generic "border") indistinguishable from any other panel;
    // an orange-tinted icon badge + a two-line header (title/subtitle
    // instead of one long run-on label) signals this is the market's one
    // AI-assistance feature, not a generic bordered box.
    // Slim 44px band (D1 prototype): one toggle row, the boundary note beside it.
    <Card>
      <div className="flex min-h-11 items-center gap-1 pr-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={t(open ? 'agent.toggle.close' : 'agent.toggle.open')}
          aria-describedby="sails-agent-subtitle"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-1 text-left"
        >
          <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-orange-accent/10 text-brand-orange-accent">
            <Bot className="h-4 w-4" />
          </span>
          {/* "Sails Agent" is the product identity and is never truncated; the qualifier may be. Only the
              intent is AI-generated; the offer search that follows is deterministic (agent.boundary). */}
          <span className="flex min-w-0 flex-1 items-baseline gap-x-2">
            <span className="shrink-0 text-sm font-semibold text-brand-text">Sails Agent</span>
            <span id="sails-agent-subtitle" className="hidden md:block min-w-0 truncate text-metadata">{t('agent.subtitle')}</span>
          </span>
          {open ? <ChevronUp aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-text-secondary" /> : <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-text-secondary" />}
        </button>
        <InfoTooltip text={t('agent.boundary')} />
      </div>

      {open && (
        <div className="px-4 pb-4 pt-4 border-t border-brand-border-subtle">
          {!result && (
            <>
              <div className="flex gap-1 bg-brand-elevated rounded-lg p-1 w-fit mb-2">
                {(['BUY', 'SELL'] as TradeSide[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSide(s)}
                    className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                      side === s ? 'bg-brand-surface font-medium text-brand-text' : 'text-brand-text-secondary'
                    }`}
                  >
                    {t(s === 'BUY' ? 'agent.side.buy' : 'agent.side.sell')}
                  </button>
                ))}
              </div>

              <Textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder={t('agent.goalPlaceholder')}
                className="w-full"
                rows={2}
              />

              <div className="flex items-center gap-3 mt-2">
                <Button onClick={handleGenerate} loading={loading} className="px-4 py-2 text-sm">
                  {t(loading ? 'agent.generating' : 'agent.generate')}
                </Button>
                {loading && (
                  <span className="text-xs text-brand-text-muted flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-brand-orange-accent motion-safe:animate-pulse" />
                    {t('agent.localInference')}
                  </span>
                )}
              </div>
            </>
          )}

          {result && proposal === undefined && (
            <div className="rounded-lg border border-brand-orange-accent/20 bg-brand-orange-accent/[0.04] p-4">
              <div className="text-xs font-semibold text-brand-orange-accent mb-3">{t('agent.intent.title')}</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs mb-3">
                <Field label={t('agent.intent.asset')} value={ASSET_LABELS[result.asset]} />
                <Field label={t('agent.intent.side')} value={t(result.side === 'BUY' ? 'agent.intent.buy' : 'agent.intent.sell')} />
                <Field label={t('agent.intent.currency')} value={result.currency} />
                <Field label={t('agent.intent.method')} value={PAYMENT_METHOD_LABELS[result.fiatMethod]} />
                <Field label={t('agent.intent.range')} value={`${result.currency} ${result.minValue} – ${result.maxValue}`} />
              </div>

              {matchCount !== undefined && (
                matchCount > 0 ? (
                  <button
                    onClick={() => document.getElementById('marketplace-offer-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    className="text-xs text-brand-orange-accent underline mb-3 flex items-center gap-1"
                  >
                    {t('agent.matches', { count: matchCount })}
                    <ArrowDown className="size-icon-xs" />
                  </button>
                ) : (
                  <div className="mb-3 rounded-md bg-brand-elevated border border-brand-border-subtle px-3 py-2 text-xs text-brand-text-secondary">
                    {t('agent.noMatches', { currency: result.currency, asset: ASSET_LABELS[result.asset] })}
                    {onResetFilters && (
                      <button onClick={onResetFilters} className="ml-2 text-brand-orange-accent underline whitespace-nowrap">
                        {t('agent.resetFilters')}
                      </button>
                    )}
                  </div>
                )
              )}

              <div className="text-xs font-semibold text-brand-text mb-2">{t('agent.mandate.title')}</div>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <label className="text-xs text-brand-text-muted">
                  {t('agent.mandate.quantity', { asset: ASSET_SHORT_LABELS[result.asset] })}
                  <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={t('agent.example', { value: '100' })} className="w-full mt-1 text-sm" />
                </label>
                <label className="text-xs text-brand-text-muted">
                  {t(side === 'BUY' ? 'agent.mandate.maxPrice' : 'agent.mandate.minPrice')}
                  <Input
                    value={limitPrice}
                    onChange={(e) => setLimitPrice(e.target.value)}
                    placeholder={t('agent.example', { value: '1.02' })}
                    disabled={!isUsd}
                    className="w-full mt-1 text-sm disabled:opacity-50"
                  />
                  {/* Real gap, disclosed rather than silently mismatched:
                      Offer.priceUsd is USD-denominated by construction and
                      this app has no FX conversion anywhere — sending a
                      raw non-USD number here would filter against the
                      wrong currency. */}
                  {!isUsd && (
                    <span className="block mt-1 text-xs text-brand-text-muted normal-case">
                      {t('agent.mandate.usdOnly')}
                    </span>
                  )}
                </label>
                <label className="text-xs text-brand-text-muted col-span-2">
                  {t('agent.mandate.minReputation')}
                  <Input
                    type="number" step="0.5" min="0" max="5"
                    value={minReputationRating}
                    onChange={(e) => setMinReputationRating(e.target.value)}
                    placeholder={t('agent.example', { value: '3' })}
                    className="w-full mt-1 text-sm"
                  />
                </label>
              </div>

              <div className="flex gap-2">
                <Button onClick={handleDelegate} loading={proposing} className="px-3 py-1.5 text-xs">
                  <Bot className="size-icon-xs" />
                  {t(proposing ? 'agent.searching' : 'agent.delegate')}
                </Button>
                <Button variant="outline" onClick={handleReset} disabled={proposing} className="px-3 py-1.5 text-xs">
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          )}

          {result && proposal !== undefined && (
            <div className="rounded-lg border border-brand-orange-accent/20 bg-brand-orange-accent/[0.04] p-4">
              {proposal ? (
                <>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-brand-orange-accent mb-2">
                    <Bot className="size-icon-xs" />
                    {t('agent.proposal.title')}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs mb-3">
                    <Field label={t('agent.proposal.price')} value={`USD ${proposal.priceUsd}`} />
                    <Field label={t('agent.proposal.quantity')} value={`${proposal.amount} ${ASSET_SHORT_LABELS[result.asset]}`} />
                    <Field label={t('agent.proposal.reputation')} value={proposal.traderReputation !== null ? String(proposal.traderReputation) : '—'} />
                    <Field label={t('agent.proposal.payment')} value={proposal.paymentMethods.map((m) => PAYMENT_METHOD_LABELS[m as keyof typeof PAYMENT_METHOD_LABELS] ?? m).join(', ')} />
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={handleApprove} loading={approving} className="px-3 py-1.5 text-xs">
                      <CheckCircle2 className="size-icon-xs" />
                      {t(approving ? 'agent.starting' : 'agent.approve')}
                    </Button>
                    <Button variant="outline" onClick={handleAdjust} disabled={approving} className="px-3 py-1.5 text-xs">
                      {t('agent.adjust')}
                    </Button>
                  </div>
                </>
              ) : counterProposal ? (
                // Missão 02.5 — previously this branch never distinguished
                // "nothing at all" from "a real counterproposal exists but
                // wasn't shown." No new approval action here on purpose
                // (Missão 02.5 explicitly scopes this as read-only
                // visibility, not a new negotiation flow) — "Ajustar
                // mandato" is the only real path forward, same as the
                // true-nothing-found case below.
                <>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-brand-orange-accent mb-2">
                    <Bot className="size-icon-xs" />
                    {t('agent.counter.title')}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs mb-3">
                    <Field label={t(side === 'BUY' ? 'agent.counter.limitMax' : 'agent.counter.limitMin')} value={`USD ${counterProposal.suggestedPriceUsd}`} />
                    <Field label={t('agent.counter.nearestPrice')} value={`USD ${counterProposal.listedPriceUsd}`} />
                  </div>
                  <p className="text-xs text-brand-text-secondary mb-3">{counterProposal.reasoning}</p>
                  <Button variant="outline" onClick={handleAdjust} className="px-3 py-1.5 text-xs">
                    {t('agent.adjust')}
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-brand-text-secondary mb-2">
                    <SearchX className="size-icon-xs" />
                    {t('agent.none.title')}
                  </div>
                  <p className="text-xs text-brand-text-secondary mb-3">
                    {t('agent.none.body', { asset: ASSET_LABELS[result.asset] })}
                  </p>
                  <Button variant="outline" onClick={handleAdjust} className="px-3 py-1.5 text-xs">
                    {t('agent.adjust')}
                  </Button>
                </>
              )}
              {intentId && (
                <p className="mt-3 text-xs text-brand-text-muted font-mono">{t('agent.intentId', { id: intentId.slice(0, 8) })}</p>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-brand-surface rounded-md px-2.5 py-1.5 border border-brand-border-subtle">
      <div className="text-brand-text-muted">{label}</div>
      <div className="font-medium text-brand-text">{value}</div>
    </div>
  )
}
