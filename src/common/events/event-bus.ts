import type { EventStore } from './event-store'
import { PostgresEventStore } from './event-store'

/**
 * Sails Protocol — Event Contract
 *
 * Every event follows the canonical namespace: {module}.{entity}.{action}
 * This is mandated by MASTER_COORDINATION.md — it allows future modules
 * (Sails OpenFinance, Sails OpenAgents) to register handlers without
 * ambiguity about which module emitted what.
 *
 * Legacy names (trade.created, escrow.created, etc.) are NOT used here.
 * If external consumers still expect legacy names, add an alias layer
 * at the transport boundary (webhook dispatcher) — never in the Core.
 */

// ─── Sails OpenP2P events ──────────────────────────────────────────────────────
export interface OpenP2PTradeCreatedEvent {
  tradeId: string
  offerId: string
  buyerId: string
  sellerId: string
  asset: string
  amount: string    // decimal string — RFC-009, never a JS number
  priceUsd: string   // decimal string — RFC-009
}

export interface OpenP2PTradeStatusChangedEvent {
  tradeId: string
  from: string
  to: string
  triggeredBy: string
}

export interface OpenP2PMessageSentEvent {
  messageId: string
  tradeId: string
  senderId: string
  content: string
  msgType: string
  timestamp: string
}

// ─── Sails OpenSettlement events ───────────────────────────────────────────────
export interface SettlementEscrowCreatedEvent {
  escrowId: string
  tradeId: string
  type: string
  lockedAmount: string   // decimal string — RFC-009, never a JS number
  asset: string
}

export interface SettlementEscrowStatusChangedEvent {
  escrowId: string
  tradeId: string
  from: string
  to: string
  triggeredBy: string
  txId?: string
  note?: string
  // Issue #298 - id of the EscrowEvent transition claim that produced this event: the stable
  // identity recovery uses to tell 'claimed' from 'published' from 'projected'.
  transitionId?: string
}


// ─── Sails OpenReputation events ───────────────────────────────────────────────
export interface ReputationUpdatedEvent {
  userId: string
  newScore: number
  totalTrades: number
  // null for a RFC-021 D7 burned-vouch penalty (reputation.service.ts's
  // penalizeForBurnedVouch()) — that update isn't scoped to one trade,
  // unlike every recordOutcome()-driven update, which always has one.
  tradeId: string | null
  ratingGiven: number
}

// RFC-021 D7 — real emitters are vouch.service.ts's vouchFor()/burnVouchesFor().
export interface VouchCreatedEvent {
  voucherId: string
  voucheeId: string
  vouchId: string
}
export interface VouchBurnedEvent {
  voucherId: string
  voucheeId: string
  vouchId: string
}

// ─── Sails OpenLiquidity events ────────────────────────────────────────────────
export interface LiquidityOfferCreatedEvent {
  offerId: string
  userId: string
  asset: string
  side: string
  priceUsd: string   // decimal string — RFC-009, never a JS number
}

export interface LiquidityOfferStatusChangedEvent {
  offerId: string
  from: string
  to: string
  triggeredBy: string
}

// ─── Cross-module transport events (Pears/HyperDHT — not owned by any module) ─
export interface PeerConnectedEvent {
  userId: string
  peerId: string
  publicKey: string
  // The local node's own owner (RFC-011) — set only when this event
  // represents a real two-party handshake (pear.service.ts's
  // handleNewConnection), not the self-node-start event a user's own
  // PearNode emits on `start()`. Lets a global handler know BOTH sides
  // of a connection, needed to look up shared active trades.
  localUserId?: string
}

export interface PeerDisconnectedEvent {
  userId: string
  peerId: string
}

