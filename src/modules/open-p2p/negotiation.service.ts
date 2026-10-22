/**
 * Sails OpenP2P — Negotiation Service
 *
 * This is the file TODO.md §1 flagged as missing entirely — the heart of
 * the P2P Marketplace demo. Implements RFC-004
 * (rfcs/RFC-004-negotiation-state-machine.md): `NegotiationEvent` is the
 * abstraction, `HumanChatChannel` (this file) is one implementation of
 * `NegotiationChannel`, built on the real `pearNodeRegistry` — not a
 * mock transport.
 */
import { prisma } from '../../common/database'
import { NotFoundError } from '../../common/errors'
import { eventBus } from '../../common/events/event-bus'
import { pearNodeRegistry, type PearNode } from '../../infrastructure/p2p/pear.service'
import { tradeRepository, type TradeRepository } from './trade-repository'
import { childLogger } from '../../common/logger'

const log = childLogger('negotiation')

// ─── RFC-004's NegotiationEvent — the actual abstraction ──────────────────────
export type NegotiationEvent =
  | { type: 'OFFER_PROPOSED';    by: string; terms: Record<string, unknown>; at: string }
  | { type: 'COUNTER_OFFERED';   by: string; terms: Record<string, unknown>; at: string }
  | { type: 'TERMS_ACCEPTED';    by: string; at: string }
  | { type: 'TERMS_REJECTED';    by: string; reason?: string; at: string }
  | { type: 'MESSAGE_EXCHANGED'; by: string; content: string; at: string }

// ─── RFC-004's NegotiationChannel — pluggable transport for those events ──────
export interface NegotiationChannel {
  sendEvent(event: NegotiationEvent): Promise<void>
  onEvent(handler: (event: NegotiationEvent) => void): void
}

// ─── HumanChatChannel — today's implementation, over real Pears/HyperDHT ─────
// A future StructuredChannel (agent-to-agent, RFC-004) implements the exact
// same NegotiationChannel interface — this class proves the interface is
// real by being a genuine, non-mock implementation of it.
export class HumanChatChannel implements NegotiationChannel {
  constructor(
    private readonly localUserId: string,
    private readonly remoteUserId: string,
    private readonly tradeId: string
  ) {}

  async sendEvent(event: NegotiationEvent): Promise<void> {
    const node = pearNodeRegistry.get(this.localUserId)
    if (!node) {
      throw new NotFoundError('P2P connection for this user (call POST /v1/peers/start first)', this.localUserId)
    }
    const delivered = node.sendToPeer(this.remoteUserId, {
      kind: 'negotiation_event',
      tradeId: this.tradeId,
      event,
    })
    // RFC-002's amendment: the protocol never assumes continuous
    // connectivity. A failed send is persisted for redelivery — not
    // silently dropped, and not treated as a hard failure.
    await persistNegotiationEvent(this.tradeId, this.localUserId, event)
    if (!delivered) {
      log.warn({ remoteUserId: this.remoteUserId }, '[Negotiation] not connected — event persisted, will be visible on their next sync')
    }
  }

  // Gap fix (TODO.md §1 / BACKLOG.md's Transport Provider row): this used
  // to filter incoming messages on `tradeId` alone, trusting whatever
  // `message.event` claimed without checking who actually sent the raw
  // bytes. Now mirrors the trust model pear.service.ts's own
  // `verifyHandshakeIdentity()` already established for HANDSHAKE: a
  // `peerId` is only meaningful once it's the one `userPeerMap` recorded
  // for `remoteUserId` after a verified handshake — not merely a claim
  // inside the message payload. Wiring this handler up at all (nobody
  // called `onEvent()` anywhere before this pass — see
  // `wireInboundNegotiationChannel` below) is the actual gap; this
  // check is what makes wiring it safe to do.
  onEvent(handler: (event: NegotiationEvent) => void): void {
    const node = pearNodeRegistry.get(this.localUserId)
    if (!node) {
      throw new NotFoundError('P2P connection for this user (call POST /v1/peers/start first)', this.localUserId)
    }
    node.on('message', ({ peerId, message }: { peerId: string; message: any }) => {
      if (message?.kind !== 'negotiation_event' || message.tradeId !== this.tradeId) return
      if (node.getConnectedPeerId(this.remoteUserId) !== peerId) return
      handler(message.event as NegotiationEvent)
    })
  }
}

// Shared by sendEvent() (the outbound side, always persisted so a failed
// P2P send is never silently dropped — RFC-002's amendment) and
// wireInboundNegotiationChannel() below (the inbound side, for a
// counterparty this process has no other way of learning about this
// event from). `senderId` is taken from the caller, never trusted from
// inside `event` itself — sendEvent() already didn't trust it (used
// `this.localUserId`), and the inbound path now applies the same rule
// using the handshake-verified `remoteUserId` instead of the event's
// self-reported `by` field.
async function persistNegotiationEvent(tradeId: string, senderId: string, event: NegotiationEvent) {
  const content = event.type === 'MESSAGE_EXCHANGED' ? event.content : JSON.stringify(event)
  const message = await prisma.message.create({
    data: {
      tradeId,
      senderId,
      content,
      msgType: event.type === 'MESSAGE_EXCHANGED' ? 'TEXT' : 'SYSTEM',
    },
  })
  // messageId used to be a placeholder equal to tradeId — the created
  // row was discarded (await ... with no assignment). Fixed as part of
  // the chat-unification pass: every message now has its own real id,
  // which matters once WS clients are keying NEW_MESSAGE pushes by it
  // regardless of which transport the message actually arrived on.
  await eventBus.emit('openp2p.message.sent', {
    messageId: message.id,
    tradeId,
    senderId,
    content,
    msgType: event.type,
    timestamp: message.createdAt.toISOString(),
  }, tradeId)   // correlationId (RFC-010)
  await eventBus.emit('negotiation.event_received', { tradeId, eventType: event.type }, tradeId)
  return message
}

