/**
 * Moved out of pages/admin/ (2026-08-04) — this page was never a
 * privileged "operator" view to begin with, real listDisputes() is
 * scoped server-side to the caller's own arbiterId, same as any other
 * participant-scoped read (getTrades()/getMyOffers()). Grouping it under
 * "admin" implied a platform-operator tier that doesn't exist in this
 * protocol's authorization model — see feedback_no_platform_operator_
 * visibility (memory) for why that's a deliberate non-custodial design
 * choice, not a gap. No client-side role gate needed either: if the
 * caller isn't a real assigned arbiter for anything, listDisputes()
 * legitimately returns an empty list, handled by this page's own empty
 * state below.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { useAuth } from '../context/AuthContext'
import { sailsClient } from '../lib/sailsClient'
import type { Dispute, DisputeRuling, Escrow, EscrowType } from '@satsails/p2p-trading-sdk'
import { AssetBadge } from '../components/ui/StatusBadges'
import { formatAmount, formatDateTime } from '../lib/format'
import { DISPUTE_RULING_LABEL } from '../lib/labels'
import { Button } from '../components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '../components/ui/sheet'
import { ArrowRight, Bot, ShieldCheck, Scissors } from 'lucide-react'

// Sails Core Implementation Program M8-R2 (Destination Authority
// Conformance, disputed rails, 2026-09-11, docs/DESTINATION_AUTHORITY_ARCHITECTURE.md)
// — removed. This map used to supply a "destination" the arbiter would
// pass to resolveDisputeWithWallet() for RELEASE/SPLIT, giving a false
// impression that the arbiter chooses where the beneficiary's funds go.
// The arbiter has Economic Disposition Authority (who is entitled, and
// how much) — never Destination Authority (where they receive it), which
// belongs to the beneficiary alone via their own registered
// PayoutAddress. The server now ignores any address supplied here for
// every rail (see dispute.service.ts's own applyRuling()/
// applyRulingCoreAuthoritative() comments), so this console no longer
// supplies one at all — the same pattern REFUND already used below,
// unchanged, before this fix (it never passed an address either).

// RFC-021 D9 — SPLIT only works for these three; SAFE_GUARD_EVM's
// immutable Guard contract and LIGHTNING_HODL's fixed-leaf VtxoScript
// each can't represent a partial payout (settlement.ts's own
// resolveDispute() doc comment has the full per-provider reasoning).
const SPLIT_SUPPORTED: ReadonlySet<EscrowType> = new Set(['MOCK', 'WDK_USDT_EVM', 'MULTISIG'])

// MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM all use client-held keys — a
// RELEASE/SPLIT ruling here starts a signature round (escrow.service.ts's
// initiateRelease(), the same one Trade.tsx's own handleReleaseFunds()
// already triggers on the happy path) rather than moving funds
// immediately, so the toast says so instead of implying it's instant.
const SIGNATURE_COLLECTION_TYPES: ReadonlySet<EscrowType> = new Set(['MULTISIG', 'LIGHTNING_HODL', 'SAFE_GUARD_EVM'])

interface Row {
  dispute: Dispute
  escrow: Escrow | null // null if this specific escrow fetch failed — row still shows, just without asset/amount/type-aware actions
}

export function Disputes() {
  const { user, wallet, loading: authLoading } = useAuth()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [acting, setActing] = useState(false)

  // Real GET /v1/settlement/disputes (2026-08-03, closes the exact gap
  // this page was blocked on: every resolve/appeal/evidence/contest
  // action was already real, but nothing could discover a disputeId to
  // call them with). Always scoped server-side to the caller's own
  // arbiterId — there is no "view another arbiter's caseload" here, by
  // design (same doc comment as the SDK's own listDisputes()).
  const load = () => {
    if (!user) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    sailsClient.settlement
      .listDisputes({ limit: 50 })
      .then(async (page) => {
        if (cancelled) return
        // One extra settlement.get() per dispute — needed functionally,
        // not just cosmetically: whether SPLIT is offered at all
        // (SPLIT_SUPPORTED), whether a RELEASE/SPLIT ruling starts a
        // signature round (SIGNATURE_COLLECTION_TYPES, for the toast
        // wording), and the asset/locked-amount display below all need
        // this trade's real escrow.type/asset known before a ruling
        // button can even be built. **Corrected 2026-09-11 (M8-R2):**
        // this comment previously also cited needing a payout address "in
        // the right format for this specific escrow.type" as a reason —
        // stale now that this console no longer supplies a destination at
        // all (see resolve()'s own comment below).
        const withEscrow = await Promise.all(
          page.disputes.map(async (dispute): Promise<Row> => {
            const escrow = await sailsClient.settlement.get(dispute.escrowId).catch(() => null)
            return { dispute, escrow }
          })
        )
        if (!cancelled) setRows(withEscrow)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Falha ao carregar disputas')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }

  useEffect(load, [user])

  const selected = rows.find((r) => r.dispute.id === selectedId) ?? null

  // Fixed 2026-08-29 (Missão 13 Fase 2, INV-12) — the server now requires a
  // signed authority decision before it will execute any ruling
  // (settlement.ts's resolveDispute()/resolveDisputeWithWallet() own
  // header comments have the full rationale), and this arbiter console
  // used to call the unsigned resolveDispute() directly, which now fails
  // fast with a clear SailsValidationError. Rather than inventing new
  // wallet/key-custody infrastructure for this reference UI, this reuses
  // the exact Ed25519 keypair AuthContext already generates and holds to
  // sign this arbiter in (`useAuth().wallet`, a LocalKeypairWalletAdapter
  // wrapping it) — the server verifies the authority decision against
  // this dispute's arbiterId's own registered User.publicKey, which is
  // precisely this same keypair's public half, so a fresh/unrelated
  // keypair would just trade this client-side error for a 403 Forbidden.
  // Real production key custody (hardware wallet, browser extension,
  // etc.) is still a separate concern — see AuthContext.tsx's own header
  // for why this keypair's storage is demo-only, disclosed rather than
  // hidden.
  const resolve = async (row: Row, ruling: DisputeRuling) => {
    if (!row.escrow) {
      toast.error('O escrow desta disputa não pôde ser carregado — tente novamente')
      return
    }
    if (!wallet) {
      toast.error('Nenhuma chave de assinatura disponível nesta sessão — reconecte sua wallet')
      return
    }
    const needsSignature = SIGNATURE_COLLECTION_TYPES.has(row.escrow.type)
    setActing(true)
    try {
      if (ruling === 'RELEASE') {
        // No destination passed — the buyer's own registered PayoutAddress
        // governs (server-enforced for every rail, not just MULTISIG).
        await sailsClient.settlement.resolveDisputeWithWallet(row.dispute.id, 'RELEASE', wallet)
        toast.success(needsSignature ? 'Resolvido a favor do comprador — aguardando assinatura pra liberar os fundos' : 'Resolvido a favor do comprador')
      } else if (ruling === 'REFUND') {
        await sailsClient.settlement.resolveDisputeWithWallet(row.dispute.id, 'REFUND', wallet)
        toast.success('Resolvido a favor do vendedor')
      } else {
        // Same reasoning as RELEASE above — buyer's and seller's own
        // registered PayoutAddresses govern independently, never a value
        // supplied here.
        await sailsClient.settlement.resolveDisputeWithWallet(row.dispute.id, 'SPLIT', wallet, undefined, undefined, 5000)
        toast.success(needsSignature ? 'Dividido 50/50 — aguardando assinatura pra liberar os fundos' : 'Dividido 50/50 entre comprador e vendedor')
      }
      setSelectedId(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao resolver disputa')
    } finally {
      setActing(false)
    }
  }

  // RFC-021 D8 — accepting just applies the recommendation now instead
  // of waiting for autoResolutionDeadline to pass uncontested
  // (sweepExpiredAutoResolutions()'s own job). Note there is no
  // "reject recommendation" action here for the arbiter — resolveDispute()
  // has no status guard against AUTO_PROPOSED (only "not already
  // RESOLVED"), so the arbiter can just resolve directly with their own
  // ruling below, superseding the pending automation. Contesting it is a
  // real action, but it's the TRADE PARTY's (buyer/seller), not the
  // arbiter's — contestAutoResolution() is server-rejected for anyone
  // else (dispute.service.ts: `contestedBy !== trade.buyerId &&
  // contestedBy !== trade.sellerId` throws Forbidden) — see Trade.tsx's
  // own dispute section for where that button actually belongs.
  const acceptAutoResolution = (row: Row) => {
    if (row.dispute.autoResolutionRecommendation) resolve(row, row.dispute.autoResolutionRecommendation)
  }

  if (authLoading || loading) {
    return <div className="text-center py-16 text-brand-text-muted">Carregando disputas...</div>
  }

  if (!user) {
    return (
      <div className="text-center py-16">
        <p className="text-brand-text-secondary">Conecte sua wallet para ver disputas atribuídas a você.</p>
        <Link to="/login" className="text-sm text-brand-orange-accent underline mt-2 inline-block">Conectar</Link>
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center py-16">
        <p className="text-red-500 text-sm">{error}</p>
        <Button variant="outline" onClick={load} className="mt-3 text-xs px-3 py-1.5">Tentar novamente</Button>
      </div>
    )
  }

  const openCount = rows.filter((r) => r.dispute.status !== 'RESOLVED').length

  return (
    <div>
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-display font-bold tracking-tight text-brand-text">Disputas</h1>
        {openCount > 0 && (
          <span className="bg-red-500/10 text-red-500 text-xs font-bold rounded-full px-2 py-0.5">{openCount}</span>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="text-center text-brand-text-muted py-10">Nenhuma disputa atribuída a você no momento.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {rows.map((row) => {
            const d = row.dispute
            const splitAllowed = row.escrow ? SPLIT_SUPPORTED.has(row.escrow.type) : false
            return (
              <div key={d.id} className="bg-brand-surface border border-red-500/20 rounded-lg p-5">
                <div className="flex items-center gap-2 text-xs flex-wrap">
                  <Link to={`/trade/${d.tradeId}`} className="font-mono text-brand-text-muted hover:text-brand-text underline-offset-2 hover:underline">
                    Trade #{d.tradeId.slice(0, 8)}
                  </Link>
                  {row.escrow && <AssetBadge asset={row.escrow.asset} />}
                  <span className="text-brand-text-muted">{formatDateTime(d.createdAt)}</span>
                  <span
                    className={`ml-auto px-2 py-0.5 rounded-full font-medium flex items-center gap-1 ${
                      d.status === 'RESOLVED'
                        ? 'bg-green-500/10 text-green-500'
                        : d.status === 'AUTO_PROPOSED'
                          ? 'bg-purple-500/10 text-purple-400'
                          : 'bg-red-500/10 text-red-500'
                    }`}
                  >
                    {d.status === 'AUTO_PROPOSED' && <Bot className="h-3 w-3" />}
                    {d.status === 'AUTO_PROPOSED' ? 'Resolução automática proposta' : d.status}
                  </span>
                </div>
                {row.escrow && (
                  <div className="mt-1.5 text-xs text-brand-text-muted">{formatAmount(Number(row.escrow.lockedAmount))} em escrow</div>
                )}
                <p className="text-sm text-brand-text-muted mt-1 line-clamp-2">{d.reason}</p>
                {d.status === 'RESOLVED' && d.ruling && (
                  <p className="text-xs text-green-500 mt-1">Decisão: {DISPUTE_RULING_LABEL[d.ruling] ?? d.ruling}{d.resolvedAt && ` — ${formatDateTime(d.resolvedAt)}`}</p>
                )}

                {/* RFC-021 D8 — QVAC-assisted first-pass resolution, off by
                    default server-side (config.features.qvacAutoResolutionEnabled).
                    Confidence + reasoning shown so a human arbiter can
                    judge the recommendation, not just accept it blindly. */}
                {d.status === 'AUTO_PROPOSED' && d.autoResolutionRecommendation && (
                  <div className="mt-3 bg-purple-500/5 border border-purple-500/20 rounded-lg p-3 text-xs">
                    <div className="flex items-center gap-1.5 font-semibold text-purple-400">
                      <Bot className="h-3.5 w-3.5" /> Recomendação: {DISPUTE_RULING_LABEL[d.autoResolutionRecommendation]}
                      <span className="ml-auto font-normal text-brand-text-muted">{Math.round((d.autoResolutionConfidence ?? 0) * 100)}% de confiança</span>
                    </div>
                    <p className="text-brand-text-secondary mt-1">{d.autoResolutionReasoning}</p>
                    {d.autoResolutionDeadline && (
                      <p className="text-brand-text-muted mt-1">Aplica automaticamente em {formatDateTime(d.autoResolutionDeadline)} se ninguém contestar</p>
                    )}
                  </div>
                )}

                {d.status !== 'RESOLVED' && (
                  <div className="mt-3 flex gap-2 flex-wrap">
                    <Button variant="outline" onClick={() => setSelectedId(d.id)} disabled={acting} className="text-xs px-3 py-1.5">Revisar</Button>
                    {/* Accepting the AI recommendation is a convenience
                        shortcut, never the only option — resolveDispute()
                        has no status guard against AUTO_PROPOSED, so the
                        arbiter can independently override with any ruling
                        below regardless of what QVAC proposed. */}
                    {d.status === 'AUTO_PROPOSED' && d.autoResolutionRecommendation && (
                      <Button onClick={() => acceptAutoResolution(row)} disabled={acting} className="text-xs px-3 py-1.5">
                        <ShieldCheck className="h-3.5 w-3.5" /> Aceitar recomendação
                      </Button>
                    )}
                    <Button variant="outline" onClick={() => resolve(row, 'RELEASE')} disabled={acting} className="text-xs px-3 py-1.5">
                      Resolver <ArrowRight className="h-3.5 w-3.5" /> Comprador
                    </Button>
                    <Button variant="outline" onClick={() => resolve(row, 'REFUND')} disabled={acting} className="text-xs px-3 py-1.5">
                      Resolver <ArrowRight className="h-3.5 w-3.5" /> Vendedor
                    </Button>
                    {splitAllowed && (
                      <Button
                        variant="outline"
                        onClick={() => resolve(row, 'SPLIT')}
                        disabled={acting}
                        title="Divide 50/50 entre comprador e vendedor"
                        className="text-xs px-3 py-1.5"
                      >
                        <Scissors className="h-3.5 w-3.5" /> Dividir 50/50
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Real Radix Sheet (2026-08-01) — replaces a hand-rolled
          `fixed inset-0` backdrop + manual `stopPropagation()` + a
          duplicate "✕ Fechar" button (SheetContent already renders an
          accessible close control). Real gain (focus trap, Escape,
          role="dialog"), not just visual consistency — see
          feedback_slc_ui_philosophy. */}
      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent className="w-full max-w-md overflow-y-auto">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>
                  Disputa — <Link to={`/trade/${selected.dispute.tradeId}`} className="underline underline-offset-2">Trade #{selected.dispute.tradeId.slice(0, 8)}</Link>
                </SheetTitle>
                <SheetDescription>{selected.dispute.reason}</SheetDescription>
              </SheetHeader>
              <div className="mt-4 text-sm space-y-1">
                {selected.escrow && (
                  <>
                    <div><span className="text-brand-text-muted">Ativo:</span> <span className="text-brand-text">{selected.escrow.asset}</span></div>
                    <div><span className="text-brand-text-muted">Valor:</span> <span className="text-brand-text">{formatAmount(Number(selected.escrow.lockedAmount))}</span></div>
                  </>
                )}
                {selected.dispute.appealRound > 0 && (
                  <div>
                    <span className="text-brand-text-muted">Rodada de apelação:</span>{' '}
                    <span className="text-brand-text">
                      #{selected.dispute.appealRound}
                      {selected.dispute.previousRuling ? ` (decisão anterior: ${DISPUTE_RULING_LABEL[selected.dispute.previousRuling] ?? selected.dispute.previousRuling})` : ''}
                    </span>
                  </div>
                )}
              </div>

              {selected.dispute.status === 'AUTO_PROPOSED' && selected.dispute.autoResolutionRecommendation && (
                <div className="mt-4 bg-purple-500/5 border border-purple-500/20 rounded-lg p-3 text-sm">
                  <div className="flex items-center gap-1.5 font-semibold text-purple-400">
                    <Bot className="h-4 w-4" /> Recomendação da QVAC: {DISPUTE_RULING_LABEL[selected.dispute.autoResolutionRecommendation]}
                  </div>
                  <p className="text-brand-text-secondary mt-1.5">{selected.dispute.autoResolutionReasoning}</p>
                  <p className="text-brand-text-muted mt-1.5 text-xs">
                    {Math.round((selected.dispute.autoResolutionConfidence ?? 0) * 100)}% de confiança
                    {selected.dispute.autoResolutionDeadline && ` — aplica automaticamente em ${formatDateTime(selected.dispute.autoResolutionDeadline)} se ninguém contestar`}
                  </p>
                </div>
              )}
              {selected.dispute.status !== 'RESOLVED' && (
                <div className="mt-4 flex gap-2 flex-wrap">
                  {selected.dispute.status === 'AUTO_PROPOSED' && selected.dispute.autoResolutionRecommendation && (
                    <Button onClick={() => acceptAutoResolution(selected)} disabled={acting} className="flex-1 py-2 text-sm">
                      <ShieldCheck className="h-4 w-4" /> Aceitar recomendação
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => resolve(selected, 'RELEASE')} disabled={acting} className="flex-1 py-2 text-sm">
                    Liberar p/ Comprador
                  </Button>
                  <Button variant="outline" onClick={() => resolve(selected, 'REFUND')} disabled={acting} className="flex-1 py-2 text-sm">
                    Reembolsar Vendedor
                  </Button>
                  {selected.escrow && SPLIT_SUPPORTED.has(selected.escrow.type) && (
                    <Button variant="outline" onClick={() => resolve(selected, 'SPLIT')} disabled={acting} className="flex-1 py-2 text-sm">
                      <Scissors className="h-4 w-4" /> Dividir 50/50
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