// ─── Proof primitive events — RFC-003, PROTOCOL_SPECIFICATION.md §1.8 ────────
export interface ClaimAssertedEvent {
  claimId: string
  claimedBy: string
  claimType: string
}
export interface ProofSubmittedEvent {
  proofId: string
  claimId: string
}
export interface VerificationEvent {
  verificationId: string
  proofId: string
  verifiedBy: string
  verdict: 'ACCEPTED' | 'REJECTED'
}
// Fase 1 Task 3(c) — proof.service.ts's submitProof(). Not in
// PROTOCOL_SPECIFICATION.md §1.8's original event list; added because
// evidenceHash is now always server-recomputed (never client-trusted),
// which makes "the client claimed a different hash than the evidence
// actually produced" a real, detectable signal worth its own event
// rather than a silently-discarded mismatch.
export interface ProofHashMismatchEvent {
  proofId: string
  claimId: string
  claimedHash: string
  actualHash: string
}
// RFC-007 D1 (ProofRegistry), closed 2026-08-04 — "OpenProof flags reuse,
// it does not adjudicate it" (D1's own words): submitProof() emits this
// when the same evidence (by exact-content hash) was already submitted
// under a different trade, rather than silently allowing or blocking it.
// Adjudication is Dispute's/Policy Engine's job, not this event's.
export interface ProofDuplicateDetectedEvent {
  proofId: string
  claimId: string
  evidenceHash: string
  matches: Array<{ proofId: string; tradeId: string | null; matchedAt: string }>
}

// ─── Dispute primitive events — PROTOCOL_SPECIFICATION.md §1.9 ───────────────
export interface DisputeEvent {
  disputeId: string
  settlementId: string
  triggeredBy: string
}

// dispute.opened's real payload — first real emitter is dispute.service.ts
// (04-Deepseek Review.md's raiseDispute()). Extends DisputeEvent with the
// assigned arbiter, since "notify the arbitrator" (the task's own words)
// needs the arbiter to be identifiable from the event itself, not just
// implied.
export interface DisputeOpenedEvent extends DisputeEvent {
  tradeId: string
  arbiterId: string | null
  reason: string
}

// dispute.resolved's real payload — was sharing the generic DisputeEvent
// shape, which had no ruling field; a resolution notification with no
// ruling in it isn't useful to anyone listening.
export interface DisputeResolvedEvent extends DisputeEvent {
  tradeId: string
  ruling: 'RELEASE' | 'REFUND' | 'SPLIT'
}

// Sails Core Implementation Program M8.6 (Execution Cost Semantics &
// Live Correspondence Closure) — durable, replayable record of a
// post-execution M6 correspondence evaluation for a Core-authoritative
// MULTISIG dispute settlement (dispute-correspondence.ts's own
// recordLiveCorrespondenceIfApplicable()). `triggeredBy` on the base
// DisputeEvent is always a system-observed fact, never a user action —
// set to a fixed 'system:live-correspondence' sentinel, matching this
// codebase's own established convention (e.g. 'system:expiry-sweeper').
// `results` maps beneficiary -> CorrespondenceResult ('MATCH'|
// 'DIVERGENT'|'PENDING'|'UNKNOWN') as a plain object (Records don't
// survive JSON event serialization as Maps).
export interface DisputeCorrespondenceEvaluatedEvent extends DisputeEvent {
  appealRound: number
  results: Record<string, 'MATCH' | 'DIVERGENT' | 'PENDING' | 'UNKNOWN'>
}

// dispute.appealed's real payload — RFC-021 D6, first real emitter is
// dispute.service.ts's appeal().
export interface DisputeAppealedEvent extends DisputeEvent {
  tradeId: string
  round: number
  newArbiterId: string
  previousArbiterId: string | null
}

// dispute.evidence_submitted's real payload — RFC-021 D8, first real
// emitter is dispute.service.ts's submitEvidence() (2026-08-02). The
// `dispute.evidence_submitted` key itself already existed in the map
// below with the bare DisputeEvent shape; no emitter ever fired it until
// this pass — tradeId is added here the same way DisputeOpenedEvent/
// DisputeResolvedEvent already extend the base shape with it.
export interface DisputeEvidenceSubmittedEvent extends DisputeEvent {
  tradeId: string
}