// Tracks which trades already have an inbound listener attached per
// PearNode instance. HumanChatChannel.onEvent() attaches a listener to
// the node's underlying EventEmitter with no removal path, so calling it
// again on every JOIN_TRADE (e.g. a WS reconnect, or rejoining the same
// trade room twice) would stack duplicate listeners and double-persist
// every inbound event. Keyed by the PearNode *instance* rather than just
// userId+tradeId so that stopping and restarting a user's node
// (pear.routes.ts's /v1/peers/stop then /start again — PearNodeRegistry
// hands out a brand new PearNode on restart) re-wires against the new
// instance instead of being silently skipped as "already wired" against
// an instance nothing points to anymore. A WeakMap lets the old
// instance's entry be collected once nothing else references it.
const wiredInboundTradesByNode = new WeakMap<PearNode, Set<string>>()

// The actual consumer `HumanChatChannel.onEvent()` was missing entirely
// (chat.routes.ts's own doc comment flagged this: "incoming Pears
// messages have no consumer at all today"). Wired here rather than at
// `/v1/peers/start` time because this is the first point a specific
// (participant, trade) pair is known together — chat.routes.ts's
// JOIN_TRADE handler already resolves both.
//
// Today's reference deployment runs one process / one shared Postgres
// for every user (pear.service.ts's PearNodeRegistry docstring), so when
// `counterpartyId` also has a node in *this same* registry, their own
// `sendEvent()` call already persisted this Message and pushed it over
// the shared eventBus/WS — consuming the P2P copy too would double it.
// This only actually does anything once two independent Sails
// deployments (separate processes, separate Postgres, talking only over
// the wire) exist — which isn't how this repo runs today — so the
// no-op branch here can be exercised in tests, but the live wire-format
// round trip between two real, separate HyperDHT nodes still needs that
// infrastructure to verify end-to-end.
export function wireInboundNegotiationChannel(participantId: string, counterpartyId: string, tradeId: string): void {
  const node = pearNodeRegistry.get(participantId)
  if (!node) return

  let wiredTrades = wiredInboundTradesByNode.get(node)
  if (!wiredTrades) {
    wiredTrades = new Set()
    wiredInboundTradesByNode.set(node, wiredTrades)
  }
  if (wiredTrades.has(tradeId)) return
  wiredTrades.add(tradeId)

  const channel = new HumanChatChannel(participantId, counterpartyId, tradeId)
  channel.onEvent((event) => {
    if (pearNodeRegistry.get(counterpartyId)) return
    persistNegotiationEvent(tradeId, counterpartyId, event).catch((err) =>
      log.error({ err, tradeId }, '[Negotiation] Failed to persist inbound P2P event')
    )
  })
}

// ─── Negotiation state — PROTOCOL_SPECIFICATION.md §1.4, refined v8.7 ────────
export type NegotiationStatus = 'CREATED' | 'NEGOTIATING' | 'TERMS_AGREED' | 'ABANDONED'

export class NegotiationService {
  private status = new Map<string, NegotiationStatus>()

  constructor(private readonly tradeRepo: TradeRepository = tradeRepository) {}

  async open(tradeId: string, buyerId: string, sellerId: string): Promise<HumanChatChannel> {
    const trade = await this.tradeRepo.findById(tradeId)
    if (!trade) throw new NotFoundError('Trade', tradeId)

    this.status.set(tradeId, 'CREATED')
    await eventBus.emit('negotiation.opened', { tradeId, buyerId, sellerId }, tradeId)
    await eventBus.emit('openp2p.trade.status_changed', {
      tradeId, from: 'PENDING', to: 'NEGOTIATING', triggeredBy: buyerId,
    }, tradeId)
    this.status.set(tradeId, 'NEGOTIATING')

    // Both directions — buyer's view of the channel and seller's view are
    // two separate HumanChatChannel instances pointed at each other.
    return new HumanChatChannel(buyerId, sellerId, tradeId)
  }

  /**
   * #235 R7H-NF-E3C-5 — the in-memory status of a negotiation whose `negotiation.opened` / status_changed events were
   * already committed with the trade (atomic admission, trade-repository.ts). open() is not called for it any more:
   * this only restores the status cache open() used to set, after COMMIT. Non-authoritative by construction.
   */
  markOpened(tradeId: string): void {
    this.status.set(tradeId, 'NEGOTIATING')
  }

  getStatus(tradeId: string): NegotiationStatus {
    return this.status.get(tradeId) ?? 'CREATED'
  }

  async markAgreed(tradeId: string): Promise<void> {
    // Boundary held per the v8.7 revision note: this stops at TERMS_AGREED.
    // AwaitingSettlement/Settled/Completed are Settlement's states
    // (escrow.service.ts), not Negotiation's — see
    // PROTOCOL_SPECIFICATION.md §3.1 for why that line is deliberate.
    this.status.set(tradeId, 'TERMS_AGREED')
    await eventBus.emit('negotiation.terms_agreed', { tradeId }, tradeId)
  }
}

export const negotiationService = new NegotiationService()
