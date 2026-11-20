import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useNavigate, useLocation } from 'react-router'
import { toast } from 'sonner'
import type { Trade as SdkTrade, Escrow as SdkEscrow, EscrowPendingTransaction, WebSocketChannel, Dispute } from '@satsails/p2p-trading-sdk'
import { encryptChatMessage, SigningIntentVerificationError } from '@satsails/p2p-trading-sdk'
import type { EscrowStatus, Message, MessageType, User } from '../types'
import { useAuth, WrongPassphraseError } from '../context/AuthContext'
import { useEscrowKey } from '../hooks/useEscrowKey'
import { classifySigningWatchError, classifyPendingTransactionError } from '../lib/escrowErrorClassification'
import { checkMultisigPending, MultisigSigningIntentError } from '../lib/multisigSigningIntent'
import { deriveSigningRequest, roundSnapshotChanged, signingActionLabel, UNKNOWN_SIGNER, type RoundSnapshot, type SigningVerification } from '../lib/signingRequest'
import { sailsClient } from '../lib/sailsClient'
import { toUiMessage, toUiMessageFromEvent } from '../lib/tradeMessages'
import { TradeStatusBadge, EscrowStatusBadge, ESCROW_STATUS_LABEL } from '../components/ui/StatusBadges'
import { EscrowStateMachine } from '../components/trade/EscrowStateMachine'
import { EscrowCountdown } from '../components/trade/EscrowCountdown'
import { CurrentActionCard } from '../components/trade/CurrentActionCard'
import { SigningRequestCard } from '../components/trade/SigningRequestCard'
import { deriveCurrentAction } from '../lib/currentAction'
import { TradeParties } from '../components/trade/TradeParties'
import { TradeDisputePanel } from '../components/trade/TradeDisputePanel'
import { ChatWindow } from '../components/chat/ChatWindow'
import { AgentRiskCard } from '../components/agent/AgentRiskCard'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { CopyButton } from '../components/ui/CopyButton'
import { ConfirmActionDialog } from '../components/ui/ConfirmActionDialog'
import { SafetyNote } from '../components/ui/SafetyNote'
import { Lock, Banknote, Unlock, ArrowLeft } from 'lucide-react'
import { formatDateTime } from '../lib/format'
import { formatByCurrency } from '../lib/currency'
import { detectRiskLocally } from '../lib/socialEngineering'
import { ASSET_LABELS, PAYMENT_METHOD_LABELS } from '../lib/labels'

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
// trade's buyer/seller — only displayName, positiveFeedbackPct()'s
// totalTrades/disputeCount, and verified matter there.
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
  if (err instanceof SigningIntentVerificationError) return 'A transação não corresponde ao que era esperado para este escrow — não assine.'
  if (err instanceof MultisigSigningIntentError) return `Não foi possível conferir a transação: ${err.userMessage}`
  if (err instanceof WrongPassphraseError) return err.message
  // The server may store the signature before a later step fails, so never claim nothing was sent.
  return 'Não foi possível concluir. Sua assinatura pode ter sido registrada — confira o estado abaixo.'
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
        toast.error('Não foi possível verificar sua permissão para assinar este escrow.')
        break
      default:
        toast.error('Não foi possível registrar sua chave neste escrow — tente recarregar a página.')
    }
  }

  const [trade, setTrade] = useState<SdkTrade | null>(null)
  const [escrow, setEscrow] = useState<SdkEscrow | null>(null)
  const [buyer, setBuyer] = useState<User | null>(null)
  const [seller, setSeller] = useState<User | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState(false)
  const [confirmRelease, setConfirmRelease] = useState(false)
  const [pending, setPending] = useState<PendingState>({ status: 'none' })
  const [roundDialog, setRoundDialog] = useState<RoundDialog | null>(null)
  const [showDisputeForm, setShowDisputeForm] = useState(false)
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

  // Real fetch — openp2p.getTrade() + identity.get() for both real
  // parties + settlement.get() for the real escrow (if one exists yet)
  // + real chat history. Independent of how the page was reached (a
  // fresh POST /v1/openp2p/trades navigation, a bookmark, or a refresh)
  // — no client-only mock construction left (buildTrade.ts, replaced).
  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)
    setPending({ status: 'none' })
    ;(async () => {
      const t = await sailsClient.openp2p.getTrade(id)
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
        // Real presence — USER_ONLINE/USER_OFFLINE are the only two frame
        // types onEvent() needs to react to here; everything else
        // (TRADE_STATUS_UPDATE/ESCROW_STATUS_UPDATE/...) is a separate,
        // not-yet-built live-sync improvement, not attempted in this pass.
        channel.onEvent((frame) => {
          if (frame.type !== 'USER_ONLINE' && frame.type !== 'USER_OFFLINE') return
          const payload = frame.payload as { participantId?: string }
          if (payload.participantId !== counterpartyId) return
          setCounterpartyOnline(frame.type === 'USER_ONLINE')
        })
        channelRef.current = channel
      }
    })().finally(() => { if (!cancelled) setLoading(false) })

    return () => {
      cancelled = true
      channelRef.current?.close()
      channelRef.current = null
    }
  }, [id, user, keypair])

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
      return { status: 'cannotVerify', reason: 'Não foi possível ler os dados da transação.' }
    }
  }, [escrow, pendingTx])
  const signingView = useMemo(() => pendingTx && trade && escrow ? deriveSigningRequest({
    pending: pendingTx,
    viewerId: user?.id,
    verification,
    signerLabel: (pid) => pid === user?.id ? 'Você' : pid === trade.buyerId ? 'Comprador' : pid === trade.sellerId ? 'Vendedor' : UNKNOWN_SIGNER,
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
    toast.error('O estado do trade mudou — revise antes de continuar')
  }, [roundDialog, acting, pendingTx])

  const openRoundDialog = (kind: RoundDialog['kind']) => {
    if (!pendingTx || !signingView || !escrow) return
    const progress = { label: 'Assinaturas', value: signingView.progress.text }
    const status = { label: 'Estado atual', value: ESCROW_STATUS_LABEL[escrow.status as EscrowStatus] ?? escrow.status }
    setRoundDialog({
      kind,
      round: { id: pendingTx.id, unsignedPsbtBase64: pendingTx.unsignedPsbtBase64 },
      escrowStatus: escrow.status,
      summary: kind === 'sign'
        ? [
            { label: 'Ação', value: signingActionLabel(pendingTx.kind) },
            // Full money flow from the verified transaction: each output and the network fee (labels are unique).
            ...(signingView.check?.items ?? []).map((it) => ({ label: it.label, value: it.value })),
            { label: 'Conferência', value: signingView.check?.title ?? '' },
            progress,
            status,
          ]
        : [{ label: 'Rodada', value: signingActionLabel(pendingTx.kind) }, progress, status],
    })
  }

  // M8-R2 — only the buyer needs to see/manage this (they're the
  // beneficiary of a release for this trade); re-checked whenever the
  // trade's asset or the logged-in user changes. A 404 (no PayoutAddress
  // registered for this participant/asset yet) is the normal, expected
  // "not registered" state, not an error to surface.
  useEffect(() => {
    if (!isBuyer || !user || !trade) return
    let cancelled = false
    sailsClient.settlement.getPayoutAddress(user.id, trade.asset)
      .then((view) => { if (!cancelled) setPayoutAddress({ address: view.address }) })
      .catch(() => { if (!cancelled) setPayoutAddress(null) })
    return () => { cancelled = true }
  }, [isBuyer, user, trade])

  const handleSetPayoutAddress = async () => {
    if (!trade || !payoutAddressInput.trim()) return
    setSavingPayoutAddress(true)
    try {
      const record = await sailsClient.settlement.setPayoutAddress({ asset: trade.asset, address: payoutAddressInput.trim() })
      setPayoutAddress({ address: record.address })
      setPayoutAddressInput('')
      toast.success('Endereço de recebimento salvo')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar endereço')
    } finally {
      setSavingPayoutAddress(false)
    }
  }

  const events = useMemo(() => {
    if (!escrow) return []
    // No dedicated escrow-history endpoint is wired into this SDK yet —
    // deriving a single current-state entry from the real Escrow row
    // rather than fabricating a full event log this UI can't fetch.
    return [{ status: escrow.status as EscrowStatus, timestamp: escrow.updatedAt }]
  }, [escrow])

  const withGuard = async (fn: () => Promise<void>) => {
    setActing(true)
    try {
      await fn()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha na ação')
    } finally {
      setActing(false)
    }
  }

  const handleCreateEscrow = () => trade && withGuard(async () => {
    const e = await sailsClient.settlement.create({ tradeId: trade.id, lockedAmount: trade.amount, asset: trade.asset })
    setEscrow(e)
    toast.success('Escrow criado')
  })

  const handleLockFunds = () => escrow && withGuard(async () => {
    const e = await sailsClient.settlement.lock(escrow.id)
    setEscrow(e)
    toast.success('Escrow bloqueado', { icon: <Lock className="h-4 w-4" /> })
  })

  const handleMarkPaymentSent = () => escrow && withGuard(async () => {
    const e = await sailsClient.settlement.markPaymentSent(escrow.id)
    setEscrow(e)
    toast.success('Pagamento marcado como enviado', { icon: <Banknote className="h-4 w-4" /> })
  })

  // Explicit, user-confirmed signing (MULTISIG only). Re-reads the round
  // and the escrow first; aborts if anything changed since the review.
  const handleSignPending = (snap: RoundDialog) => escrow && user && withGuard(async () => {
    if (!encryptionKey) {
      toast.error('Sua chave de escrow está bloqueada — entre novamente com sua senha para assinar.')
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
      toast.error('O estado do trade mudou — revise antes de continuar')
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
    if (signedOk) toast.success('Assinatura registrada')
  })

  const handleRefreshSigning = () => escrow && withGuard(async () => {
    const e = await sailsClient.settlement.get(escrow.id)
    setEscrow(e)
    const next = await refreshPending(e)
    if (next.status === 'error') toast.error('Não foi possível consultar se há uma assinatura pendente neste escrow.')
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
      toast.error('O estado do trade mudou — revise antes de continuar')
      return
    }
    const result = await sailsClient.settlement.cancelPendingTransaction(escrow.id, freshTx.id)
    setRoundDialog(null)
    const e = await sailsClient.settlement.get(escrow.id).catch(() => freshEscrow)
    setEscrow(e)
    await refreshPending(e)
    toast.success(result.outcome === 'CANCELLED' ? 'Rodada de assinatura encerrada' : 'Esta rodada de assinatura já não existe — estado atualizado')
  })

  const handleReleaseFunds = () => escrow && withGuard(async () => {
    // The confirmation dialog may be stale: re-read the escrow and release
    // only if it is still PAYMENT_PENDING and this viewer is still the seller.
    const fresh = await sailsClient.settlement.get(escrow.id)
    if (fresh.status !== 'PAYMENT_PENDING' || !user || user.id !== trade?.sellerId) {
      setEscrow(fresh)
      toast.error('O estado do trade mudou — revise antes de continuar')
      return
    }
    // MULTISIG, LIGHTNING_HODL and SAFE_GUARD_EVM release through a client-
    // signed round (initiateRelease(), never the plain release() below).
    // CTO 437 step 4: this page never signs on its own — each required
    // signer reviews and signs from SigningRequestCard. Only MULTISIG has a
    // verify-then-sign path, so a round is never started for LIGHTNING_HODL /
    // SAFE_GUARD_EVM: it could not be signed here and would block retries.
    if (UNSIGNABLE_ESCROW_TYPES.has(escrow.type)) {
      toast.error('Liberação indisponível nesta interface para este tipo de escrow')
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
      toast.success(
        e.status === 'COMPLETED' ? 'Escrow marcado como concluído pelo servidor'
          : missing.includes(user.id) ? 'Liberação iniciada — revise e assine a transação abaixo.'
          : missing.length === 1 && missing[0] === trade?.buyerId ? 'Liberação iniciada — aguardando a assinatura do comprador.'
          : 'Liberação iniciada — a transação precisa das assinaturas necessárias.'
      )
      return
    }
    const e = await sailsClient.settlement.release(escrow.id)
    setEscrow(e)
    toast.success(e.status === 'COMPLETED' ? 'Escrow marcado como concluído pelo servidor' : 'Liberação solicitada')
  })

  const handleOpenDispute = () => escrow && withGuard(async () => {
    if (!disputeReason.trim()) {
      toast.error('Descreva o motivo da disputa')
      return
    }
    await sailsClient.settlement.dispute(escrow.id, disputeReason.trim())
    const refreshed = await sailsClient.settlement.get(escrow.id)
    setEscrow(refreshed)
    toast.error('Disputa aberta')
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
      toast.error('Descreva a evidência antes de enviar')
      return
    }
    const updated = await sailsClient.settlement.submitDisputeEvidence(
      dispute.id, { type: 'text', note: evidenceNote.trim() }, evidenceIdempotencyKeyRef.current
    )
    evidenceIdempotencyKeyRef.current = crypto.randomUUID() // this attempt is now settled — a new key for the next one
    patchDispute(updated)
    setEvidenceNote('')
    toast.success('Evidência enviada')
  })

  const handleContestAutoResolution = () => dispute && withGuard(async () => {
    const updated = await sailsClient.settlement.contestAutoResolution(dispute.id)
    patchDispute(updated)
    toast('Recomendação automática contestada — disputa voltou para revisão humana')
  })

  const handleAppeal = () => dispute && withGuard(async () => {
    const { dispute: updated, appealFeeRequired } = await sailsClient.settlement.appealDispute(dispute.id)
    patchDispute(updated)
    toast.success(`Apelação registrada — taxa de apelação: ${appealFeeRequired}`)
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

  // No real media upload/storage endpoint exists yet (types.ts's own
  // comment on MessageType) — stays client-local, never reaches the real
  // chat channel, which only carries a plain-text `content` field today.
  const handleSendMedia = (media: { url: string; fileName: string; type: MessageType }) => {
    setMessages((m) => [
      ...m,
      { id: `m-${Date.now()}`, senderId: user?.id ?? null, sender: user, content: '', type: media.type, mediaUrl: media.url, mediaFileName: media.fileName, createdAt: new Date().toISOString() },
    ])
  }

  if (loading) {
    return <div className="text-center py-16 text-brand-text-muted">Carregando trade...</div>
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
      <div className="text-center py-16">
        <p className="text-brand-text-secondary mb-3">Conecte sua wallet para ver este trade.</p>
        <Button onClick={() => navigate('/login', { state: { from: location.pathname } })} className="mx-auto">
          Conectar wallet
        </Button>
      </div>
    )
  }

  if (!trade || !buyer || !seller) {
    return (
      <div className="text-center py-16">
        <p className="text-brand-text-secondary">Trade não encontrado.</p>
        <Link to="/" className="text-sm text-brand-orange-accent underline mt-2 inline-block">Voltar ao Marketplace</Link>
      </div>
    )
  }

  const escrowStatus: EscrowStatus = (escrow?.status as EscrowStatus) ?? 'CREATED'
  // Escrow.disputes (2026-08-03, see that field's own doc comment) — at
  // most one entry in practice (Dispute.@@unique([tradeId])), but a real
  // Prisma include shape, so this stays an array server-side.
  const dispute = escrow?.disputes?.[0] ?? null
  const amount = Number(trade.amount)
  const totalUsd = Number(trade.totalUsd)

  return (
    <div>
      <div className="flex items-center gap-3">
        <Link to="/" className="p-2 -m-2 text-sm text-brand-text-secondary hover:text-brand-text"><ArrowLeft className="h-4 w-4" /></Link>
        <span className="font-mono text-sm text-brand-text-muted">Trade #{id?.slice(0, 8)}</span>
        <TradeStatusBadge status={trade.status} />
      </div>

      <div className="mt-4 grid lg:grid-cols-[380px_1fr] gap-4">
        <div>
          <Card className="p-4 divide-y divide-brand-border">
            <Row label="Ativo" value={ASSET_LABELS[trade.asset]} />
            <Row label="Quantidade" value={String(amount)} />
            <Row label="Total (USD)" value={formatByCurrency(totalUsd, 'USD')} />
            <Row label="Status do escrow" value={<EscrowStatusBadge status={escrowStatus} />} />
            {/* Real fields (Trade.completedAt/cancelledAt) that existed
                on the SDK's own Trade type but were never rendered
                anywhere in this UI before — found the same way as the
                escrow timelock above (grepped for usages, found zero). */}
            {trade.completedAt && <Row label="Concluído em" value={formatDateTime(trade.completedAt)} />}
            {trade.cancelledAt && <Row label="Cancelado em" value={formatDateTime(trade.cancelledAt)} />}
          </Card>

          {isBuyer && trade.offer && (
            // Found auditing this screen: paymentMethod/paymentDetails
            // (where to actually send fiat) were fetched by OfferDetail
            // but never carried into the Trade screen — a buyer who'd
            // already left that page had no way to see it again once
            // the trade was underway. trade.service.ts's getTrade() now
            // includes the originating Offer specifically for this.
            <Card className="p-4 mt-3 border border-brand-orange-accent/30">
              <p className="text-xs font-semibold text-brand-text-muted mb-2">
                Como pagar — {PAYMENT_METHOD_LABELS[trade.offer.paymentMethod]}
              </p>
              {trade.offer.paymentDetails ? (
                <>
                  <div className="flex items-start gap-2">
                    <p className="flex-1 min-w-0 text-sm font-mono text-brand-text break-all">{trade.offer.paymentDetails}</p>
                    <CopyButton value={trade.offer.paymentDetails} label="Copiar dados" className="shrink-0 min-h-11 px-3" />
                  </div>
                  <SafetyNote className="mt-3">
                    Pague somente para estes dados, de uma conta no seu nome. Não aceite outros dados enviados por chat, e-mail ou telefone, nem pagamentos de terceiros.
                  </SafetyNote>
                </>
              ) : (
                <p className="text-xs text-brand-text-muted">
                  O vendedor não informou os dados de pagamento aqui — combine pelo chat.
                </p>
              )}
            </Card>
          )}

          {isBuyer && (
            // M8-R2 (2026-09-11, docs/DESTINATION_AUTHORITY_ARCHITECTURE.md)
            // — this is the BENEFICIARY registering their OWN destination
            // (sailsClient.settlement.setPayoutAddress()), never the seller
            // choosing it. The seller has no UI to type or select this
            // value anywhere in this page — see handleReleaseFunds()'s own
            // comment above for why that's now a server-enforced rule, not
            // just a UI convention.
            <Card className="p-4 mt-3 border border-brand-orange-accent/30">
              <p className="text-xs font-semibold text-brand-text-muted mb-2">
                Seu endereço de recebimento — {ASSET_LABELS[trade.asset]}
              </p>
              {payoutAddress === undefined ? (
                <p className="text-xs text-brand-text-muted">Verificando...</p>
              ) : payoutAddress ? (
                <p className="text-sm font-mono text-brand-text break-all mb-2">{payoutAddress.address}</p>
              ) : (
                <p className="text-xs text-brand-text-muted mb-2">
                  Nenhum endereço registrado ainda — a liberação dos fundos vai falhar até você registrar um.
                </p>
              )}
              <div className="flex gap-2">
                <Input
                  value={payoutAddressInput}
                  onChange={(e) => setPayoutAddressInput(e.target.value)}
                  placeholder={payoutAddress ? 'Atualizar endereço' : 'Seu endereço para receber'}
                  className="text-sm"
                />
                <Button onClick={handleSetPayoutAddress} disabled={savingPayoutAddress || !payoutAddressInput.trim()} className="shrink-0 py-2 text-sm">
                  {savingPayoutAddress ? 'Salvando...' : payoutAddress ? 'Atualizar' : 'Registrar'}
                </Button>
              </div>
            </Card>
          )}

          <TradeParties buyer={buyer} seller={seller} currentUserId={user?.id} counterpartyOnline={counterpartyOnline} />

          <AgentRiskCard asset={trade.asset} side={isBuyer ? 'BUY' : 'SELL'} maxValue={Number(trade.totalUsd)} minValue={Number(trade.totalUsd)} />

          <Card className="p-5 mt-3">
            <EscrowStateMachine status={escrowStatus} />
            {escrow && (
              <EscrowCountdown expiresAt={escrow.expiresAt} timelockHours={escrow.timelockHours} status={escrowStatus} />
            )}

            {!escrow ? (
              isSeller ? (
                <Button onClick={handleCreateEscrow} disabled={acting} className="w-full py-2.5 text-sm mt-4">
                  {acting ? (
                    'Criando...'
                  ) : (
                    <>
                      <Unlock className="h-4 w-4" />
                      Criar Escrow
                    </>
                  )}
                </Button>
              ) : (
                <p className="text-xs text-brand-text-muted mt-3">Aguardando o vendedor criar o escrow.</p>
              )
            ) : !showDisputeForm ? (
              <>
              {pending.status === 'loading' && <SigningRequestCard status="loading" label="Consultando assinaturas pendentes…" />}
              {pending.status === 'error' && (
                <SigningRequestCard
                  status="error"
                  message="Não foi possível consultar se há uma assinatura pendente neste escrow."
                  retryLabel="Tentar novamente"
                  onRetry={() => { setPending({ status: 'loading' }); void refreshPending(escrow) }}
                />
              )}
              {signingView && (
                <SigningRequestCard
                  status="ready"
                  view={signingView}
                  acting={acting}
                  onReview={() => openRoundDialog('sign')}
                  onCancel={() => openRoundDialog('cancel')}
                  onRefresh={handleRefreshSigning}
                />
              )}
              <CurrentActionCard
                // While a signing round exists, its card is the next step; never offer a second release.
                view={((v) => pendingTx ? { ...v, primary: undefined } : v)(deriveCurrentAction({ status: escrowStatus, isBuyer, isSeller, releaseUnavailable: UNSIGNABLE_ESCROW_TYPES.has(escrow.type) }))}
                acting={acting}
                onAction={(a) => ({ lock: handleLockFunds, markPaymentSent: handleMarkPaymentSent, release: () => setConfirmRelease(true) })[a]()}
                onOpenDispute={() => setShowDisputeForm(true)}
              />
              </>
            ) : (
              <div className="mt-4">
                <Textarea
                  value={disputeReason}
                  onChange={(e) => setDisputeReason(e.target.value)}
                  placeholder="Descreva o motivo da disputa..."
                  className="w-full"
                  rows={3}
                />
                <div className="flex gap-2 mt-2">
                  <button onClick={handleOpenDispute} disabled={acting} className="flex-1 bg-red-600 hover:bg-red-500 text-white rounded-lg py-2 text-sm font-semibold transition-colors">Confirmar Disputa</button>
                  <Button variant="outline" onClick={() => setShowDisputeForm(false)} className="flex-1 py-2 text-sm">Cancelar</Button>
                </div>
              </div>
            )}

            {!isBuyer && !isSeller && user && (
              <p className="text-xs text-brand-text-muted mt-3">Você não é parte deste trade — ações desabilitadas.</p>
            )}

            {/* Escrow.disputes (2026-08-03) — the only way a trade party
                who didn't open the dispute could ever learn it existed
                before was the opener's own POST response; getEscrow()
                now surfaces it here too. Evidence/contest/appeal are all
                real, trade-party-only actions (dispute.service.ts's own
                403 check) — see Disputes.tsx's own comment for why the
                arbiter console doesn't offer contest, and why it CAN
                resolve directly instead of needing this same evidence step. */}
            {dispute && (
              <TradeDisputePanel
                dispute={dispute}
                isBuyer={isBuyer}
                isSeller={isSeller}
                acting={acting}
                evidenceNote={evidenceNote}
                onEvidenceNoteChange={setEvidenceNote}
                onSubmitEvidence={handleSubmitEvidence}
                onContestAutoResolution={handleContestAutoResolution}
                onAppeal={handleAppeal}
              />
            )}
          </Card>

          <details className="mt-3 card p-4">
            <summary className="text-xs font-semibold text-brand-text-muted cursor-pointer">Último estado registrado do escrow</summary>
            <div className="mt-2 space-y-1.5">
              {events.map((e, i) => (
                <div key={i} className="flex gap-3 text-xs">
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-text-muted mt-1 shrink-0" />
                  <span className="font-medium text-brand-text-secondary">{e.status}</span>
                  <span className="text-brand-text-muted ml-auto">{formatDateTime(e.timestamp)}</span>
                </div>
              ))}
            </div>
          </details>
        </div>

        <ChatWindow
          messages={messages}
          currentUserId={user?.id}
          onSend={handleSend}
          onSendMedia={handleSendMedia}
          encryptionEnabled={encryptionEnabled}
          onToggleEncryption={setEncryptionEnabled}
          encryptionAvailable={!!keypair && !!counterpartyPublicKeyHex}
          counterpartyName={counterpartyName ?? undefined}
          counterpartyOnline={counterpartyOnline}
        />
      </div>

      <ConfirmActionDialog
        open={confirmRelease}
        onOpenChange={setConfirmRelease}
        title="Liberar os fundos ao comprador?"
        summary={[
          { label: 'Valor', value: `${amount} — ${ASSET_LABELS[trade.asset]}` },
          { label: 'Comprador', value: buyer.displayName ?? 'Nome não informado' },
          { label: 'Estado atual', value: ESCROW_STATUS_LABEL[escrowStatus] },
        ]}
        warnings={[
          'Confira o recebimento no app do seu banco — não confie em comprovantes, prints ou SMS.',
          'Libere só se o valor certo já estiver na sua conta.',
        ]}
        consequence="Ao confirmar, a liberação dos fundos ao comprador é iniciada. Em alguns escrows ela só é concluída depois das assinaturas necessárias. Depois de concluída, não pode ser desfeita."
        confirmLabel="Confirmar liberação"
        busy={acting}
        onConfirm={async () => {
          await handleReleaseFunds()
          setConfirmRelease(false)
        }}
      />

      {roundDialog?.kind === 'sign' && (
        <ConfirmActionDialog
          open
          onOpenChange={(open) => { if (!open) setRoundDialog(null) }}
          title="Assinar esta transação?"
          summary={roundDialog.summary}
          warnings={['O endereço de destino é o que o servidor informou para esta rodada — confira-o antes de assinar.']}
          consequence="Sua assinatura autoriza esta transação. Com as assinaturas necessárias ela pode ser transmitida e não poderá ser desfeita."
          confirmLabel="Assinar"
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
          title="Cancelar esta rodada de assinatura?"
          summary={roundDialog.summary}
          consequence="Encerra esta rodada de assinatura. Assinaturas já entregues continuam válidas para esta mesma transação até o depósito ser gasto."
          confirmLabel="Cancelar rodada"
          cancelLabel="Voltar"
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

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center py-2.5 text-sm">
      <span className="text-brand-text-muted">{label}</span>
      <span className="font-medium text-brand-text">{value}</span>
    </div>
  )
}
