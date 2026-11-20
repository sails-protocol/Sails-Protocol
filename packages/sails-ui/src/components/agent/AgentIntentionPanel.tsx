import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import type { TradeIntentPayload, TradeProposal, CounterProposal } from '@satsails/p2p-trading-sdk'
import { useAuth } from '../../context/AuthContext'
import { sailsClient } from '../../lib/sailsClient'
import { generateIntentWithQvac, type AgentGeneratedIntent } from '../../lib/qvacAgent'
import { InfoTooltip } from '../ui/InfoTooltip'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { Bot, ArrowDown, ChevronUp, ChevronDown, CheckCircle2, SearchX } from 'lucide-react'
import { ASSET_LABELS, ASSET_SHORT_LABELS, PAYMENT_METHOD_LABELS } from '../../lib/labels'
import type { AssetType, FiatCurrency, TradeSide } from '../../types'

const GOAL_PLACEHOLDER = 'Ex: quero comprar USDT pagando via PIX, tenho até R$ 500 disponíveis'

// Corrected 2026-08-15 (RFC-023) — "a negociação automática... ainda é
// uma simulação" was true when this copy was written; POST
// /v1/intents/:id/propose is now real (see this component's own
// handleDelegate). "Negociar" here means a real, policy-constrained
// search — the best real Offer within the price/reputation limits below
// — not a back-and-forth of counter-offers (this protocol has no such
// mechanism). QVAC never creates the trade or touches escrow itself: it
// always returns a concrete proposal for you to approve first.
const BOUNDARY_TEXT =
  'QVAC roda um LLM local (llama.cpp, sem nuvem). É um agente Crypto-Native (RFC-016): só age sobre ativos digitais já na sua wallet — negociar, criar/aceitar ofertas, travar e liberar escrow via WDK. Ele nunca chama uma API bancária e nunca toca PIX ou qualquer trilho fiat — quem faz o PIX é sempre a contraparte humana, fora do protocolo. A geração da intenção e a busca por uma contraparte real dentro dos limites que você definir (preço, reputação mínima) já rodam de verdade — "negociar" aqui é encontrar a melhor oferta real dentro da sua política, não um vaivém de contrapropostas. O QVAC nunca cria o trade nem move fundos sozinho: ele sempre devolve uma proposta concreta para você aprovar antes de qualquer ação de escrow.'

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
      toast.error('Descreva o que você quer negociar')
      return
    }
    // Real inference call now (2026-08-09) — requires an active session,
    // same as any other real @satsails/p2p-trading-sdk write/compute call in this app.
    if (!user) {
      toast.error('Conecte sua wallet para usar o Sails Agent')
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
      toast.error(err instanceof Error ? err.message : 'Falha ao gerar intenção com o QVAC')
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
      toast.error('Informe a quantidade')
      return
    }

    let priceLimit: string | undefined
    if (isUsd) {
      const price = Number(limitPrice)
      if (!price || price <= 0) {
        toast.error(`Informe o preço ${side === 'BUY' ? 'máximo' : 'mínimo'}`)
        return
      }
      priceLimit = limitPrice
    }

    let minReputation: number | undefined
    const repInput = minReputationRating.trim()
    if (repInput) {
      minReputation = Number(repInput)
      if (!Number.isFinite(minReputation) || minReputation < 0 || minReputation > 5) {
        toast.error('Reputação mínima deve estar entre 0 e 5')
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
        toast.success('QVAC encontrou uma proposta real dentro dos seus limites', { icon: <Bot className="h-4 w-4" /> })
      } else if (counter) {
        toast.info('Nenhuma oferta dentro do limite, mas o QVAC sugere uma contraproposta', { icon: <Bot className="h-4 w-4" /> })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao negociar com o QVAC')
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
      toast.success('Trade iniciado')
      navigate(`/trade/${trade.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao iniciar trade')
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
    <Card className="p-4 mb-4 border-brand-border-subtle bg-brand-surface">
      <div className="w-full flex items-center justify-between text-left">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-3 min-w-0 group"
          aria-expanded={open}
        >
          <span className="flex items-center justify-center h-8 w-8 rounded-lg bg-brand-orange-accent/10 text-brand-orange-accent shrink-0">
            <Bot className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="min-w-0 text-left">
            {/* DESIGN-LANGUAGE-1 §7 — "Sails Agent" is now the product-level
                identity for AI/agent assistance across the Sails ecosystem
                (docs/SAILS_DESIGN_LANGUAGE.md §7); this panel is one
                composition of it, not the whole concept, hence "Market
                Negotiation" rather than a flat rename. Renamed the visible
                label only — component name, props, and the underlying
                QVAC-backed intent/propose flow are unchanged.
                UI-POLISH-2 §3.1 — was one `truncate`d line combining both
                ("Sails Agent — Market Negotiati…"), so the identity itself
                got clipped on narrow mobile widths. Product identity is
                never truncated (Design Language's cross-platform
                information-integrity rule): "Sails Agent" now stands alone
                on its own line at full weight; the composition qualifier
                moves into the secondary line below, which is genuinely
                supplementary and safe to truncate. */}
            <span className="block text-sm font-semibold text-brand-text">Sails Agent</span>
            {/* Missão 07.3 — the previous subtitle ("negociação assistida
                por IA (Agente QVAC)") attributed the whole flow to QVAC;
                only the intent itself is AI-generated (real LLM call) —
                the offer search/match that follows is deterministic, not
                QVAC, per BOUNDARY_TEXT below. */}
            <span className="block text-metadata truncate">Market Negotiation · Intenção gerada por IA, busca automática de oferta</span>
          </span>
        </button>
        <div className="flex items-center gap-1 shrink-0 pl-2">
          <InfoTooltip text={BOUNDARY_TEXT} />
          <button
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Fechar Sails Agent' : 'Abrir Sails Agent'}
            aria-expanded={open}
            className="flex items-center justify-center h-7 w-7 rounded-md text-brand-text-muted hover:bg-brand-elevated hover:text-brand-text transition-colors"
          >
            {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-4 pt-4 border-t border-brand-border-subtle">
          {!result && (
            <>
              <div className="flex gap-1 bg-brand-elevated rounded-lg p-1 w-fit mb-2">
                {(['BUY', 'SELL'] as TradeSide[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSide(s)}
                    className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                      side === s ? 'bg-brand-surface shadow-sm font-medium text-brand-text' : 'text-brand-text-secondary'
                    }`}
                  >
                    {s === 'BUY' ? 'Quero comprar' : 'Quero vender'}
                  </button>
                ))}
              </div>

              <Textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder={GOAL_PLACEHOLDER}
                className="w-full"
                rows={2}
              />

              <div className="flex items-center gap-3 mt-2">
                <Button onClick={handleGenerate} disabled={loading} className="px-4 py-2 text-sm disabled:opacity-60">
                  {loading ? 'QVAC pensando...' : 'Gerar com QVAC'}
                </Button>
                {loading && (
                  <span className="text-xs text-brand-text-muted flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-brand-orange-accent animate-pulse" />
                    LLAMA_3_2_1B_INST_Q4_0 · inferência local
                  </span>
                )}
              </div>
            </>
          )}

          {result && proposal === undefined && (
            <div className="rounded-xl border border-brand-orange-accent/20 bg-brand-orange-accent/[0.04] p-4">
              <div className="text-xs font-semibold text-brand-orange-accent mb-3">Intenção estruturada gerada</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs mb-3">
                <Field label="Ativo" value={ASSET_LABELS[result.asset]} />
                <Field label="Lado" value={result.side === 'BUY' ? 'Compra' : 'Venda'} />
                <Field label="Moeda" value={result.currency} />
                <Field label="Método" value={PAYMENT_METHOD_LABELS[result.fiatMethod]} />
                <Field label="Faixa de valor sugerida" value={`${result.currency} ${result.minValue} – ${result.maxValue}`} />
              </div>

              {matchCount !== undefined && (
                matchCount > 0 ? (
                  <button
                    onClick={() => document.getElementById('marketplace-offer-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    className="text-xs text-brand-orange-accent underline mb-3 flex items-center gap-1"
                  >
                    {matchCount} {matchCount === 1 ? 'oferta corresponde' : 'ofertas correspondem'} a este filtro — ver no Marketplace
                    <ArrowDown className="h-3 w-3" />
                  </button>
                ) : (
                  <div className="mb-3 rounded-md bg-brand-elevated border border-brand-border-subtle px-3 py-2 text-xs text-brand-text-secondary">
                    Nenhuma oferta encontrada com {result.currency} + {ASSET_LABELS[result.asset]}
                    {onResetFilters && (
                      <button onClick={onResetFilters} className="ml-2 text-brand-orange-accent underline whitespace-nowrap">
                        Redefinir filtros
                      </button>
                    )}
                  </div>
                )
              )}

              <div className="text-xs font-semibold text-brand-text mb-2">Mandato para o Sails Agent</div>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <label className="text-xs text-brand-text-muted">
                  Quantidade ({ASSET_SHORT_LABELS[result.asset]})
                  <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="Ex: 100" className="w-full mt-1 text-sm" />
                </label>
                <label className="text-xs text-brand-text-muted">
                  Preço {side === 'BUY' ? 'máximo' : 'mínimo'} (USD/un.)
                  <Input
                    value={limitPrice}
                    onChange={(e) => setLimitPrice(e.target.value)}
                    placeholder="Ex: 1.02"
                    disabled={!isUsd}
                    className="w-full mt-1 text-sm disabled:opacity-50"
                  />
                  {/* Real gap, disclosed rather than silently mismatched:
                      Offer.priceUsd is USD-denominated by construction and
                      this app has no FX conversion anywhere — sending a
                      raw non-USD number here would filter against the
                      wrong currency. */}
                  {!isUsd && (
                    <span className="block mt-1 text-[11px] text-brand-text-muted normal-case">
                      Limite de preço disponível apenas para moeda USD nesta versão
                    </span>
                  )}
                </label>
                <label className="text-xs text-brand-text-muted col-span-2">
                  Reputação mínima da contraparte (0–5, opcional)
                  <Input
                    type="number" step="0.5" min="0" max="5"
                    value={minReputationRating}
                    onChange={(e) => setMinReputationRating(e.target.value)}
                    placeholder="Ex: 3"
                    className="w-full mt-1 text-sm"
                  />
                </label>
              </div>

              <div className="flex gap-2">
                <Button onClick={handleDelegate} disabled={proposing} className="px-3 py-1.5 text-xs disabled:opacity-60">
                  <Bot className="h-3.5 w-3.5" />
                  {proposing ? 'QVAC negociando...' : 'Delegar para IA'}
                </Button>
                <Button variant="outline" onClick={handleReset} disabled={proposing} className="px-3 py-1.5 text-xs">
                  Cancelar
                </Button>
              </div>
            </div>
          )}

          {result && proposal !== undefined && (
            <div className="rounded-xl border border-brand-orange-accent/20 bg-brand-orange-accent/[0.04] p-4">
              {proposal ? (
                <>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-brand-orange-accent mb-2">
                    <Bot className="h-3.5 w-3.5" />
                    Proposta real encontrada
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs mb-3">
                    <Field label="Preço" value={`USD ${proposal.priceUsd}`} />
                    <Field label="Quantidade" value={`${proposal.amount} ${ASSET_SHORT_LABELS[result.asset]}`} />
                    <Field label="Reputação da contraparte" value={proposal.traderReputation !== null ? String(proposal.traderReputation) : '—'} />
                    <Field label="Pagamento" value={proposal.paymentMethods.map((m) => PAYMENT_METHOD_LABELS[m as keyof typeof PAYMENT_METHOD_LABELS] ?? m).join(', ')} />
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={handleApprove} disabled={approving} className="px-3 py-1.5 text-xs disabled:opacity-60">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {approving ? 'Iniciando trade...' : 'Aprovar e iniciar trade'}
                    </Button>
                    <Button variant="outline" onClick={handleAdjust} disabled={approving} className="px-3 py-1.5 text-xs">
                      Ajustar mandato
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
                    <Bot className="h-3.5 w-3.5" />
                    Nenhuma oferta dentro do limite — contraproposta do QVAC
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs mb-3">
                    <Field label={side === 'BUY' ? 'Seu limite (máximo)' : 'Seu limite (mínimo)'} value={`USD ${counterProposal.suggestedPriceUsd}`} />
                    <Field label="Preço da oferta mais próxima" value={`USD ${counterProposal.listedPriceUsd}`} />
                  </div>
                  <p className="text-xs text-brand-text-secondary mb-3">{counterProposal.reasoning}</p>
                  <Button variant="outline" onClick={handleAdjust} className="px-3 py-1.5 text-xs">
                    Ajustar mandato
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-brand-text-secondary mb-2">
                    <SearchX className="h-3.5 w-3.5" />
                    Nenhuma oferta encontrada dentro dos seus limites
                  </div>
                  <p className="text-xs text-brand-text-secondary mb-3">
                    O QVAC buscou entre as ofertas reais de {ASSET_LABELS[result.asset]} e nenhuma atendeu ao preço e/ou reputação mínima informados.
                  </p>
                  <Button variant="outline" onClick={handleAdjust} className="px-3 py-1.5 text-xs">
                    Ajustar mandato
                  </Button>
                </>
              )}
              {intentId && (
                <p className="mt-3 text-[11px] text-brand-text-muted font-mono">Intent #{intentId.slice(0, 8)}</p>
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
