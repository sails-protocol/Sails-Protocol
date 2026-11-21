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
 *
 * The list is triage only; a ruling can be chosen only inside the case
 * file (evidence, parties, suggestion and appeal round on one screen),
 * and every ruling still goes through the confirmation dialog.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from '../components/ui/toast'
import { useAuth } from '../context/AuthContext'
import { sailsClient } from '../lib/sailsClient'
import type { Dispute, DisputeRuling, Escrow, EscrowType, Trade } from '@satsails/p2p-trading-sdk'
import { ESCROW_STATUS_LABEL, TradeStatusBadge } from '../components/ui/StatusBadges'
import { formatAmount, formatDateTime, formatUsd } from '../lib/format'
import { errorMessage } from '../lib/errors'
import { ASSET_LABELS, ASSET_SHORT_LABELS, DISPUTE_STATUS_LABEL } from '../lib/labels'
import { decisionOptions, multisigPendingSigner, parseEvidence, partyIdFor, partyRole, pendingSuggestion, RULING_DECISION, selectableOption, splitUnavailableHere, type DecisionChoice } from '../lib/disputeCase'
import { Button, buttonVariants } from '../components/ui/button'
import { badgeVariants } from '../components/ui/badge'
import { Card } from '../components/ui/card'
import { ListSkeleton } from '../components/ui/skeleton'
import { StateBlock } from '../components/ui/StateBlock'
import { TABLE_HEAD_ROW, TABLE_ROW, TABLE_ROW_INTERACTIVE } from '../components/ui/table'
import { Page, PageHeader } from '../components/layout/PageHeader'
import { TRADES_ROUTES } from '../components/layout/navMatch'
import { TradesTabs } from '../components/layout/TradesTabs'
import { cn } from '../lib/utils'
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetDescription } from '../components/ui/sheet'
import { ConfirmActionDialog } from '../components/ui/ConfirmActionDialog'
import { Bot, ChevronRight, Info, X } from 'lucide-react'
import { TONE_CLASS } from '../lib/tone'
import { RadioCard, RadioGroup } from '../components/ui/radio-group'
import { t, type MessageKey } from '../i18n'

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

// RFC-021 D9 SPLIT gating (SPLIT_SUPPORTED) lives in lib/disputeCase.ts's decisionOptions().

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

// Keys, not copy: t() runs on read so the labels follow the interface language.
const EVIDENCE_TYPE_KEY: Record<string, MessageKey> = {
  text: 'disputes.evidenceType.text', payment_receipt: 'disputes.evidenceType.payment_receipt',
  chat_log: 'disputes.evidenceType.chat_log', screenshot: 'disputes.evidenceType.screenshot',
}
const ROLE_KEY = { buyer: 'disputes.role.buyer', seller: 'disputes.role.seller' } as const

const shortId = (id: string) => id.slice(0, 8)
const amountText = (e: Escrow) => `${formatAmount(Number(e.lockedAmount))} ${ASSET_SHORT_LABELS[e.asset] ?? e.asset}`
// pt-BR plural rules put 0 in `one`; the zero case keeps its own message ("0 evidências").
const countLabel = (n: number) => (n === 0 ? t('disputes.evidenceCountZero') : t('disputes.evidenceCount', { count: n }))
/** Who still has to sign a MULTISIG disputed release/refund, in the interface language (multisigPendingSigner decides whether anyone does). */
const signerText = (ruling: DisputeRuling) => (multisigPendingSigner(ruling) ? t(ruling === 'RELEASE' ? 'disputes.signer.buyer' : 'disputes.signer.seller') : null)

// Desktop table columns: Trade | Valor | Status | Aberta por | Evidências | Aberta em | action.
const DISPUTE_COLS = 'xl:grid-cols-[8rem_8rem_10rem_minmax(0,1fr)_5.5rem_6.5rem_auto] xl:items-center xl:gap-y-0'