// dispute.auto_resolution_proposed's real payload — RFC-021 D8. QVAC's
// recommendation is never final on its own (this file's own header
// comment on the map below has the "attestor, not mover" framing) — this
// event exists so a UI/notification layer can surface the contest window
// to both trade parties, not to trigger any fund movement itself.
export interface DisputeAutoResolutionProposedEvent extends DisputeEvent {
  tradeId: string
  recommendation: 'RELEASE' | 'REFUND'
  confidence: number
  deadline: string // ISO 8601
}

// dispute.auto_resolution_contested's real payload — either trade party
// rejected QVAC's proposal within the window; the dispute falls back to
// its already-assigned human arbiter, unchanged.
export interface DisputeAutoResolutionContestedEvent extends DisputeEvent {
  tradeId: string
  contestedBy: string
}

// arbiter.slashed's real payload — RFC-021 D6, first real emitter is
// market-arbitration.provider.ts's slash(). Not a DisputeEvent (no
// single dispute/settlement it's scoped to from the arbiter's own
// perspective — the same arbiter could be slashed from a future dispute
// too), so this is its own standalone shape.
export interface ArbiterSlashedEvent {
  participantId: string
  forfeitedCollateral: string
  newCollateral: string
  newReputation: number
}

// ─── Negotiation primitive events — PROTOCOL_SPECIFICATION.md §1.4 ───────────
export interface NegotiationOpenedEvent {
  tradeId: string
  buyerId: string
  sellerId: string
}
export interface NegotiationEventReceivedEvent {
  tradeId: string
  eventType: string
}
export interface NegotiationTermsAgreedEvent {
  tradeId: string
}
export interface NegotiationAbandonedEvent {
  tradeId: string
  by: string
}

// ─── Intent Engine events — PROTOCOL_SPECIFICATION.md §2.5 ───────────────────
// Namespace `intent.*` — cross-cutting Core infrastructure, not owned by any
// single module (§2.5's own note). First real emitter: core/intent-engine.ts
// (03-implementation_plan.md MVP work — Intent persistence was "not yet
// implemented" per §2.6 before this). correlationId (RFC-010) = intentId for
// every event here — exactly the "once Intent persistence ships" case
// RFC-010/011 already anticipated.
export interface IntentCreatedEvent {
  intentId: string
  type: string
  participantId: string
  moduleId: string
  parentIntentId?: string
  agentId?: string
}
// RFC-012 (rfcs/RFC-012-intent-validation-and-coordination.md) — the two
// new lifecycle events between intent.created and intent.discovering.
export interface IntentValidatedEvent { intentId: string; participantId: string }
export interface IntentCoordinatedEvent { intentId: string; targetModule: string }
export interface IntentDiscoveringEvent { intentId: string }
export interface IntentMatchedEvent { intentId: string; candidateIds: string[] }
export interface IntentNegotiatingEvent { intentId: string; negotiationId: string }
export interface IntentCommittedEvent { intentId: string; settlementId: string; terms: unknown }
export interface IntentSettlingEvent { intentId: string; settlementId: string }
export interface IntentFulfilledEvent { intentId: string; settlementId: string; outcome: unknown }
export interface IntentExpiredEvent { intentId: string; reason: string }
export interface IntentCancelledEvent { intentId: string; cancelledBy: string }
export interface IntentFailedEvent { intentId: string; reason: string }

// ─── Reconciliation event — RFC-011, rfcs/RFC-011-p2p-reconciliation.md ──────
// Emitted when a peer reconnect triggers a catch-up against Postgres (the
// authoritative source — every Message/Trade/Escrow write already lands
// there regardless of whether the P2P/HyperDHT delivery to the counterparty
// succeeded). Not a replacement for Timeline (RFC-008 D5) once that's
// built — see RFC-011's Reference Implementation Plan for the migration path.
export interface NegotiationReconciledEvent {
  tradeId: string
  currentTradeStatus: string
  currentEscrowStatus: string | null
  missedMessageCount: number
}

