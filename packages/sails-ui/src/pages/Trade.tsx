import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useNavigate, useLocation } from 'react-router'
import { toast } from '../components/ui/toast'
import type { Trade as SdkTrade, Escrow as SdkEscrow, EscrowPendingTransaction, WebSocketChannel, Dispute } from '@satsails/p2p-trading-sdk'
import { encryptChatMessage, SigningIntentVerificationError, SailsNotFoundError } from '@satsails/p2p-trading-sdk'
import type { EscrowStatus, Message, User } from '../types'
import { useAuth, WrongPassphraseError } from '../context/AuthContext'
import { useEscrowKey } from '../hooks/useEscrowKey'
import { classifySigningWatchError, classifyPendingTransactionError } from '../lib/escrowErrorClassification'
import { checkMultisigPending, MultisigSigningIntentError } from '../lib/multisigSigningIntent'
import { deriveSigningRequest, roundSnapshotChanged, signingActionLabel, unknownSignerLabel, type RoundSnapshot, type SigningVerification } from '../lib/signingRequest'
import { sailsClient } from '../lib/sailsClient'
import { toUiMessage, toUiMessageFromEvent } from '../lib/tradeMessages'
import { EscrowCountdown } from '../components/trade/EscrowCountdown'
import { CurrentActionCard } from '../components/trade/CurrentActionCard'
import { SigningRequestCard } from '../components/trade/SigningRequestCard'
import { TradeHeader } from '../components/trade/TradeHeader'
import { TradeAmountsStrip } from '../components/trade/TradeAmountsStrip'
import { TradeRail } from '../components/trade/TradeRail'
import { TradeSpecs, type SpecGroup, type SpecRow } from '../components/trade/TradeSpecs'
import { PaymentInstructions } from '../components/trade/PaymentInstructions'
import { PayoutAddressForm } from '../components/trade/PayoutAddressForm'
import { FundingInstructionCard } from '../components/trade/FundingInstructionCard'
import { deriveFundingInstruction, deriveFundingRecordRows, lockRefusalMessage } from '../lib/fundingInstruction'
import { batonLabel, custodyModelLabel, deriveTradeState, ESCROW_STATE_LABEL, payoutTxLabel } from '../lib/tradeState'
import { TradeParties } from '../components/trade/TradeParties'
import { TradeDisputePanel } from '../components/trade/TradeDisputePanel'
import { ChatWindow } from '../components/chat/ChatWindow'
import { AgentRiskCard } from '../components/agent/AgentRiskCard'
import { RateCounterpartyCard, type RateCounterpartyCopy } from '../components/trade/RateCounterpartyCard'
import { isAlreadyRatedError, readRated, saveRated, sessionStore, type RatedMemory, type RatingInput } from '../lib/rating'
import { errorMessage } from '../lib/errors'
import { Button, buttonVariants } from '../components/ui/button'
import { StateBlock } from '../components/ui/StateBlock'
import { cn } from '../lib/utils'
import { Textarea } from '../components/ui/textarea'
import { ConfirmActionDialog } from '../components/ui/ConfirmActionDialog'
import { Lock, Banknote, ArrowLeft, ChevronRight, MessageSquare } from 'lucide-react'
import { formatDateTime, formatUsdExact } from '../lib/format'
import { detectRiskLocally } from '../lib/socialEngineering'
import { ASSET_LABELS, ASSET_SHORT_LABELS, DISPUTE_RULING_LABEL, ESCROW_TYPE_LABEL, PAYMENT_METHOD_LABELS } from '../lib/labels'
import { AssetNetworkLabel } from '../components/ui/AssetIcon'
import { t } from '../i18n'
import { AsideResizer, useTradeAsideWidth } from '../components/trade/AsideResizer'

// Sails Core Implementation Program M8-R2 (Destination Authority
// Conformance, 2026-09-11, docs/DESTINATION_AUTHORITY_ARCHITECTURE.md) —
// this page used to select one of several hardcoded demo payout
// addresses here and pass it as the release destination. That was Model
// E (caller-supplied execution-time destination), the exact pattern that
// architecture document adversarially rejects: the seller (who triggers
// release) has no Destination Authority over the buyer's own funds.
// Removed entirely — handleReleaseFunds() below no longer supplies a
// toAddress at all; the server always resolves the buyer's own
// registered PayoutAddress (see the "Payout address" card further down,
// which lets the buyer register it via sailsClient.settlement.setPayoutAddress()).

// decryptIncoming/toUiMessage/toUiMessageFromEvent moved to
// lib/tradeMessages.ts (2026-08-11, codebase-quality pass) — pure
// transforms, no React state, no reason to live inside the page.
// AUTO_RULING_LABEL and the dispute-rendering block moved into
// components/trade/TradeDisputePanel.tsx the same day.

// Missão 11 Fase 9.3.5 — identity.get() was narrowed to PublicParticipant
// (INV-OP-10: no reputation stats/bookkeeping on a public identity
// lookup — docs/PROTOCOL_INVARIANTS.md). reputationScore/totalTrades/
// disputeCount now come from their own canonical, already-public source,
// reputation.get(), fetched alongside. totalVolumeBtc/createdAt have no
// public source anymore (identity.get() never re-adds them, and
// ReputationScore doesn't carry a BTC-volume figure — cumulativeFeesObserved
// is a fee total, not a volume one); placeholders below are safe because
// TradeParties.tsx's PartyRow never actually renders either field for a
// trade's buyer/seller — only displayName, the trust line's
// reputationScore/totalTrades/disputeCount, and verified matter there.
function toParticipantUser(
  p: Awaited<ReturnType<typeof sailsClient.identity.get>>,
  rep: Awaited<ReturnType<typeof sailsClient.reputation.get>>,
): User {
  return {
    id: p.id, publicKey: p.publicKey, displayName: p.displayName, peerId: p.peerId,
    // ReputationScore's real fields are `total`/`disputeRate`, not
    // `reputationScore`/`disputeCount` — the SDK type was wrong about
    // this since its first commit (fixed Missão 11 Fase 9.3.6, contract
    // integrity pass: packages/sails-sdk/src/types.ts now matches
    // reputation.service.ts's real getScore() response exactly). This
    // page's own local `User` type still wants a `disputeCount` count,
    // not a rate — recovered exactly from disputeRate * totalTrades,
    // the same arithmetic the server used to produce disputeRate in the
    // first place, not a compensation for a broken contract.
    reputationScore: rep.total, totalTrades: rep.totalTrades,
    disputeCount: Math.round(rep.disputeRate * rep.totalTrades),
    totalVolumeBtc: 0, verified: p.verified, createdAt: '',
  }
}

// Escrow types with a client-signed release/refund round (useEscrowKey.ts).
const CLIENT_SIGNING_ESCROW_TYPES = new Set(['MULTISIG', 'LIGHTNING_HODL', 'SAFE_GUARD_EVM'])
// Client-signing types this interface cannot sign (no verify-then-sign yet): never start a round for them.
const UNSIGNABLE_ESCROW_TYPES = new Set(['LIGHTNING_HODL', 'SAFE_GUARD_EVM'])
const TERMINAL_ESCROW_STATUSES = new Set(['COMPLETED', 'REFUNDED', 'SPLIT'])
const PENDING_POLL_MS = 15_000
const ROUND_KINDS = new Set<string>(['release', 'refund', 'split'])

// Chat system rows for escrow state changes this client observed (a WS frame
// refetch or the viewer's own action) — composed from refetched state, never
// counterparty text. Not persisted: a reload starts from the recorded state.
const systemText = (s: EscrowStatus): string | undefined =>
  s === 'PAYMENT_PENDING' ? t('trade.system.paymentPending', { state: ESCROW_STATE_LABEL.PAYMENT_PENDING })
    : s === 'DISPUTED' ? t('trade.system.disputed')
    : ESCROW_STATE_LABEL[s]

// What a confirmation dialog was opened for. The dialog renders from this
// snapshot and the confirm handler compares the re-read round against it.
type RoundDialog = { kind: 'sign' | 'cancel'; round: RoundSnapshot; escrowStatus: string; summary: { label: string; value: string }[] }

type PendingState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; tx: EscrowPendingTransaction }

// Read-only: is a signing round in flight for this escrow? Never signs.
async function readPending(e: SdkEscrow): Promise<PendingState> {
  if (!CLIENT_SIGNING_ESCROW_TYPES.has(e.type)) return { status: 'none' }
  try {
    return { status: 'ready', tx: await sailsClient.settlement.getPendingTransaction(e.id) }
  } catch (err) {
    if (classifyPendingTransactionError(err) === 'absence') return { status: 'none' }
    return { status: 'error' }
  }
}