/** Same pill shape as the trade status badge: resolved reads green, everything else neutral (no invented severity). */
function DisputeStatusBadge({ status }: { status: Dispute['status'] }) {
  const tone = status === 'RESOLVED'
    ? TONE_CLASS.success
    : TONE_CLASS.neutral
  return (
    <span className={cn(badgeVariants({ variant: 'outline' }), 'inline-flex max-w-full rounded-full px-2 py-0.5 text-left', tone)}>
      {DISPUTE_STATUS_LABEL[status] ?? status}
    </span>
  )
}

// Same columns as Ativos/Histórico (Valor | Papel | Status | 1fr | Data | ›), so the tabs line up.
const MY_COLS = 'lg:grid lg:grid-cols-[10rem_6.5rem_8rem_minmax(0,1fr)_7rem_1rem] lg:items-center lg:gap-4'

/**
 * Trades → Disputas (/trades/disputes; /disputes redirects here). Main list: the viewer's OWN trades in
 * dispute (getTrades(), the same source as Ativos/Histórico, status DISPUTED); each row opens its trade,
 * where the dispute panel lives. Below it, only for arbiters, the caseload assigned to them (ArbiterCases).
 */
export function Disputes() {
  const { user, loading: authLoading } = useAuth()
  const [trades, setTrades] = useState<Trade[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    if (!user) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    sailsClient.openp2p
      .getTrades({ limit: 50 })
      .then((page) => {
        if (!cancelled) setTrades(page.trades.filter((t) => t.status === 'DISPUTED').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
      })
      .catch((err) => { if (!cancelled) setError(errorMessage(err, t('trades.active.loadFailed'))) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }
  useEffect(load, [user])

  const signedOut = !authLoading && !user
  const ready = !!user && !error && !authLoading && !loading

  return (
    <Page>
      <PageHeader
        title="Trades"
        meta={ready && trades.length > 0 ? t('disputes.meta', { count: trades.length }) : undefined}
      >
        <TradesTabs openDisputes={ready ? trades.length : null} />
      </PageHeader>

      {signedOut ? (
        <StateBlock
          kind="signedOut"
          title={t('trades.connectTitle')}
          description={t('disputes.signedOutDescription')}
          action={<Link to="/login" state={{ from: TRADES_ROUTES.disputes }} className={cn(buttonVariants({ className: 'min-h-10 touch:min-h-11 px-4' }))}>{t('trades.connect')}</Link>}
        />
      ) : error ? (
        <StateBlock
          kind="error"
          title={t('disputes.errorTitle')}
          description={error}
          action={<Button variant="outline" onClick={load} className="min-h-9 touch:min-h-11 px-4">{t('trades.retry')}</Button>}
        />
      ) : authLoading || loading ? (
        <Card className="overflow-hidden">
          <ListSkeleton label={t('disputes.loading')} rows={2} rowClassName="h-[5.5rem] lg:h-[3.75rem]" />
        </Card>
      ) : trades.length === 0 ? (
        <StateBlock kind="empty" title={t('disputes.emptyTitle')} description={t('disputes.emptyDescription')} />
      ) : (
        <Card className="overflow-hidden">
          <div aria-hidden="true" className={cn(TABLE_HEAD_ROW, 'hidden', MY_COLS)}>
            <span>{t('trades.col.amount')}</span>
            <span>{t('trades.col.role')}</span>
            <span>{t('trades.col.status')}</span>
            <span>{t('disputes.col.where')}</span>
            <span className="text-right">{t('trades.col.updated')}</span>
            <span />
          </div>
          <ul>
            {trades.map((tr) => {
              const role = t(tr.buyerId === user?.id ? 'trades.role.buyer' : 'trades.role.seller')
              return (
                <li key={tr.id} className={TABLE_ROW}>
                  <Link to={`/trade/${tr.id}`} className={cn('flex flex-col gap-1 px-4 py-3', TABLE_ROW_INTERACTIVE, MY_COLS)}>
                    <span className="flex items-center justify-between gap-3 lg:block">
                      <span className="min-w-0">
                        <span className="money block text-brand-text">{formatAmount(Number(tr.amount))} {ASSET_SHORT_LABELS[tr.asset]}</span>
                        <span className="hidden lg:block text-xs text-brand-text-muted tabular-nums">{formatUsd(Number(tr.totalUsd))} USD</span>
                      </span>
                      <span className="lg:hidden"><TradeStatusBadge status={tr.status} /></span>
                    </span>
                    <span className="hidden lg:block text-sm text-brand-text-secondary">{role}</span>
                    <span className="hidden lg:block"><TradeStatusBadge status={tr.status} /></span>
                    <span className="text-sm text-brand-text-secondary">{t('disputes.followOnTrade')}</span>
                    <span className="text-xs text-brand-text-muted tabular-nums lg:text-right">
                      <span className="lg:hidden">{role} · {formatUsd(Number(tr.totalUsd))} USD · </span>
                      {formatDateTime(tr.updatedAt)}
                    </span>
                    <ChevronRight className="hidden lg:block h-4 w-4 text-brand-text-muted" aria-hidden="true" />
                  </Link>
                </li>
              )
            })}
          </ul>
        </Card>
      )}

      {user && <ArbiterCases />}
    </Page>
  )
}

/** Arbiter caseload (listDisputes(), scoped server-side to the caller as arbiter): list + case file + ruling. Unchanged. */
function ArbiterCases() {
  const { user, wallet, loading: authLoading } = useAuth()
  const [rows, setRows] = useState<Row[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [choice, setChoice] = useState<DecisionChoice | null>(null)
  const [acting, setActing] = useState(false)
  // Every ruling only asks; resolve() runs from the confirmation dialog.
  const [pending, setPending] = useState<{ row: Row; ruling: DisputeRuling; viaSuggestion: boolean } | null>(null)
  // Controlled Sheet without a Trigger: remember which row's "Abrir caso" to give focus back to.
  const openButtons = useRef(new Map<string, HTMLButtonElement>())
  const openedFrom = useRef<string | null>(null)
  const caseHeading = useRef<HTMLHeadingElement>(null)

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
        // can even be offered. **Corrected 2026-09-11 (M8-R2):**
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
        if (cancelled) return
        setRows(withEscrow)
        // Display names for the opener, evidence senders and known parties
        // (public identity read); a failed lookup falls back to a short id.
        const ids = new Set<string>()
        for (const { dispute, escrow } of withEscrow) {
          ids.add(dispute.openedBy)
          for (const e of parseEvidence(dispute.evidence)) if (e.submittedBy) ids.add(e.submittedBy)
          for (const k of escrow?.participantKeys ?? []) if (k.role !== 'arbiter') ids.add(k.participantId)
        }
        const found = await Promise.all(
          [...ids].map((id) => sailsClient.identity.get(id).then((p) => [id, p.displayName] as const).catch(() => null))
        )
        if (!cancelled) setNames(Object.fromEntries(found.filter((f): f is readonly [string, string] => !!f?.[1])))
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('disputes.loadFailed'))
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

  const openCase = (id: string) => {
    openedFrom.current = id
    setChoice(null)
    setSelectedId(id)
  }

  const personLabel = (id: string | null, escrow: Escrow | null) => {
    if (!id) return t('disputes.notAvailable')
    const role = partyRole(id, escrow)
    const name = names[id] ?? t('disputes.participant', { id: shortId(id) })
    return role ? t('disputes.personWithRole', { name, role: t(ROLE_KEY[role]) }) : name
  }

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
      toast.error(t('disputes.toast.escrowNotLoaded'))
      return
    }
    if (!wallet) {
      toast.error(t('disputes.toast.noSigningKey'))
      return
    }
    const needsSignature = SIGNATURE_COLLECTION_TYPES.has(row.escrow.type)
    // MULTISIG disputed release/refund: requiredSigners is the buyer (RELEASE) or the seller (REFUND), see multisig.provider.ts.
    const signer = row.escrow.type === 'MULTISIG' ? signerText(ruling) : null
    // One message per outcome: the decision, then who still has to sign, or that a signature round started.
    const ruled = (decision: string, awaitingSignature: boolean) =>
      signer ? t('disputes.ruled.signerWait', { decision, signer }) : awaitingSignature ? t('disputes.ruled.awaitingSignature', { decision }) : decision
    setActing(true)
    try {
      if (ruling === 'RELEASE') {
        // No destination passed — the buyer's own registered PayoutAddress
        // governs (server-enforced for every rail, not just MULTISIG).
        await sailsClient.settlement.resolveDisputeWithWallet(row.dispute.id, 'RELEASE', wallet)
        toast.success(ruled(t('disputes.ruled.release'), needsSignature))
      } else if (ruling === 'REFUND') {
        await sailsClient.settlement.resolveDisputeWithWallet(row.dispute.id, 'REFUND', wallet)
        toast.success(ruled(t('disputes.ruled.refund'), false))
      } else {
        // Same reasoning as RELEASE above — buyer's and seller's own
        // registered PayoutAddresses govern independently, never a value
        // supplied here.
        await sailsClient.settlement.resolveDisputeWithWallet(row.dispute.id, 'SPLIT', wallet, undefined, undefined, 5000)
        toast.success(ruled(t('disputes.ruled.split'), needsSignature))
      }
      setSelectedId(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('disputes.toast.resolveFailed'))
    } finally {
      setActing(false)
    }
  }

  // The confirmation dialog may be stale: re-read the escrow (and its
  // dispute) and rule only if the dispute is still open and assigned to
  // this arbiter; otherwise refresh the list instead of executing.
  const confirmRuling = async (row: Row, ruling: DisputeRuling, viaSuggestion: boolean) => {
    setActing(true)
    const fresh = await sailsClient.settlement.get(row.dispute.escrowId).catch(() => null)
    setActing(false)
    const dispute = fresh?.disputes?.find((d) => d.id === row.dispute.id)
    if (!fresh) {
      toast.error(t('disputes.toast.stateCheckFailed'))
    } else if (splitUnavailableHere(ruling, fresh.type)) {
      toast.error(t('disputes.toast.splitUnavailable'))
    } else if (
      !dispute || dispute.status === 'RESOLVED' || dispute.arbiterId !== user?.id ||
      // Accepting the suggestion only while that exact suggestion is still pending.
      (viaSuggestion && (dispute.status !== 'AUTO_PROPOSED' || dispute.autoResolutionRecommendation !== ruling))
    ) {
      toast.error(t('disputes.toast.stateChanged'))
      setPending(null)
      setSelectedId(null)
      load()
      return
    } else {
      await resolve({ dispute, escrow: fresh }, ruling)
    }
    setPending(null)
  }

  // RFC-021 D8 — accepting just applies the recommendation now instead
  // of waiting for autoResolutionDeadline to pass uncontested
  // (sweepExpiredAutoResolutions()'s own job). Note there is no
  // "reject recommendation" action here for the arbiter — resolveDispute()
  // has no status guard against AUTO_PROPOSED (only "not already
  // RESOLVED"), so the arbiter can just resolve directly with their own
  // ruling, superseding the pending automation. Contesting it is a
  // real action, but it's the TRADE PARTY's (buyer/seller), not the
  // arbiter's — contestAutoResolution() is server-rejected for anyone
  // else (dispute.service.ts: `contestedBy !== trade.buyerId &&
  // contestedBy !== trade.sellerId` throws Forbidden) — see Trade.tsx's
  // own dispute section for where that button actually belongs.
  const reviewDecision = (row: Row) => {
    const option = selectableOption(decisionOptions(row.dispute, row.escrow?.type ?? null), choice)
    if (option) setPending({ row, ruling: option.ruling, viaSuggestion: option.value === 'SUGGESTION' })
  }

  const openCount = rows.filter((r) => r.dispute.status !== 'RESOLVED').length
  const signedOut = !authLoading && !user
  const ready = !signedOut && !error && !authLoading && !loading

  // Only arbiters see this section: hidden while loading and when the caseload is empty (every normal user).
  if (signedOut || authLoading || loading || (!error && rows.length === 0)) return null

  return (
    <section aria-labelledby="arbiter-cases-title" className="mt-8">
      <h2 id="arbiter-cases-title" className="text-section-title">{t('disputes.arbiter.title')}</h2>
      {ready && <p className="text-metadata mt-1 mb-3">{t('disputes.arbiter.openCount', { count: openCount })}</p>}
      {error ? (
        <StateBlock
          kind="error"
          className="mt-3"
          title={t('disputes.arbiter.errorTitle')}
          description={error}
          action={<Button variant="outline" onClick={load} className="min-h-9 touch:min-h-11 px-4">{t('trades.retry')}</Button>}
        />
      ) : (
        <Card className="overflow-hidden">
          <div aria-hidden="true" className={cn(TABLE_HEAD_ROW, 'hidden xl:grid gap-x-4', DISPUTE_COLS)}>
            <span>{t('disputes.col.trade')}</span>
            <span>{t('trades.col.amount')}</span>
            <span>{t('trades.col.status')}</span>
            <span>{t('disputes.col.openedBy')}</span>
            <span>{t('disputes.col.evidence')}</span>
            <span>{t('disputes.col.openedAt')}</span>
            <span />
          </div>
          <ul>
            {rows.map((row) => {
              const d = row.dispute
              const evidenceCount = parseEvidence(d.evidence).length
              return (
                // Below xl the same cells fold into a compact row: facts on the left, "Abrir caso" on the right.
                <li key={d.id} className={cn('grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-4 py-3 [&>*]:col-start-1 xl:[&>*]:col-start-auto', TABLE_ROW, DISPUTE_COLS)}>
                  <div className="min-w-0">
                    <span className="mono-id text-body-sm text-brand-text">#{shortId(d.tradeId)}</span>
                    {pendingSuggestion(d) && (
                      <p className="text-xs text-brand-text-muted flex items-center gap-1">
                        <Bot className="h-3.5 w-3.5" aria-hidden="true" /> {t('disputes.autoSuggestion')}
                      </p>
                    )}
                  </div>
                  <div className="text-sm text-brand-text min-w-0">
                    {row.escrow ? (
                      <>
                        <span className="tabular-nums font-medium">{amountText(row.escrow)}</span>
                        <span className="block text-xs text-brand-text-muted truncate">{ASSET_LABELS[row.escrow.asset] ?? row.escrow.asset}</span>
                      </>
                    ) : (
                      <span className="text-body-sm text-brand-text-secondary">{t('disputes.amountUnavailable')}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <DisputeStatusBadge status={d.status} />
                    {d.status === 'RESOLVED' && d.ruling && (
                      <p className="mt-0.5 text-xs text-brand-text-muted">{t('disputes.rulingLine', { decision: RULING_DECISION[d.ruling] })}</p>
                    )}
                  </div>
                  {/* One quiet line below xl; three columns from xl (contents). */}
                  <div className="flex flex-wrap gap-x-2 text-xs text-brand-text-muted xl:contents">
                    <span className="xl:text-body-sm xl:text-brand-text-secondary xl:truncate"><span className="xl:hidden">{t('disputes.col.openedBy')} </span>{personLabel(d.openedBy, row.escrow)}</span>
                    <span className="xl:text-body-sm xl:text-brand-text-secondary tabular-nums"><span aria-hidden="true" className="xl:hidden">· </span>{countLabel(evidenceCount)}</span>
                    <span className="tabular-nums"><span aria-hidden="true" className="xl:hidden">· </span>{formatDateTime(d.createdAt)}</span>
                  </div>
                  <Button
                    ref={(el) => {
                      if (el) openButtons.current.set(d.id, el)
                      else openButtons.current.delete(d.id)
                    }}
                    variant="outline"
                    size="sm"
                    onClick={() => openCase(d.id)}
                    aria-label={t('disputes.openCaseAria', { id: shortId(d.tradeId) })}
                    className="touch:min-h-11 !col-start-2 row-start-1 row-span-4 self-center justify-self-end xl:!col-start-auto xl:row-start-auto xl:row-span-1"
                  >
                    {t('disputes.openCase')}
                  </Button>
                </li>
              )
            })}
          </ul>
        </Card>
      )}

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent
          hideDefaultClose
          className="w-full sm:max-w-2xl p-0 gap-0 flex flex-col"
          onOpenAutoFocus={(e: Event) => {
            e.preventDefault()
            caseHeading.current?.focus()
          }}
          onCloseAutoFocus={(e: Event) => {
            e.preventDefault()
            if (openedFrom.current) openButtons.current.get(openedFrom.current)?.focus()
          }}
        >
          {selected && (
            <CaseFile
              row={selected}
              headingRef={caseHeading}
              personLabel={personLabel}
              choice={choice}
              onChoice={setChoice}
              onReview={() => reviewDecision(selected)}
              onRetry={load}
              acting={acting}
            />
          )}
        </SheetContent>
      </Sheet>

      {pending && (
        <ConfirmActionDialog
          open
          onOpenChange={(open) => !open && setPending(null)}
          title={t('disputes.confirm.title')}
          summary={[
            { label: t('disputes.col.trade'), value: `#${shortId(pending.row.dispute.tradeId)}` },
            { label: t('disputes.decision'), value: pending.viaSuggestion ? t('disputes.confirm.suggestionAccepted', { decision: RULING_DECISION[pending.ruling] }) : RULING_DECISION[pending.ruling] },
            { label: t('disputes.confirm.whoDecides'), value: t('disputes.confirm.you') },
            ...(pending.row.escrow?.type === 'MULTISIG' && signerText(pending.ruling)
              ? [{ label: t('disputes.confirm.pendingSignature'), value: t('disputes.confirm.pendingSignatureValue', { signer: signerText(pending.ruling)! }) }]
              : []),
            {
              label: t('disputes.escrowAmount'),
              value: pending.row.escrow
                ? t('disputes.confirm.amountWithAsset', { amount: amountText(pending.row.escrow), asset: ASSET_LABELS[pending.row.escrow.asset] ?? pending.row.escrow.asset })
                : t('disputes.unavailableNotLoaded'),
            },
          ]}
          consequence={t('disputes.confirm.consequence')}
          confirmLabel={t('disputes.confirm.confirm')}
          busy={acting}
          onConfirm={() => confirmRuling(pending.row, pending.ruling, pending.viaSuggestion)}
        />
      )}
    </section>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="px-4 sm:px-6 py-5 border-b border-brand-border-subtle">
      <h3 id={id} className="text-label mb-3">{title}</h3>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 py-1.5 text-sm">
      <dt className="text-brand-text-secondary">{label}</dt>
      <dd className="text-brand-text break-words">{children}</dd>
    </div>
  )
}

function CaseFile({
  row, headingRef, personLabel, choice, onChoice, onReview, onRetry, acting,
}: {
  row: Row
  headingRef: React.RefObject<HTMLHeadingElement | null>
  personLabel: (id: string | null, escrow: Escrow | null) => string
  choice: DecisionChoice | null
  onChoice: (c: DecisionChoice) => void
  onReview: () => void
  onRetry: () => void
  acting: boolean
}) {
  const { dispute: d, escrow } = row
  const evidence = parseEvidence(d.evidence)
  const options = decisionOptions(d, escrow?.type ?? null)
  const canDecide = options.length > 0 && !!escrow
  const suggestionPending = !!pendingSuggestion(d)
  const chosen = selectableOption(options, choice)
  const signer = escrow?.type === 'MULTISIG' && chosen ? signerText(chosen.ruling) : null

  return (
    <>
      <div className="flex items-start gap-3 px-4 sm:px-6 py-4 border-b border-brand-border-subtle">
        <div className="min-w-0 flex-1">
          <SheetTitle ref={headingRef} tabIndex={-1} className="text-section-title outline-none">
            {t('disputes.case.title', { id: shortId(d.tradeId) })}
          </SheetTitle>
          <SheetDescription className="text-sm text-brand-text-secondary mt-1">
            {t('disputes.case.description')}
          </SheetDescription>
        </div>
        <SheetClose className="h-11 w-11 -mr-2 -mt-1 shrink-0 flex items-center justify-center rounded-md text-brand-text-secondary hover:text-brand-text state-layer">
          <X className="h-5 w-5" aria-hidden="true" />
          <span className="sr-only">{t('disputes.case.close')}</span>
        </SheetClose>
      </div>

      <div className="flex-1 overflow-y-auto">
        <Section id="case-summary" title={t('disputes.case.summary')}>
          <dl>
            <Field label={t('disputes.col.trade')}><span className="font-mono">#{shortId(d.tradeId)}</span></Field>
            <Field label={t('disputes.escrowAmount')}>
              {escrow ? <><span className="money">{amountText(escrow)}</span> <span className="text-brand-text-secondary">· {ASSET_LABELS[escrow.asset] ?? escrow.asset}</span></> : t('disputes.unavailableNotLoaded')}
            </Field>
            <Field label={t('disputes.case.escrowStatus')}>{escrow ? ESCROW_STATUS_LABEL[escrow.status] ?? escrow.status : t('disputes.unavailable')}</Field>
            <Field label={t('disputes.case.disputeStatus')}>{DISPUTE_STATUS_LABEL[d.status] ?? d.status}</Field>
            <Field label={t('trades.role.buyer')}>{personLabel(partyIdFor('buyer', escrow), null)}</Field>
            <Field label={t('trades.role.seller')}>{personLabel(partyIdFor('seller', escrow), null)}</Field>
          </dl>
        </Section>

        <Section id="case-reason" title={t('disputes.case.reason')}>
          <p className="text-sm text-brand-text whitespace-pre-wrap break-words">{d.reason}</p>
          <dl className="mt-3">
            <Field label={t('disputes.col.openedBy')}>{personLabel(d.openedBy, escrow)}</Field>
            <Field label={t('disputes.col.openedAt')}>{formatDateTime(d.createdAt)}</Field>
          </dl>
        </Section>

        <Section id="case-evidence" title={t('disputes.case.evidenceTitle', { count: evidence.length })}>
          <p className="flex gap-2 text-sm text-brand-text-secondary">
            <Info className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
            {t('disputes.case.evidenceDisclaimer')}
          </p>
          {evidence.length === 0 ? (
            <p className="mt-3 text-sm text-brand-text-muted">{t('disputes.case.noEvidence')}</p>
          ) : (
            <ol className="mt-3 space-y-3">
              {evidence.map((e, i) => (
                <li key={i} className="border-l-2 border-brand-border pl-3">
                  <div className="text-sm font-medium text-brand-text">{EVIDENCE_TYPE_KEY[e.type] ? t(EVIDENCE_TYPE_KEY[e.type]) : e.type}</div>
                  <div className="text-metadata">
                    {personLabel(e.submittedBy, escrow)}{e.submittedAt && ` · ${formatDateTime(e.submittedAt)}`}
                  </div>
                  {e.note && <p className="mt-1 text-sm text-brand-text whitespace-pre-wrap break-words">{e.note}</p>}
                  {e.uri && (e.href ? (
                    <a href={e.href} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 inline-block text-sm text-brand-text underline underline-offset-2 break-all">
                      {e.uri}
                    </a>
                  ) : (
                    <p className="mt-1 text-sm text-brand-text-secondary break-all">{e.uri} <span className="text-brand-text-muted">{t('disputes.case.linkNotOpened')}</span></p>
                  ))}
                  {e.referenceId && <p className="mt-1 text-metadata break-all">{t('disputes.case.openProofRef', { id: e.referenceId })}</p>}
                </li>
              ))}
            </ol>
          )}
        </Section>

        {d.autoResolutionRecommendation && (
          <Section id="case-suggestion" title={t('disputes.autoSuggestion')}>
            <p className="text-sm text-brand-text-secondary">{t('disputes.case.suggestionNotDecision')}</p>
            <dl className="mt-2">
              <Field label={t('disputes.case.suggests')}>{RULING_DECISION[d.autoResolutionRecommendation]}</Field>
              {d.autoResolutionReasoning && <Field label={t('disputes.case.reasoning')}>{d.autoResolutionReasoning}</Field>}
              {suggestionPending && d.autoResolutionDeadline && (
                <Field label={t('disputes.case.deadline')}>{t('disputes.case.autoApplyAt', { date: formatDateTime(d.autoResolutionDeadline) })}</Field>
              )}
            </dl>
          </Section>
        )}

        {d.appealRound > 0 && (
          <Section id="case-appeal" title={t('disputes.case.appealRound')}>
            <dl>
              <Field label={t('disputes.case.round')}>#{d.appealRound}</Field>
              {d.previousRuling && <Field label={t('disputes.case.previousRuling')}>{RULING_DECISION[d.previousRuling]}</Field>}
            </dl>
          </Section>
        )}

        <section aria-labelledby="case-decision" className="px-4 sm:px-6 py-5">
          <h3 id="case-decision" className="text-label mb-3">{t('disputes.decision')}</h3>
          {d.status === 'RESOLVED' ? (
            <p className="text-sm text-brand-text">
              {d.ruling ? t('disputes.case.rulingRecorded', { decision: RULING_DECISION[d.ruling] }) : t('disputes.case.resolved')}
              {d.resolvedAt && ` · ${formatDateTime(d.resolvedAt)}`}
            </p>
          ) : !escrow ? (
            <div className="text-sm text-brand-text-secondary">
              {t('disputes.case.escrowNotLoaded')}
              <Button variant="outline" onClick={onRetry} className="mt-3 min-h-11 w-full sm:w-auto">{t('trades.retry')}</Button>
            </div>
          ) : (
            <>
              <RadioGroup legend={t('disputes.case.chooseDecision')} legendHidden listClassName="space-y-2">
                {options.map((o) => (
                  <RadioCard
                    key={o.value}
                    name={`ruling-${d.id}`}
                    value={o.value}
                    checked={!o.unavailableReason && choice === o.value}
                    disabled={!!o.unavailableReason}
                    aria-describedby={o.unavailableReason ? `ruling-${d.id}-${o.value}-why` : undefined}
                    onChange={() => onChoice(o.value)}
                  >
                    <span className="min-w-0 font-normal">
                      <span className={!o.unavailableReason && choice === o.value ? 'font-medium' : undefined}>{o.label}</span>
                      {o.detail && <span className="block text-brand-text-secondary">{o.detail}</span>}
                      {o.unavailableReason && <span id={`ruling-${d.id}-${o.value}-why`} className="block text-brand-text-secondary">{o.unavailableReason}</span>}
                    </span>
                  </RadioCard>
                ))}
              </RadioGroup>
              <div className="mt-4 space-y-1.5 text-sm text-brand-text-secondary">
                <p>{t('disputes.case.signedWithSessionKey')}</p>
                {/* multisig.provider.ts: on a DISPUTED release/refund the server signs with the arbiter key it derives (MULTISIG_SEED); requiredSigners is the buyer (release) or the seller (refund). */}
                {escrow.type === 'MULTISIG' && (
                  <p>
                    {t('disputes.case.multisigNote')}
                    {signer && ` ${t('disputes.case.multisigSigner', { signer })}`}
                  </p>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {canDecide && (
        <div className="border-t border-brand-border-subtle bg-background px-4 sm:px-6 py-3">
          <Button onClick={onReview} loading={acting} disabled={!chosen} className="min-h-11 w-full">
            {t('disputes.case.review')}
          </Button>
        </div>
      )}
    </>
  )
}