// ─── Sails OpenAgents — Social Engineering Agent (RFC-007 D7, real as of
// RFC-017, rfcs/RFC-017-timeline-and-social-engineering-agent.md) ────────────
// Raised when SocialEngineeringAgent.evaluate() (social-engineering-agent.ts)
// scores a Timeline entry above the detection threshold. Detection only —
// per D7's own design, this event never triggers an automatic action; it's
// a signal for a human (surfaced today as a chat RISK_WARNING, RFC-017) or,
// eventually, the Policy Engine (still a stub, core/policy-engine.ts) to
// decide what to do with.
export interface SocialEngineeringRiskDetectedEvent {
  tradeId: string
  pattern: 'off_channel_migration' | 'payment_instruction_change' | 'unexpected_flow_deviation'
  riskScore: number
  reasoning: string
  sourceEventId: string
  detectedAt: string
}

// Raised by liquidity.service.ts's screenOfferContent() (fire-and-forget,
// see its own comment) when config.features.socialEngineeringDetection is
// on. Same detection-only posture as SocialEngineeringRiskDetectedEvent
// above, applied to an Offer's own free-text fields instead of chat.
export interface OfferContentRiskDetectedEvent {
  offerId: string
  userId: string
  pattern: 'off_channel_migration' | 'payment_instruction_change'
  riskScore: number
  reasoning: string
  detectedAt: string
}

// Raised by common/security/suspicious-activity.ts the first time an
// identity crosses a threshold within a detection window (repeated auth
// failures, 404 clustering / ID enumeration, or repeated rate-limit hits).
// Detection only, same posture as SocialEngineeringRiskDetectedEvent above
// — never blocks or bans anything itself, just surfaces a signal for a
// human or alerting pipeline.
export interface SuspiciousActivityDetectedEvent {
  kind: 'AUTH_FAILURE' | 'NOT_FOUND_CLUSTER' | 'RATE_LIMITED'
  identity: string // participantId if authenticated, request.ip otherwise
  count: number
  windowMs: number
  detectedAt: string
}

// ─── Event Map — canonical namespace {module}.{entity}.{action} ──────────────
export interface SailsEventMap {
  // Intent Engine — §2.5, cross-cutting Core, not module-owned
  'intent.created': IntentCreatedEvent
  'intent.validated': IntentValidatedEvent     // RFC-012
  'intent.coordinated': IntentCoordinatedEvent // RFC-012
  'intent.discovering': IntentDiscoveringEvent
  'intent.matched': IntentMatchedEvent
  'intent.negotiating': IntentNegotiatingEvent
  'intent.committed': IntentCommittedEvent
  'intent.settling': IntentSettlingEvent
  'intent.fulfilled': IntentFulfilledEvent
  'intent.expired': IntentExpiredEvent
  'intent.cancelled': IntentCancelledEvent
  'intent.failed': IntentFailedEvent

  // Sails OpenP2P — trade lifecycle
  'openp2p.trade.created': OpenP2PTradeCreatedEvent
  'openp2p.trade.status_changed': OpenP2PTradeStatusChangedEvent
  'openp2p.trade.completed': OpenP2PTradeStatusChangedEvent
  'openp2p.trade.disputed': OpenP2PTradeStatusChangedEvent
  'openp2p.trade.cancelled': OpenP2PTradeStatusChangedEvent
  'openp2p.message.sent': OpenP2PMessageSentEvent

  // Sails OpenSettlement — escrow lifecycle
  'settlement.escrow.created': SettlementEscrowCreatedEvent
  'settlement.escrow.locked': SettlementEscrowStatusChangedEvent
  'settlement.escrow.payment_pending': SettlementEscrowStatusChangedEvent
  'settlement.escrow.released': SettlementEscrowStatusChangedEvent
  'settlement.escrow.disputed': SettlementEscrowStatusChangedEvent
  'settlement.escrow.refunded': SettlementEscrowStatusChangedEvent
  'settlement.escrow.split': SettlementEscrowStatusChangedEvent // RFC-021 D9
  // Fase 7.3.1 §C, made a real status transition by Fase 7.3.3 §B —
  // FUNDS_LOCKED -> EXPIRED, a real, durable, observed-not-acted-upon
  // fact (system never signs, never impersonates a participant).
  'settlement.escrow.expired': SettlementEscrowStatusChangedEvent