function signingErrorMessage(err: unknown): string {
  if (err instanceof SigningIntentVerificationError) return t('trade.sign.mismatch')
  if (err instanceof MultisigSigningIntentError) return t('trade.sign.cannotCheck', { reason: err.userMessage })
  if (err instanceof WrongPassphraseError) return err.message
  // The server may store the signature before a later step fails, so never claim nothing was sent.
  return t('trade.sign.maybeRecorded')
}

async function fetchParticipantUser(participantId: string): Promise<User> {
  const [p, rep] = await Promise.all([
    sailsClient.identity.get(participantId),
    sailsClient.reputation.get(participantId),
  ])
  return toParticipantUser(p, rep)
}

export function Trade() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { user, keypair, encryptionKey } = useAuth()
  const { submitEscrowKeyIfNeeded, signVerifiedMultisigPending } = useEscrowKey(encryptionKey)
  // Counterparty rating (reputation.rate()). `rated` is remembered for this tab only (lib/rating.ts);
  // the server stays the judge ("already rated").
  const [rated, setRated] = useState<RatedMemory | null>(() => (id ? readRated(sessionStore(), id) : null))
  const [submittingRating, setSubmittingRating] = useState(false)
  const [ratingError, setRatingError] = useState<string | null>(null)
  useEffect(() => { setRated(id ? readRated(sessionStore(), id) : null); setRatingError(null) }, [id])

  // P3-F04 (Pre-M3 Reality Gate, 2026-09-13) — corrected. These two call
  // sites are speculative/idempotent background calls, and a genuine
  // "nothing to do" (useEscrowKey.ts's own SailsNotFoundError → null
  // path, P3-F03) correctly never reaches this catch at all. What
  // previously reached here — and was silently dropped, no toast, no
  // log, indistinguishable from "nothing to do" — included a session
  // that expired mid-trade (401), a wrong-actor rejection (403), a
  // network failure, a timeout, or a real server error. Absence ≠
  // Failure ≠ Unknown: only a genuine absence (already filtered out
  // before this function is ever called) may be silent; every other
  // outcome must be visible, even though none of these calls are
  // required for the page to keep rendering. `WrongPassphraseError`
  // keeps its own specific message; every other real error gets a
  // generic-but-honest one rather than none at all.
  // PRE-M3-REALITY-GATE-1-R1 (2026-09-13) — the actual instanceof
  // classification now lives in the pure, dependency-free
  // classifySigningWatchError() (lib/escrowErrorClassification.ts) so it
  // can be unit-tested directly (this page can't be rendered —
  // packages/sails-ui has no test runner configured, TD#62/#63). This
  // function still owns the toast text/side effect; the remaining toast
  // strings below are byte-for-byte unchanged from before that refactor.
  //
  // Mission 3 Slice 1 (2026-09-14, docs/PARTNER_WALLET_INTEGRATION_IDENTITY_CONTINUITY.md
  // §11/§15) — the 'session-expired' case that used to live here (a local
  // toast only, page stayed put with a now-dead session) is REMOVED, not
  // just silenced: AuthContext.tsx's new app-wide onSessionExpired
  // interceptor now reacts to the SAME underlying SailsAuthError with a
  // strictly better outcome (clears the stale session AND redirects to
  // /login with a real path back to this exact trade), superseding this
  // local toast rather than duplicating it. Every other case here is
  // UNCHANGED — SailsForbiddenError/WrongPassphraseError/unknown are not
  // session expiries and must keep their own distinct, local reactions.
  const ignoreExceptWrongPassphrase = (err: unknown) => {
    switch (classifySigningWatchError(err)) {
      case 'wrong-passphrase':
        toast.error((err as WrongPassphraseError).message)
        break
      case 'session-expired':
        break // handled globally — see this function's own comment above
      case 'forbidden':
        toast.error(t('trade.sign.forbidden'))
        break
      default:
        toast.error(t('trade.sign.keyRegisterFailed'))
    }
  }

  const [trade, setTrade] = useState<SdkTrade | null>(null)
  const [escrow, setEscrow] = useState<SdkEscrow | null>(null)
  const [buyer, setBuyer] = useState<User | null>(null)
  const [seller, setSeller] = useState<User | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<'notFound' | 'failed' | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [acting, setActing] = useState(false)
  const [confirmRelease, setConfirmRelease] = useState(false)
  // The other one-way steps with a confirmation (release has its own flag above).
  const [confirmStep, setConfirmStep] = useState<'markPaid' | 'contest' | 'appeal' | null>(null)
  const [pending, setPending] = useState<PendingState>({ status: 'none' })
  const [roundDialog, setRoundDialog] = useState<RoundDialog | null>(null)
  const [showDisputeForm, setShowDisputeForm] = useState(false)
  const aside = useTradeAsideWidth()
  const [disputeReason, setDisputeReason] = useState('')
  // RFC-021 D6/D7/D8 — evidence/contest/appeal are real, trade-party-only
  // actions (dispute.service.ts rejects anyone whose id isn't
  // trade.buyerId/sellerId with a real 403) — deliberately NOT offered on
  // Disputes.tsx's arbiter console, which has no standing to call them.
  // Shares `acting`/withGuard with the escrow actions below, not a
  // separate loading flag.
  const [evidenceNote, setEvidenceNote] = useState('')
  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 37, 2026-09-13) — one
  // idempotency key per genuinely-new evidence-submission intent, reused
  // across a manual retry of the SAME attempt (e.g. clicking "Enviar"
  // again after a network error), regenerated whenever the note text
  // itself changes. See `sailsClient.settlement.submitDisputeEvidence()`'s
  // own doc comment for the full contract this closes — submitEvidence()
  // had no idempotency at all before this mission (a retry could append
  // a duplicate evidence entry and re-trigger QVAC auto-resolution).
  const evidenceIdempotencyKeyRef = useRef<string>(crypto.randomUUID())
  useEffect(() => {
    evidenceIdempotencyKeyRef.current = crypto.randomUUID()
  }, [evidenceNote])
  // Opt-in per BACKLOG.md's own note on chat-encryption.ts — encrypting
  // by default would silently change behaviour for every existing
  // plaintext history, so this starts off and only the sender's own new
  // messages are affected.
  const [encryptionEnabled, setEncryptionEnabled] = useState(false)
  // Real presence (2026-08-02) — null until a USER_ONLINE/USER_OFFLINE
  // frame for the counterparty specifically has actually arrived over
  // this trade's chat WebSocketChannel (chat.routes.ts broadcasts these
  // on room join/leave/socket close) — see UserAvatar.tsx's own comment
  // on why null is a distinct "not yet observed" state, never guessed.
  const [counterpartyOnline, setCounterpartyOnline] = useState<boolean | null>(null)
  const channelRef = useRef<WebSocketChannel | null>(null)
  // M8-R2 (2026-09-11) — the buyer's own registered payout destination
  // for this trade's asset. null means "checked, none registered yet"
  // (getPayoutAddress() 404s — see this page's own fetch effect below),
  // distinct from undefined ("not checked yet"), the same non-guessed-
  // state discipline UserAvatar.tsx already uses for presence.
  const [payoutAddress, setPayoutAddress] = useState<{ address: string } | null | undefined>(undefined)
  const [payoutAddressInput, setPayoutAddressInput] = useState('')
  const [savingPayoutAddress, setSavingPayoutAddress] = useState(false)
  // A failed check (network, 5xx, ...) is not "no address": the address stays unknown.
  const [payoutCheckFailed, setPayoutCheckFailed] = useState(false)
  const [payoutCheckRun, setPayoutCheckRun] = useState(0)
  const [chatOpen, setChatOpen] = useState(false)
  const disputeTriggerRef = useRef<HTMLButtonElement>(null)
  const restoreDisputeFocusRef = useRef(false)
  // Last escrow status seen; undefined until the first load settles (that load is the baseline, not a change).
  const lastEscrowStatusRef = useRef<string | null | undefined>(undefined)

  // Real fetch — openp2p.getTrade() + identity.get() for both real
  // parties + settlement.get() for the real escrow (if one exists yet)
  // + real chat history. Independent of how the page was reached (a
  // fresh POST /v1/openp2p/trades navigation, a bookmark, or a refresh)
  // — no client-only mock construction left (buildTrade.ts, replaced).
  useEffect(() => {
    if (!id) return
    // getTrade() needs a session; a logged-out visitor gets the connect prompt below, not an error.
    if (!user) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setPending({ status: 'none' })
    lastEscrowStatusRef.current = undefined
    ;(async () => {
      let t: SdkTrade
      try {
        t = await sailsClient.openp2p.getTrade(id)
      } catch (err) {
        // A missing trade and a failed request are different situations; only the first is "não encontrado".
        if (!cancelled) setLoadError(err instanceof SailsNotFoundError ? 'notFound' : 'failed')
        return
      }
      if (cancelled) return
      setTrade(t)

      const [b, s] = await Promise.all([
        fetchParticipantUser(t.buyerId),
        fetchParticipantUser(t.sellerId),
      ])
      if (cancelled) return
      setBuyer(b)
      setSeller(s)

      if (t.escrowId) {
        const e = await sailsClient.settlement.get(t.escrowId)
        // Client-held-keys write path (MULTISIG/LIGHTNING_HODL only, see
        // useEscrowKey's own header comment) — submitting is idempotent
        // and requires an authenticated session, so only attempted for a
        // logged-in counterparty, not every visitor who opens this page.
        if (user && (user.id === t.buyerId || user.id === t.sellerId)) {
          await submitEscrowKeyIfNeeded(e.type, e.id).catch(ignoreExceptWrongPassphrase)
          // CTO 437 step 4 — never sign on page load. Only READ the
          // pending round; signing needs the user's explicit review in
          // SigningRequestCard + ConfirmActionDialog.
          const ps = await readPending(e)
          if (!cancelled) setPending(ps)
        }
        if (!cancelled) setEscrow(e)
      }

      if (user) {
        // b/s (just-fetched) rather than the `buyer`/`seller` state, which
        // hasn't re-rendered yet at this point in the same async run.
        const counterpartyPublicKeyHex = user.id === t.buyerId ? s.publicKey : user.id === t.sellerId ? b.publicKey : undefined
        const counterpartyId = user.id === t.buyerId ? t.sellerId : t.buyerId
        setCounterpartyOnline(null) // unknown again on every new trade/channel

        // getMessages() returns PaginatedMessages now (chat pagination,
        // landed concurrently on the backend/SDK side) — was a bare
        // Message[] when this call was first written. 100 is the real
        // route's own max (chat.routes.ts), requested explicitly rather
        // than falling back to its default 50 for a trade's full history.
        const history = await sailsClient.openp2p.getMessages(t.id, { limit: 100 }).catch(() => null)
        if (!cancelled) setMessages((history?.items ?? []).map((m) => toUiMessage(m, b, s, keypair, counterpartyPublicKeyHex)))

        // Real WS chat (RFC-004/API_REFERENCE.md §5) — live NEW_MESSAGE
        // frames appended as they arrive, same channel used to send.
        const channel = sailsClient.openp2p.chat(t.id)
        channel.onMessage((m) => setMessages((prev) => [...prev, toUiMessageFromEvent(m, b, s, keypair, counterpartyPublicKeyHex)]))
        // Live sync (Lote B): a status frame only triggers a read-only refetch
        // of the trade, its escrow and the pending round; the frame payload
        // itself is never trusted as state.
        const refetch = async () => {
          const fresh = await sailsClient.openp2p.getTrade(t.id).catch(() => null)
          if (cancelled || !fresh) return
          setTrade(fresh)
          if (!fresh.escrowId) return
          const e = await sailsClient.settlement.get(fresh.escrowId).catch(() => null)
          if (cancelled || !e) return
          setEscrow(e)
          if (user.id === fresh.buyerId || user.id === fresh.sellerId) {
            const ps = await readPending(e)
            if (!cancelled && ps.status !== 'error') setPending(ps)
          }
        }
        // Real presence — USER_ONLINE/USER_OFFLINE for the counterparty.
        channel.onEvent((frame) => {
          if (frame.type === 'TRADE_STATUS_UPDATE' || frame.type === 'ESCROW_STATUS_UPDATE') {
            void refetch()
            return
          }
          if (frame.type !== 'USER_ONLINE' && frame.type !== 'USER_OFFLINE') return
          const payload = frame.payload as { participantId?: string }
          if (payload.participantId !== counterpartyId) return
          setCounterpartyOnline(frame.type === 'USER_ONLINE')
        })
        channelRef.current = channel
      }
    })()
      .catch(() => { if (!cancelled) setLoadError('failed') })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => {
      cancelled = true
      channelRef.current?.close()
      channelRef.current = null
    }
  }, [id, user, keypair, reloadKey])

  useEffect(() => {
    if (loading) return
    const cur = escrow?.status ?? null
    const prev = lastEscrowStatusRef.current
    lastEscrowStatusRef.current = cur
    if (prev === undefined || prev === cur || !cur) return
    setMessages((m) => [...m, {
      id: `system-${cur}-${Date.now()}`, senderId: null, sender: null, type: 'SYSTEM',
      content: systemText(cur as EscrowStatus) ?? cur, createdAt: new Date().toISOString(),
    }])
  }, [escrow?.status, loading])

  const isBuyer = !!user && !!trade && user.id === trade.buyerId
  const isSeller = !!user && !!trade && user.id === trade.sellerId
  // Only valid once buyer/seller state has settled from the fetch effect
  // above — fine here, since handleSend can't fire before this page has
  // finished loading and rendered a real chat compose box.
  const counterpartyPublicKeyHex = isBuyer ? seller?.publicKey : isSeller ? buyer?.publicKey : undefined
  const counterpartyName = isBuyer ? seller?.displayName : isSeller ? buyer?.displayName : undefined

  const pendingTx = pending.status === 'ready' ? pending.tx : null
  // MULTISIG: verified against the trade terms before any sign button is
  // shown. Other client-signing types have no verification -> never signable here.
  const verification = useMemo<SigningVerification>(() => {
    if (!pendingTx || !escrow || escrow.type !== 'MULTISIG') return { status: 'unsupported' }
    try {
      return checkMultisigPending(escrow, pendingTx)
    } catch {
      return { status: 'cannotVerify', reason: t('trade.sign.cannotRead') }
    }
  }, [escrow, pendingTx])
  const signingView = useMemo(() => pendingTx && trade && escrow ? deriveSigningRequest({
    pending: pendingTx,
    viewerId: user?.id,
    verification,
    // The viewer keeps their role: "Você (vendedor)".
    signerLabel: (pid) => pid === user?.id ? t(isBuyer ? 'trade.parties.youBuyer' : isSeller ? 'trade.parties.youSeller' : 'trade.parties.you') : pid === trade.buyerId ? t('escrow.actor.buyer') : pid === trade.sellerId ? t('escrow.actor.seller') : unknownSignerLabel(),
    disputed: escrow.status === 'DISPUTED',
    // Mirrors cancelPendingTransaction's server preconditions (seller, MULTISIG, non-disputed, non-terminal).
    canCancel: isSeller && escrow.type === 'MULTISIG' && escrow.status !== 'DISPUTED' && !TERMINAL_ESCROW_STATUSES.has(escrow.status),
    protocolFeeAddress: escrow.snapshotFeeCollectionAddress,
  }) : null, [pendingTx, trade, escrow, user, isSeller, verification])

  const refreshPending = async (e: SdkEscrow) => {
    const next = await readPending(e)
    setPending(next)
    return next
  }

  // Light poll so a counterparty sees a new or updated round without reloading:
  // only for trade parties of client-signing escrows, while a round exists or
  // one can start (PAYMENT_PENDING), and only while the tab is visible.
  const pollEnabled = !!escrow && (isBuyer || isSeller) && CLIENT_SIGNING_ESCROW_TYPES.has(escrow.type)
    && (pending.status === 'ready' || escrow.status === 'PAYMENT_PENDING')
  useEffect(() => {
    if (!pollEnabled || !escrow || acting || roundDialog) return // paused while a confirmation dialog is open
    let cancelled = false
    const hadRound = pending.status === 'ready'
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return
      const next = await readPending(escrow)
      if (cancelled || next.status === 'error') return // a failed background read keeps the last state; "Atualizar" reports errors
      setPending(next)
      if (hadRound && next.status === 'none') {
        const e = await sailsClient.settlement.get(escrow.id).catch(() => null)
        if (!cancelled && e) setEscrow(e)
      }
    }, PENDING_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [pollEnabled, escrow, acting, pending.status, roundDialog])

  // A refresh replaced the round under an open dialog: close it rather than confirm a different round.
  useEffect(() => {
    if (!roundDialog || acting || !roundSnapshotChanged(roundDialog.round, pendingTx)) return
    setRoundDialog(null)
    toast.error(t('trade.toast.stateChanged'))
  }, [roundDialog, acting, pendingTx])

  const openRoundDialog = (kind: RoundDialog['kind']) => {
    if (!pendingTx || !signingView || !escrow) return
    const progress = { label: t('trade.confirm.signatures'), value: signingView.progress.text }
    const status = { label: t('trade.confirm.currentState'), value: ESCROW_STATE_LABEL[escrow.status as EscrowStatus] ?? escrow.status }
    setRoundDialog({
      kind,
      round: { id: pendingTx.id, unsignedPsbtBase64: pendingTx.unsignedPsbtBase64 },
      escrowStatus: escrow.status,
      summary: kind === 'sign'
        ? [
            { label: t('trade.confirm.action'), value: signingActionLabel(pendingTx.kind) },
            // Full money flow from the verified transaction: each output and the network fee (labels are unique).
            ...(signingView.check?.items ?? []).map((it) => ({ label: it.label, value: it.value })),
            { label: t('trade.confirm.check'), value: signingView.check?.title ?? '' },
            progress,
            status,
          ]
        : [{ label: t('trade.confirm.round'), value: signingActionLabel(pendingTx.kind) }, progress, status],
    })
  }

  // M8-R2 — only the buyer needs to see/manage this (they're the
  // beneficiary of a release for this trade); re-checked whenever the
  // trade's asset or the logged-in user changes. A 404 (no PayoutAddress
  // registered for this participant/asset yet) is the normal, expected
  // "not registered" state, not an error to surface. Any other failure
  // leaves it unknown and is reported with a retry.
  useEffect(() => {
    if (!isBuyer || !user || !trade) return
    let cancelled = false
    setPayoutCheckFailed(false)
    sailsClient.settlement.getPayoutAddress(user.id, trade.asset)
      .then((view) => { if (!cancelled) setPayoutAddress({ address: view.address }) })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof SailsNotFoundError) {
          setPayoutAddress(null)
        } else {
          setPayoutAddress(undefined)
          setPayoutCheckFailed(true)
        }
      })
    return () => { cancelled = true }
  }, [isBuyer, user, trade?.id, trade?.asset, payoutCheckRun])

  const handleSetPayoutAddress = async () => {
    if (!trade || !payoutAddressInput.trim()) return
    setSavingPayoutAddress(true)
    try {
      const record = await sailsClient.settlement.setPayoutAddress({ asset: trade.asset, address: payoutAddressInput.trim() })
      setPayoutAddress({ address: record.address })
      setPayoutAddressInput('')
      toast.success(t('trade.payout.saved'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('trade.payout.saveFailed'))
    } finally {
      setSavingPayoutAddress(false)
    }
  }

  const withGuard = async (fn: () => Promise<void>) => {
    setActing(true)
    try {
      await fn()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('trade.toast.actionFailed'))
    } finally {
      setActing(false)
    }
  }

  const handleCreateEscrow = () => trade && withGuard(async () => {
    const e = await sailsClient.settlement.create({ tradeId: trade.id, lockedAmount: trade.amount, asset: trade.asset })
    setEscrow(e)
    toast.success(t('trade.toast.escrowCreated'))
  })

  const handleLockFunds = () => escrow && withGuard(async () => {
    let e: SdkEscrow
    try {
      e = await sailsClient.settlement.lock(escrow.id)
    } catch (err) {
      const refusal = lockRefusalMessage(err)
      if (!refusal) throw err
      toast.error(refusal)
      return
    }
    setEscrow(e)
    toast.info(t('trade.toast.escrowLocked'), { icon: <Lock aria-hidden="true" className="size-icon shrink-0 text-brand-inverse-info" /> })
  })

  const handleMarkPaymentSent = () => escrow && withGuard(async () => {
    // The confirmation may be stale: mark only if the escrow still records the funds as locked and this viewer is the buyer.
    const fresh = await sailsClient.settlement.get(escrow.id)
    if (fresh.status !== 'FUNDS_LOCKED' || !user || user.id !== trade?.buyerId) {
      setEscrow(fresh)
      toast.error(t('trade.toast.stateChanged'))
      return
    }
    const e = await sailsClient.settlement.markPaymentSent(escrow.id)
    setEscrow(e)
    toast.info(t('trade.toast.paymentMarkedSent'), { icon: <Banknote aria-hidden="true" className="size-icon shrink-0 text-brand-inverse-info" /> })
  })

  // Explicit, user-confirmed signing (MULTISIG only). Re-reads the round
  // and the escrow first; aborts if anything changed since the review.
  const handleSignPending = (snap: RoundDialog) => escrow && user && withGuard(async () => {
    if (!encryptionKey) {
      toast.error(t('trade.sign.keyLocked'))
      return
    }
    const [freshEscrow, fresh] = await Promise.all([sailsClient.settlement.get(escrow.id), readPending(escrow)])
    const freshTx = fresh.status === 'ready' ? fresh.tx : null
    // Compared against the round the user reviewed (the snapshot), never the live state.
    const changed = !freshTx || roundSnapshotChanged(snap.round, freshTx) || freshEscrow.status !== snap.escrowStatus
      || !freshTx.requiredSigners.includes(user.id)
      || (freshTx.signedBy ?? []).some((x) => x.participantId === user.id)
    if (changed || !freshTx) {
      setRoundDialog(null)
      setEscrow(freshEscrow)
      setPending(fresh)
      toast.error(t('trade.toast.stateChanged'))
      return
    }
    let signedOk = false
    try {
      await signVerifiedMultisigPending(freshEscrow, freshTx)
      signedOk = true
    } catch (err) {
      toast.error(signingErrorMessage(err))
    }
    setRoundDialog(null) // before the refresh: the round may legitimately change now
    const e = await sailsClient.settlement.get(escrow.id).catch(() => freshEscrow)
    setEscrow(e)
    await refreshPending(e)
    if (signedOk) toast.success(t('trade.toast.signatureRecorded'))
  })

  const handleRefreshSigning = () => escrow && withGuard(async () => {
    const e = await sailsClient.settlement.get(escrow.id)
    setEscrow(e)
    const next = await refreshPending(e)
    if (next.status === 'error') toast.error(t('trade.sign.pendingReadFailed'))
  })

  // Seller-only: retire a round this interface cannot sign (cancelPendingTransaction).
  // Re-reads first; aborts if the round or the escrow changed since it was shown.
  const handleCancelRound = (snap: RoundDialog) => escrow && user && withGuard(async () => {
    const [freshEscrow, fresh] = await Promise.all([sailsClient.settlement.get(escrow.id), readPending(escrow)])
    const freshTx = fresh.status === 'ready' ? fresh.tx : null
    const signedCount = freshTx ? freshTx.requiredSigners.filter((id) => (freshTx.signedBy ?? []).some((x) => x.participantId === id)).length : 0
    if (!freshTx || roundSnapshotChanged(snap.round, freshTx) || freshEscrow.status !== snap.escrowStatus || freshEscrow.status === 'DISPUTED'
      || TERMINAL_ESCROW_STATUSES.has(freshEscrow.status) || signedCount >= freshTx.requiredSigners.length || user.id !== trade?.sellerId) {
      setRoundDialog(null)
      setEscrow(freshEscrow)
      setPending(fresh)
      toast.error(t('trade.toast.stateChanged'))
      return
    }
    const result = await sailsClient.settlement.cancelPendingTransaction(escrow.id, freshTx.id)
    setRoundDialog(null)
    const e = await sailsClient.settlement.get(escrow.id).catch(() => freshEscrow)
    setEscrow(e)
    await refreshPending(e)
    toast.info(t(result.outcome === 'CANCELLED' ? 'trade.toast.roundCancelled' : 'trade.toast.roundGone'))
  })

  const handleReleaseFunds = () => escrow && withGuard(async () => {
    // The confirmation dialog may be stale: re-read the escrow and release
    // only if it is still PAYMENT_PENDING and this viewer is still the seller.
    const fresh = await sailsClient.settlement.get(escrow.id)
    if (fresh.status !== 'PAYMENT_PENDING' || !user || user.id !== trade?.sellerId) {
      setEscrow(fresh)
      toast.error(t('trade.toast.stateChanged'))
      return
    }
    // MULTISIG, LIGHTNING_HODL and SAFE_GUARD_EVM release through a client-
    // signed round (initiateRelease(), never the plain release() below).
    // CTO 437 step 4: this page never signs on its own — each required
    // signer reviews and signs from SigningRequestCard. Only MULTISIG has a
    // verify-then-sign path, so a round is never started for LIGHTNING_HODL /
    // SAFE_GUARD_EVM: it could not be signed here and would block retries.
    if (UNSIGNABLE_ESCROW_TYPES.has(escrow.type)) {
      toast.error(t('trade.toast.releaseUnavailable'))
      return
    }
    if (escrow.type === 'MULTISIG') {
      // No toAddress passed — the server resolves the buyer's own
      // registered PayoutAddress (M8-R2, see this file's own header
      // comment above). If the buyer hasn't registered one yet, this
      // throws a clear error caught by withGuard() below, surfaced as a
      // toast — never a silent/guessed destination.
      await sailsClient.settlement.initiateRelease(escrow.id)
      // No signing here: the round is only read; the seller reviews and
      // signs it from SigningRequestCard.
      const e = await sailsClient.settlement.get(escrow.id)
      setEscrow(e)
      const next = await refreshPending(e)
      // Reports the escrow status the server returned, not on-chain finality
      // (no broadcast/confirmation state is exposed to this UI yet).
      const missing = next.status === 'ready' ? next.tx.requiredSigners.filter((id) => !(next.tx.signedBy ?? []).some((x) => x.participantId === id)) : []
      toast.info(
        t(e.status === 'COMPLETED' ? 'trade.toast.escrowCompleted'
          : missing.includes(user.id) ? 'trade.toast.releaseStartedSign'
          : missing.length === 1 && missing[0] === trade?.buyerId ? 'trade.toast.releaseStartedBuyer'
          : 'trade.toast.releaseStartedSignatures')
      )
      return
    }
    const e = await sailsClient.settlement.release(escrow.id)
    setEscrow(e)
    toast.info(t(e.status === 'COMPLETED' ? 'trade.toast.escrowCompleted' : 'trade.toast.releaseRequested'))
  })

  // Cancel returns focus to the "Abrir disputa" trigger (re-mounted with the action card).
  const cancelDisputeForm = () => {
    restoreDisputeFocusRef.current = true
    setShowDisputeForm(false)
  }
  useEffect(() => {
    if (showDisputeForm || !restoreDisputeFocusRef.current) return
    restoreDisputeFocusRef.current = false
    disputeTriggerRef.current?.focus()
  }, [showDisputeForm])

  const handleOpenDispute = () => escrow && withGuard(async () => {
    if (!disputeReason.trim()) {
      toast.error(t('trade.disputeForm.describeReason'))
      return
    }
    await sailsClient.settlement.dispute(escrow.id, disputeReason.trim())
    const refreshed = await sailsClient.settlement.get(escrow.id)
    setEscrow(refreshed)
    toast.error(t('trade.toast.disputeOpened'))
    setShowDisputeForm(false)
    setDisputeReason('')
  })

  // dispute.service.ts's submitEvidence()/contestAutoResolution()/appeal()
  // each return the updated Dispute row directly — patched into
  // escrow.disputes in place rather than a full settlement.get() refetch,
  // since escrow.status itself doesn't change from any of these three calls.
  const patchDispute = (updated: Dispute) => {
    setEscrow((prev) => (prev ? { ...prev, disputes: [updated] } : prev))
  }

  const handleSubmitEvidence = () => dispute && withGuard(async () => {
    if (!evidenceNote.trim()) {
      toast.error(t('trade.toast.evidenceEmpty'))
      return
    }
    const updated = await sailsClient.settlement.submitDisputeEvidence(
      dispute.id, { type: 'text', note: evidenceNote.trim() }, evidenceIdempotencyKeyRef.current
    )
    evidenceIdempotencyKeyRef.current = crypto.randomUUID() // this attempt is now settled — a new key for the next one
    patchDispute(updated)
    setEvidenceNote('')
    toast.success(t('trade.toast.evidenceSent'))
  })

  // Re-reads the dispute before a confirmed step: proceeds only if it is still the one the user reviewed, in the expected status.
  const freshDisputeStill = async (expected: Dispute['status']) => {
    if (!escrow || !dispute) return false
    const fresh = await sailsClient.settlement.get(escrow.id)
    const d = fresh.disputes?.[0]
    if (d && d.id === dispute.id && d.status === expected && d.appealRound === dispute.appealRound) return true
    setEscrow(fresh)
    toast.error(t('trade.toast.stateChanged'))
    return false
  }

  const handleContestAutoResolution = () => dispute && withGuard(async () => {
    if (!(await freshDisputeStill('AUTO_PROPOSED'))) return
    const updated = await sailsClient.settlement.contestAutoResolution(dispute.id)
    patchDispute(updated)
    toast(t('trade.toast.contested'))
  })

  const handleAppeal = () => dispute && withGuard(async () => {
    if (!(await freshDisputeStill('RESOLVED'))) return
    // appealFeeRequired is never printed: the contract gives it no unit (REVIEW LW-11).
    const { dispute: updated } = await sailsClient.settlement.appealDispute(dispute.id)
    patchDispute(updated)
    toast.success(t('trade.toast.appealed'))
  })

  const handleSend = (content: string) => {
    if (encryptionEnabled && keypair && counterpartyPublicKeyHex) {
      const encrypted = encryptChatMessage(content, counterpartyPublicKeyHex, keypair)
      channelRef.current?.send({ content: JSON.stringify(encrypted), msgType: 'ENCRYPTED_TEXT' })
    } else {
      channelRef.current?.send({ content, msgType: 'TEXT' })
    }
    // Risk detection always runs on the plaintext the user actually typed —
    // unaffected by whether the outgoing wire content ends up encrypted.
    // Mocked reflection of RFC-017's SocialEngineeringAgent — see
    // lib/socialEngineering.ts's own comment for what's real vs simulated.
    // Client-local only, never sent over the real chat channel.
    const warning = detectRiskLocally(content)
    if (warning) {
      setTimeout(() => {
        setMessages((m) => [
          ...m,
          {
            id: `risk-${Date.now()}`, senderId: null, sender: null,
            content: warning.reasoning, type: 'RISK_WARNING', riskPattern: warning.pattern,
            createdAt: new Date().toISOString(),
          },
        ])
      }, 600)
    }
  }

  if (loading) {
    return <StateBlock kind="loading" title={t('trade.page.loading')} />
  }

  // Real gap found live (2026-08-15): getTrade() requires an authenticated
  // session server-side (a trade's details are private to its two
  // parties), so a session lost to a reload (AuthContext.tsx's own "no
  // silent re-authenticate-on-mount" since 2026-08-11) always fails this
  // fetch — `trade` never sets, and the `!trade` branch below used to
  // catch this too, showing the misleading "Trade não encontrado" (this
  // trade may well exist; the visitor just isn't authenticated to see it)
  // with no way to actually reconnect. Checked before that branch so the
  // real cause gets the real fix: OfferDetail.tsx's handleStartTrade()
  // already has this exact affordance (redirect to /login carrying a
  // return path in location.state; Login.tsx's own handleConnect() reads
  // it back) — this mirrors that same established pattern.
  if (!user) {
    return (
      <StateBlock
        kind="signedOut"
        title={t('trade.page.signedOutTitle')}
        description={t('trade.page.signedOutDescription')}
        action={<Button variant="secondary" onClick={() => navigate('/login', { state: { from: location.pathname } })} className="min-h-10 touch:min-h-11 px-4">{t('trade.page.connect')}</Button>}
      />
    )
  }

  if (loadError === 'failed') {
    return (
      <StateBlock
        kind="error"
        title={t('trade.page.loadFailed')}
        description={t('trade.page.loadFailedDescription')}
        action={<Button variant="outline" onClick={() => setReloadKey((k) => k + 1)} className="min-h-9 touch:min-h-11 px-4">{t('trade.page.retry')}</Button>}
      />
    )
  }

  if (!trade || !buyer || !seller) {
    return (
      <StateBlock
        kind="empty"
        title={t('trade.page.notFound')}
        action={<Link to="/" className={cn(buttonVariants({ className: 'min-h-10 touch:min-h-11 px-4' }))}>{t('trade.page.backToMarket')}</Link>}
      />
    )
  }

  const escrowStatus: EscrowStatus = (escrow?.status as EscrowStatus) ?? 'CREATED'
  // Escrow.disputes (2026-08-03, see that field's own doc comment) — at
  // most one entry in practice (Dispute.@@unique([tradeId])), but a real
  // Prisma include shape, so this stays an array server-side.
  const dispute = escrow?.disputes?.[0] ?? null

  // One derivation for the rail (stages, status line, bastão), the action card and the payment gating.
  const state = deriveTradeState({
    tradeStatus: trade.status,
    escrowStatus: (escrow?.status as EscrowStatus | undefined) ?? null,
    escrowExpiresAt: escrow?.expiresAt ?? null,
    signingRoundKind: !pendingTx ? null : ROUND_KINDS.has(pendingTx.kind) ? pendingTx.kind : 'unknown',
    isBuyer,
    isSeller,
    releaseUnavailable: !!escrow && UNSIGNABLE_ESCROW_TYPES.has(escrow.type),
    appealAvailable: dispute?.status === 'RESOLVED' && (isBuyer || isSeller),
    payoutAddressMissing: payoutAddress === null,
    payoutAddressCheckFailed: payoutCheckFailed,
    createdAt: trade.createdAt,
    escrowCreatedAt: escrow?.createdAt,
    lockedAt: escrow?.lockedAt,
    // The trade is not refetched after the viewer's own release; the escrow carries releasedAt.
    completedAt: trade.completedAt ?? escrow?.releasedAt,
    cancelledAt: trade.cancelledAt,
    // Rail: stages and the bastão from the same records.
    buyerId: trade.buyerId,
    sellerId: trade.sellerId,
    escrowId: escrow?.id ?? null,
    escrowType: escrow?.type ?? null,
    txLockId: escrow?.txLockId ?? null,
    txLockVout: escrow?.txLockVout ?? null,
    txReleaseId: escrow?.txReleaseId ?? null,
    round: pendingTx,
    // This interface cannot sign the round for anyone: not verified (MULTISIG_SIGNING_HOLD, mismatch, unsupported type) or disputed.
    signingUnavailable: !!pendingTx && (verification.status !== 'verified' || escrow?.status === 'DISPUTED' || signingView?.state === 'blocked'),
    dispute: dispute ? { status: dispute.status, arbiterId: dispute.arbiterId, autoResolutionDeadline: dispute.autoResolutionDeadline } : null,
  })

  const short = ASSET_SHORT_LABELS[trade.asset]
  const methodLabel = trade.offer ? PAYMENT_METHOD_LABELS[trade.offer.paymentMethod] : null
  const fallbackName = t('trade.header.counterpartyFallback')
  const title = isBuyer ? t('trade.header.buying', { amount: trade.amount, asset: short, name: seller.displayName ?? fallbackName })
    : isSeller ? t('trade.header.selling', { amount: trade.amount, asset: short, name: buyer.displayName ?? fallbackName })
    : t('trade.header.observer', { amount: trade.amount, asset: short })
  const totalLabel = formatUsdExact(trade.totalUsd)
  const totalSub = `${t('trade.amounts.tradeValueUsd')}${methodLabel ? ` · ${methodLabel}` : ''}`
  const partyLabel = (pid: string) => t(pid === user.id ? 'trade.parties.you' : pid === trade.buyerId ? 'trade.parties.buyer' : pid === trade.sellerId ? 'trade.parties.seller'
    : pid === dispute?.arbiterId ? 'trade.parties.arbitrator' : 'trade.parties.unknown')

  // custodyModel is only on getEscrow() reads (absent after a create/lock response): no row then, never a guess.
  const custodyRow: SpecRow[] = escrow && escrow.custodyModel !== undefined
    ? [{ label: t('trade.record.custodyModel'), value: custodyModelLabel(escrow.custodyModel) }]
    : []
  // Registro: the recorded details grouped by the stage that produced them (rail = index, Registro = full values).
  const registro: SpecGroup[] = [
    { title: t('trade.record.groupTrade'), rows: [
      { label: t('trade.record.tradeId'), value: trade.id, mono: true, copy: trade.id },
      { label: t('trade.record.openedAt'), value: formatDateTime(trade.createdAt) },
      { label: t('trade.record.asset'), value: ASSET_LABELS[trade.asset] },
      { label: t('trade.record.quantity'), value: `${trade.amount} ${short}` },
      { label: t('trade.record.unitPriceUsd'), value: formatUsdExact(trade.priceUsd) },
      { label: t('trade.record.tradeValueUsd'), value: totalLabel },
      { label: t('trade.record.paymentMethod'), value: methodLabel ?? t('trade.record.notInformed') },
    ] },
    { title: t('trade.record.groupEscrow'), rows: escrow ? [
      { label: t('trade.record.escrowId'), value: escrow.id, mono: true, copy: escrow.id },
      { label: t('trade.record.escrowType'), value: ESCROW_TYPE_LABEL[escrow.type] ?? escrow.type },
      ...custodyRow,
      { label: t('trade.record.escrowState'), value: ESCROW_STATE_LABEL[escrowStatus] ?? escrow.status },
      ...(escrow.lockedAt ? [{ label: t('trade.record.lockedAt'), value: formatDateTime(escrow.lockedAt) }] : []),
      { label: t('trade.record.escrowUpdatedAt'), value: formatDateTime(escrow.updatedAt) },
    ] : [{ label: t('trade.record.escrow'), value: t('trade.record.escrowNotCreated') }] },
    { title: t('trade.record.groupDeposit'), rows: escrow ? deriveFundingRecordRows(escrow) : [] },
    { title: t('trade.record.groupSignatures'), rows: pendingTx && signingView ? [
      { label: t('trade.record.round'), value: signingActionLabel(pendingTx.kind) },
      ...signingView.signers.map((sg) => ({ label: sg.label, value: sg.at ? t('trade.record.signedAt', { date: formatDateTime(sg.at) }) : sg.statusText })),
    ] : [] },
    // Recorded by the server; no broadcast or confirmation state is exposed, so never "confirmada".
    { title: t('trade.record.groupTransaction'), rows: escrow?.txReleaseId ? [{ label: payoutTxLabel(), value: escrow.txReleaseId, mono: true, copy: escrow.txReleaseId }] : [] },
    { title: t('trade.record.groupClosing'), rows: [
      ...(trade.completedAt ? [{ label: t('trade.record.completedAt'), value: formatDateTime(trade.completedAt) }] : []),
      ...(trade.cancelledAt ? [{ label: t('trade.record.cancelledAt'), value: formatDateTime(trade.cancelledAt) }] : []),
    ] },
    { title: t('trade.record.groupPayout'), rows: isBuyer && payoutAddress ? [{ label: t('trade.record.payoutAddress'), value: payoutAddress.address, mono: true, copy: payoutAddress.address }] : [] },
  ]

  const fundingView = escrow ? deriveFundingInstruction({ escrow, isBuyer, isSeller, assetLabel: ASSET_SHORT_LABELS[escrow.asset] }) : null

  const payoutForm = (hasAddress: boolean) => (
    <PayoutAddressForm
      value={payoutAddressInput}
      onChange={setPayoutAddressInput}
      onSubmit={handleSetPayoutAddress}
      saving={savingPayoutAddress}
      hasAddress={hasAddress}
      assetLabel={ASSET_LABELS[trade.asset]}
    />
  )
  const priceItem = { label: t('trade.amounts.price'), value: `${formatUsdExact(trade.priceUsd)} / ${short}`, sub: t('trade.amounts.unitPrice') }
  const actionCardShown = !(escrowStatus === 'DISPUTED' && dispute) && !showDisputeForm
  const paymentInstructions = (isBuyer || isSeller) && trade.offer ? (
    // paymentMethod/paymentDetails come from the originating Offer
    // (getTrade() includes it so a buyer mid-trade can still see them).
    // They are the seller's receiving details only when the seller
    // published the offer; on a BUY offer they belong to the buyer.
    <PaymentInstructions
      embedded={actionCardShown && state.instructions === 'active'}
      viewer={isBuyer ? 'buyer' : 'seller'}
      visibility={state.instructions}
      methodLabel={PAYMENT_METHOD_LABELS[trade.offer.paymentMethod]}
      details={trade.offer.userId === trade.sellerId ? trade.offer.paymentDetails : null}
    />
  ) : null
  // While they are an instruction to act on, the payment details sit in the current stage, before its action.
  const paymentInCard = actionCardShown && state.instructions === 'active'

  // The bastão: who the current stage waits on, from the viewer's side.
  const viewerSide = isBuyer ? 'buyer' : isSeller ? 'seller' : null
  const baton = batonLabel(state.steps.find((s) => s.state === 'current'), viewerSide, { buyer: buyer.displayName, seller: seller.displayName })
  // The timelock sits with the stage it limits.
  const countdown = escrow ? <EscrowCountdown expiresAt={escrow.expiresAt} timelockHours={escrow.timelockHours} status={escrowStatus} /> : null
  // The signing round is a sub-step of the current stage: rendered inside the stage card (or the dispute panel).
  const signing = (embedded: boolean) => !escrow ? null
    : pending.status === 'loading' ? <SigningRequestCard embedded={embedded} status="loading" label={t('trade.sign.loading')} />
    : pending.status === 'error' ? (
      <SigningRequestCard
        embedded={embedded}
        status="error"
        message={t('trade.sign.pendingReadFailed')}
        retryLabel={t('trade.page.retry')}
        onRetry={() => { setPending({ status: 'loading' }); void refreshPending(escrow) }}
      />
    )
    : signingView ? (
      <SigningRequestCard
        embedded={embedded}
        status="ready"
        view={signingView}
        acting={acting}
        onReview={() => openRoundDialog('sign')}
        onCancel={() => openRoundDialog('cancel')}
        onRefresh={handleRefreshSigning}
      />
    ) : null

  // A finished trade's party rates the other one; informational, never part of the reputation (RFC-007).
  const rateTarget = trade.status === 'COMPLETED' && (isBuyer || isSeller) ? (isBuyer ? seller : buyer) : null
  const rateCopy: RateCounterpartyCopy = {
    title: rateTarget?.displayName != null ? t('trade.rate.title', { name: rateTarget.displayName }) : t(isBuyer ? 'trade.rate.titleSeller' : 'trade.rate.titleBuyer'),
    description: t('trade.rate.description'),
    legend: t('trade.rate.legend'),
    starLabel: (n) => t('trade.rate.stars', { count: n }),
    valueText: (n) => (n ? t('trade.rate.valueOf5', { score: n }) : t('trade.rate.choose')),
    scoreError: t('trade.rate.scoreError'),
    commentLabel: t('trade.rate.commentLabel'),
    commentCounter: (n, max) => `${n}/${max}`,
    commentTooLong: (over, max) => t('trade.rate.commentTooLong', { count: over, max }),
    submitLabel: t('trade.rate.submit'),
  }
  const handleRate = async (input: RatingInput) => {
    if (!rateTarget) return
    setSubmittingRating(true)
    setRatingError(null)
    try {
      await sailsClient.reputation.rate({ tradeId: trade.id, ratedId: rateTarget.id, ...input })
      saveRated(sessionStore(), trade.id, 'rated')
      setRated('rated')
      toast.success(t('trade.rate.sent'))
    } catch (err) {
      if (isAlreadyRatedError(err)) {
        saveRated(sessionStore(), trade.id, 'already')
        setRated('already')
      } else {
        setRatingError(errorMessage(err, t('trade.rate.failed')))
      }
    } finally {
      setSubmittingRating(false)
    }
  }

  return (
    <div className="space-y-4">
      <TradeHeader
        title={title}
        tradeId={trade.id}
        createdAtLabel={formatDateTime(trade.createdAt)}
        asset={<AssetNetworkLabel asset={trade.asset} />}
        leading={(
          <Link to="/" className="inline-flex min-h-11 items-center gap-1.5 text-sm text-brand-text-secondary hover:text-brand-text">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t('trade.page.back')}
          </Link>
        )}
      />

      {/* The counterparty is in its own block (with presence and the chat), not in the amounts. */}
      <TradeAmountsStrip
        items={isBuyer ? [
          { label: t('trade.amounts.youPay'), value: totalLabel, sub: totalSub },
          { label: t('trade.amounts.youReceive'), value: `${trade.amount} ${short}`, sub: <AssetNetworkLabel asset={trade.asset} /> },
          priceItem,
        ] : isSeller ? [
          { label: t('trade.amounts.youSell'), value: `${trade.amount} ${short}`, sub: <AssetNetworkLabel asset={trade.asset} /> },
          { label: t('trade.amounts.youReceive'), value: totalLabel, sub: totalSub },
          priceItem,
        ] : [
          { label: t('trade.amounts.quantity'), value: `${trade.amount} ${short}`, sub: <AssetNetworkLabel asset={trade.asset} /> },
          { label: t('trade.amounts.tradeValue'), value: totalLabel, sub: totalSub },
          priceItem,
        ]}
      />

      <TradeRail steps={state.steps} status={state.status} baton={baton} viewer={viewerSide} />

      {/* Desktop: stage, Registro and Ferramentas on the left, counterparty and chat on the right.
          Phones (DOM order): stage -> counterparty and chat -> Registro -> Ferramentas. */}
      {/* The aside width is the viewer's, set with the divider (AsideResizer); 400 px by default. */}
      <div ref={aside.gridRef} style={aside.style} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_var(--trade-aside-w)] lg:grid-rows-[auto_auto_1fr] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1">
          {/* An open dispute is the current state: its panel below replaces the action card instead of repeating it. */}
          {escrowStatus === 'DISPUTED' && dispute ? null : actionCardShown ? (
            <CurrentActionCard
              view={state.action}
              acting={acting}
              onAction={(a) => ({ createEscrow: handleCreateEscrow, lock: handleLockFunds, markPaymentSent: () => setConfirmStep('markPaid'), release: () => setConfirmRelease(true) })[a]()}
              onOpenDispute={() => setShowDisputeForm(true)}
              disputeTriggerRef={disputeTriggerRef}
            >
              {countdown}
              {fundingView && <FundingInstructionCard view={fundingView} />}
              {state.payoutStep === 'checkFailed' && (
                <div className="mt-4 pt-4 border-t border-brand-border-subtle flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p role="status" className="text-sm text-brand-text-secondary">{t('trade.payout.checkFailed')}</p>
                  <Button variant="outline" onClick={() => setPayoutCheckRun((n) => n + 1)} className="min-h-11 shrink-0 text-sm">{t('trade.page.retry')}</Button>
                </div>
              )}
              {state.payoutStep === 'missing' && (
                // M8-R2 — the BENEFICIARY registers their OWN destination
                // (setPayoutAddress()); the seller never chooses it. Release
                // resolves this address server-side and fails without one.
                <div className="mt-4 pt-4 border-t border-brand-border-subtle">
                  <p className="text-sm font-semibold text-brand-text">{t('trade.payout.missingTitle')}</p>
                  <p className="mt-0.5 text-sm text-brand-text-secondary">
                    {t('trade.payout.missingDescription', { asset: ASSET_LABELS[trade.asset] })}
                  </p>
                  {payoutForm(false)}
                </div>
              )}
              {paymentInCard && <div className="mt-4">{paymentInstructions}</div>}
              {signing(true)}
              {!isBuyer && !isSeller && (
                <p className="mt-3 text-sm text-brand-text-secondary">{t('trade.page.notParty')}</p>
              )}
            </CurrentActionCard>
          ) : (
            <section
              aria-labelledby="dispute-form-title"
              className="rounded-lg border border-brand-border-subtle bg-brand-elevated p-4"
              onKeyDown={(e) => { if (e.key === 'Escape') cancelDisputeForm() }}
            >
              <h2 id="dispute-form-title" className="text-heading text-brand-text">{t('trade.action.openDispute')}</h2>
              <label htmlFor="dispute-reason" className="mt-2 block text-sm text-brand-text-secondary">{t('trade.disputeForm.describeReason')}</label>
              <Textarea
                id="dispute-reason"
                autoFocus
                value={disputeReason}
                onChange={(e) => setDisputeReason(e.target.value)}
                className="mt-1 w-full"
                rows={3}
              />
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Button variant="destructive" onClick={handleOpenDispute} loading={acting} className="min-h-11 text-sm">{t('trade.disputeForm.confirm')}</Button>
                <Button variant="outline" onClick={cancelDisputeForm} className="min-h-11 text-sm">{t('common.cancel')}</Button>
              </div>
            </section>
          )}

          {/* Escrow.disputes (2026-08-03) — getEscrow() surfaces the dispute
              to both parties. Evidence/contest/appeal are real,
              trade-party-only actions (dispute.service.ts's own 403 check). */}
          {dispute && (
            <TradeDisputePanel
              dispute={dispute}
              isBuyer={isBuyer}
              isSeller={isSeller}
              acting={acting}
              evidenceNote={evidenceNote}
              partyLabel={partyLabel}
              onEvidenceNoteChange={setEvidenceNote}
              onSubmitEvidence={handleSubmitEvidence}
              onContestAutoResolution={() => setConfirmStep('contest')}
              onAppeal={() => setConfirmStep('appeal')}
              turnLabel={escrowStatus === 'DISPUTED' ? baton?.text : null}
            >
              {!actionCardShown && <>{countdown}{signing(true)}</>}
            </TradeDisputePanel>
          )}
          {/* Dispute form open (no dispute yet): the round stays visible on its own. */}
          {!actionCardShown && !dispute && signing(false)}

          {rateTarget && (
            <RateCounterpartyCard
              copy={rateCopy}
              doneText={rated === 'rated' ? t('trade.rate.done') : rated === 'already' ? t('trade.rate.already') : null}
              submitting={submittingRating}
              error={ratingError}
              onSubmit={handleRate}
            />
          )}

          {!paymentInCard && paymentInstructions}
        </div>

        {/* Desktop: the aside stays in view under the 56px top bar and the chat takes the height left below the counterparty. */}
        <aside id="trade-aside" className="relative flex min-w-0 flex-col gap-4 lg:col-start-2 lg:row-start-1 lg:row-span-3 lg:sticky lg:top-[4.5rem] lg:h-[calc(100dvh-5.5rem)]" aria-label={t('trade.page.asideLabel')}>
          <AsideResizer width={aside.width} max={aside.max} onChange={aside.set} controls="trade-aside" />
          <TradeParties buyer={buyer} seller={seller} currentUserId={user?.id} counterpartyOnline={counterpartyOnline}>
            <Button
              variant="outline"
              onClick={() => setChatOpen((o) => !o)}
              aria-expanded={chatOpen}
              aria-controls="trade-chat"
              className="mt-1 w-full lg:hidden"
            >
              <MessageSquare className="size-icon-sm" aria-hidden="true" />
              {chatOpen ? t('trade.chat.toggleHide') : t('trade.chat.toggleOpen', { count: messages.length })}
            </Button>
          </TradeParties>
          <div id="trade-chat" className={cn('lg:min-h-0 lg:flex-1', chatOpen ? '' : 'hidden lg:block')}>
            <ChatWindow
              messages={messages}
              currentUserId={user?.id}
              onSend={handleSend}
              encryptionEnabled={encryptionEnabled}
              onToggleEncryption={setEncryptionEnabled}
              encryptionAvailable={!!keypair && !!counterpartyPublicKeyHex}
              counterpartyName={counterpartyName ?? undefined}
              counterpartyOnline={counterpartyOnline}
            />
          </div>
        </aside>

        <div className="min-w-0 lg:col-start-1 lg:row-start-2">
          <TradeSpecs title={t('trade.record.title')} groups={registro} />
        </div>

        {/* Ferramentas: secondary tools, collapsed. Nothing here is a step of the trade. */}
        <details className="group min-w-0 self-start lg:col-start-1 lg:row-start-3">
          <summary className="flex min-h-9 touch:min-h-11 w-fit cursor-pointer items-center gap-2 rounded-md text-sm font-semibold text-brand-text underline-offset-4 hover:underline">
            <ChevronRight className="size-icon-sm transition-transform duration-short ease-standard group-open:rotate-90" aria-hidden="true" />
            {t('trade.page.tools')}
          </summary>
          <div className="mt-2 flex flex-col gap-3">
            {/* A pre-trade proceed/hold/reject read: nothing to act on once the escrow is terminal, disputed or expired. */}
            {state.open
              ? <AgentRiskCard asset={trade.asset} side={isBuyer ? 'BUY' : 'SELL'} maxValue={Number(trade.totalUsd)} minValue={Number(trade.totalUsd)} />
              : <p className="text-sm text-brand-text-secondary">{t('trade.page.agentClosed')}</p>}
            {isBuyer && payoutAddress && (
              <details className="rounded-lg border border-brand-border-subtle bg-brand-surface px-4">
                <summary className="flex min-h-9 touch:min-h-11 cursor-pointer items-center text-sm font-semibold text-brand-text underline-offset-4 hover:underline">{t('trade.payout.change')}</summary>
                <div className="pb-4">{payoutForm(true)}</div>
              </details>
            )}
          </div>
        </details>
      </div>

      <ConfirmActionDialog
        open={confirmRelease}
        onOpenChange={setConfirmRelease}
        title={t('trade.confirm.release.title')}
        summary={[
          { label: t('trade.confirm.release.amount'), value: `${trade.amount} ${short} — ${ASSET_LABELS[trade.asset]}` },
          { label: t('trade.record.tradeValueUsd'), value: totalLabel },
          { label: t('trade.parties.buyer'), value: buyer.displayName ?? t('trade.confirm.nameMissing') },
          { label: t('trade.confirm.currentState'), value: ESCROW_STATE_LABEL[escrowStatus] },
        ]}
        warnings={[
          t('trade.confirm.release.warnBank'),
          t('trade.confirm.release.warnAmount'),
        ]}
        consequence={t('trade.confirm.release.consequence')}
        confirmLabel={t('trade.confirm.release.confirm')}
        busy={acting}
        onConfirm={async () => {
          await handleReleaseFunds()
          setConfirmRelease(false)
        }}
      />

      <ConfirmActionDialog
        open={confirmStep === 'markPaid'}
        onOpenChange={(open) => { if (!open) setConfirmStep(null) }}
        title={t('trade.confirm.markPaid.title')}
        summary={[
          { label: t('trade.confirm.markPaid.amountUsd'), value: totalLabel },
          { label: t('trade.record.paymentMethod'), value: methodLabel ?? t('trade.record.notInformed') },
          { label: t('trade.parties.seller'), value: seller.displayName ?? t('trade.confirm.nameMissing') },
          { label: t('trade.confirm.currentState'), value: ESCROW_STATE_LABEL[escrowStatus] },
        ]}
        warnings={[
          t('trade.confirm.markPaid.warnBank'),
          t('trade.confirm.markPaid.warnAccount'),
        ]}
        consequence={t('trade.confirm.markPaid.consequence')}
        confirmLabel={t('trade.confirm.markPaid.confirm')}
        busy={acting}
        onConfirm={async () => {
          await handleMarkPaymentSent()
          setConfirmStep(null)
        }}
      />

      {dispute && (
        <ConfirmActionDialog
          open={confirmStep === 'contest'}
          onOpenChange={(open) => { if (!open) setConfirmStep(null) }}
          title={t('trade.confirm.contest.title')}
          summary={[
            ...(dispute.autoResolutionRecommendation ? [{ label: t('trade.confirm.contest.suggestion'), value: DISPUTE_RULING_LABEL[dispute.autoResolutionRecommendation] }] : []),
            ...(dispute.autoResolutionDeadline ? [{ label: t('trade.confirm.contest.appliesAt'), value: formatDateTime(dispute.autoResolutionDeadline) }] : []),
          ]}
          consequence={t('trade.confirm.contest.consequence')}
          confirmLabel={t('trade.dispute.contest')}
          busy={acting}
          onConfirm={async () => {
            await handleContestAutoResolution()
            setConfirmStep(null)
          }}
        />
      )}

      {dispute && (
        <ConfirmActionDialog
          open={confirmStep === 'appeal'}
          onOpenChange={(open) => { if (!open) setConfirmStep(null) }}
          title={t('trade.confirm.appeal.title')}
          summary={[
            { label: t('trade.confirm.appeal.ruling'), value: dispute.ruling ? (DISPUTE_RULING_LABEL[dispute.ruling] ?? dispute.ruling) : t('trade.confirm.appeal.rulingMissing') },
            { label: t('trade.confirm.appeal.round'), value: String(dispute.appealRound + 1) },
          ]}
          warnings={[
            t('trade.confirm.appeal.warnFee'),
            t('trade.confirm.appeal.warnRefuse'),
          ]}
          consequence={t('trade.confirm.appeal.consequence')}
          confirmLabel={t('trade.dispute.appealAction')}
          busy={acting}
          onConfirm={async () => {
            await handleAppeal()
            setConfirmStep(null)
          }}
        />
      )}

      {roundDialog?.kind === 'sign' && (
        <ConfirmActionDialog
          open
          onOpenChange={(open) => { if (!open) setRoundDialog(null) }}
          title={t('trade.confirm.sign.title')}
          summary={roundDialog.summary}
          warnings={[t('trade.confirm.sign.warnAddress')]}
          consequence={t('trade.confirm.sign.consequence')}
          confirmLabel={t('trade.confirm.sign.confirm')}
          busy={acting}
          onConfirm={async () => {
            await handleSignPending(roundDialog)
            setRoundDialog(null)
          }}
        />
      )}

      {roundDialog?.kind === 'cancel' && (
        <ConfirmActionDialog
          open
          onOpenChange={(open) => { if (!open) setRoundDialog(null) }}
          title={t('trade.confirm.cancelRound.title')}
          summary={roundDialog.summary}
          consequence={t('trade.confirm.cancelRound.consequence')}
          confirmLabel={t('trade.confirm.cancelRound.confirm')}
          cancelLabel={t('trade.confirm.cancelRound.back')}
          tone="danger"
          busy={acting}
          onConfirm={async () => {
            await handleCancelRound(roundDialog)
            setRoundDialog(null)
          }}
        />
      )}
    </div>
  )
}