  // Sails OpenReputation
  'reputation.score.updated': ReputationUpdatedEvent
  'reputation.vouch.created': VouchCreatedEvent // RFC-021 D7
  'reputation.vouch.burned': VouchBurnedEvent // RFC-021 D7

  // Sails OpenLiquidity — offers
  'liquidity.offer.created': LiquidityOfferCreatedEvent
  'liquidity.offer.status_changed': LiquidityOfferStatusChangedEvent

  // Proof primitive — RFC-003
  'claim.asserted': ClaimAssertedEvent
  'proof.submitted': ProofSubmittedEvent
  'proof.hash_mismatch_detected': ProofHashMismatchEvent
  'proof.duplicate_detected': ProofDuplicateDetectedEvent
  'verification.accepted': VerificationEvent
  'verification.rejected': VerificationEvent

  // Dispute primitive
  'dispute.opened': DisputeOpenedEvent
  'dispute.evidence_submitted': DisputeEvidenceSubmittedEvent // RFC-021 D8 — first real emitter 2026-08-02
  'dispute.arbitrated': DisputeEvent
  'dispute.resolved': DisputeResolvedEvent
  'dispute.appealed': DisputeAppealedEvent // RFC-021 D6
  'dispute.settlement.correspondence_evaluated': DisputeCorrespondenceEvaluatedEvent // M8.6
  'dispute.auto_resolution_proposed': DisputeAutoResolutionProposedEvent // RFC-021 D8
  'dispute.auto_resolution_contested': DisputeAutoResolutionContestedEvent // RFC-021 D8

  // RFC-021 D6 — MarketArbitrationProvider slashing
  'arbiter.slashed': ArbiterSlashedEvent

  // Negotiation primitive — RFC-004
  'negotiation.opened': NegotiationOpenedEvent
  'negotiation.event_received': NegotiationEventReceivedEvent
  'negotiation.terms_agreed': NegotiationTermsAgreedEvent
  'negotiation.abandoned': NegotiationAbandonedEvent
  'negotiation.reconciled': NegotiationReconciledEvent

  // Cross-module — P2P transport (Pears/HyperDHT)
  'peer.connected': PeerConnectedEvent
  'peer.disconnected': PeerDisconnectedEvent

  // Sails OpenAgents — Social Engineering Agent (RFC-007 D7 / RFC-017)
  'agents.social_engineering.risk_detected': SocialEngineeringRiskDetectedEvent
  // Sails OpenLiquidity — QVAC offer-content screening, 2026-08-15
  'liquidity.offer.content_risk_detected': OfferContentRiskDetectedEvent

  // Cross-cutting security — common/security/suspicious-activity.ts
  'security.suspicious_activity.detected': SuspiciousActivityDetectedEvent
}

export type SailsEventName = keyof SailsEventMap

// ─── Typed Event Bus (RFC-010 — delegates to a pluggable EventStore) ─────────
// Previously extended EventEmitter directly (in-memory only, no durability,
// no correlationId). Now wraps an EventStore — PostgresEventStore by
// default as of Missão 05.7 (2026-08-15; InMemoryEventStore was the
// default before this, still available and still used directly by tests
// that want a fast, zero-infrastructure store) — so a durable backend can
// be swapped in via the constructor without any eventBus.emit()/on() call
// site changing — see event-store.ts.
//
// Exported (Missão 05.7) so a test can construct a genuinely independent
// instance sharing zero in-process state with the module singleton below
// — the only way to actually simulate "the process restarted" rather
// than merely asserting it in prose. Not a change anything else needed:
// every real call site still just imports the `eventBus` singleton.
export class SailsEventBus {
  constructor(private readonly store: EventStore = new PostgresEventStore()) {}

  get storeName(): string {
    return this.store.storeName
  }

  get durable(): boolean {
    return this.store.durable
  }

  // correlationId is mandatory (RFC-010) — every event now carries the id
  // that ties it to Timeline (RFC-008), logs, Proofs, Settlement, and
  // Dispute. Today: tradeId for trade/negotiation/settlement events, userId
  // for peer/transport events (see DurableEvent's correlationId doc in
  // event-store.ts for the full rule).
  async emit<K extends SailsEventName>(
    event: K,
    payload: SailsEventMap[K],
    correlationId: string
  ): Promise<void> {
    await this.store.publish(event, payload, correlationId)
  }

  // Handler signature is unchanged from pre-RFC-010 (still receives the bare
  // payload) — this is what let every existing eventBus.on(...) call site in
  // handlers.ts stay untouched. correlationId is available on the event as
  // published (DurableEvent), not threaded into the handler signature, since
  // no handler in this codebase needs it inside the handler body today.
  on<K extends SailsEventName>(
    event: K,
    listener: (payload: SailsEventMap[K]) => void | Promise<void>
  ): void {
    this.store.subscribe(event, (durableEvent) => listener(durableEvent.payload))
  }

  // Timeline's (RFC-017) only real dependency on the bus — a thin
  // passthrough to whatever EventStore is wired in, so Timeline never
  // needs to know which store implementation is active.
  getEvents(correlationId: string): Promise<import('./event-store').DurableEvent[]> {
    return this.store.getEvents(correlationId)
  }

  // Additive — RFC-017's SocialEngineeringAgent.evaluate() needs the full
  // DurableEvent (eventId, publishedAt) to build a real TimelineEntry, not
  // just the bare payload on() gives every other handler. A new method
  // instead of changing on()'s signature, so every existing
  // eventBus.on(...) call site in this codebase stays untouched.
  onDurable<K extends SailsEventName>(
    event: K,
    listener: (event: import('./event-store').DurableEvent<K>) => void | Promise<void>
  ): void {
    this.store.subscribe(event, listener)
  }

  // Issue #298 - re-drive an ALREADY-persisted durable event to this instance's local handlers
  // (recovery of an incomplete projection). Not part of the generic EventStore interface for the
  // same reason enableCrossInstanceFanout() is not: only PostgresEventStore can reload a row by id.
  // Safe because every economically relevant projection is idempotent per (eventId, projectionKey,
  // subjectId) - redelivery cannot duplicate an effect. Returns false if the event does not exist.
  async redeliver(eventId: string): Promise<boolean> {
    if ('redeliver' in this.store) {
      return (this.store as import('./event-store').PostgresEventStore).redeliver(eventId)
    }
    return false
  }

  // Missão 08B — thin passthrough, same shape as getEvents() above. Not
  // part of the generic EventStore interface (InMemoryEventStore/
  // RedisStreamsEventStore have no such concept, same reason those two
  // don't implement pg_advisory_xact_lock's serialization either) — a
  // runtime check rather than an interface method keeps that boundary
  // real instead of forcing every EventStore implementation to know about
  // Redis. A no-op for any store that isn't PostgresEventStore (e.g. the
  // InMemoryEventStore many tests construct their own bus around), same
  // as this being a no-op is already the correct behavior for a
  // single-instance deployment that never calls it at all.
  enableCrossInstanceFanout(publisher: import('ioredis').Redis): void {
    if ('enableCrossInstanceFanout' in this.store) {
      (this.store as import('./event-store').PostgresEventStore).enableCrossInstanceFanout(publisher)
    }
  }

  async disableCrossInstanceFanout(): Promise<void> {
    if ('disableCrossInstanceFanout' in this.store) {
      await (this.store as import('./event-store').PostgresEventStore).disableCrossInstanceFanout()
    }
  }
}

// Singleton — shared across all modules. This IS the "zero coupling" mechanism:
// modules never import each other, they only import this bus and react to events.
export const eventBus = new SailsEventBus()
