/**
 * TransportProvider — Sails Protocol Infrastructure Layer
 * RFC-002 (rfcs/RFC-002-transport-provider.md), PROTOCOL_SPECIFICATION.md §4B
 *
 * The Core never knows what WebSocket or HyperDHT is — it knows only this
 * interface. `PearsTransportProvider` wraps the existing `pearNodeRegistry`/
 * `PearNode` with zero behavioral change (RFC-002's own Reference
 * Implementation Plan). `FallbackTransportProvider`
 * (03-implementation_plan.md, section 3) composes it with
 * `WebSocketRelayTransportProvider` — Pears first, WebSocket relay only if
 * Pears doesn't connect within a timeout.
 *
 * Reconciled against RFC-002's literal interface in two places, both
 * because the underlying types RFC-002 referenced don't exist as code yet:
 * - `start(participant: Participant)` → `start(participantId: string)`.
 * `Participant` (RFC-001) has no TypeScript interface anywhere in this
 * codebase yet (still doc-only, PROTOCOL_SPECIFICATION.md §1.1) — every
 * other file in this codebase (Intent.participantId, Claim.claimedBy, etc.)
 * already uses a plain string id in its place, per DATABASE.md's own
 * documented convention. Adopting the full `Participant` object here would
 * be inventing a dependency this file alone would need, not applying an
 * existing one.
 * - `PeerHandle` is given a concrete minimal shape (`{ peerId: string }`)
 * since RFC-002 named the return type without defining its fields.
 *
 * `PearsTransportProvider.sendIntentToPeer()` (added alongside this note)
 * is a deliberate, documented extension beyond the shared `TransportProvider`
 * interface, not a change to it — RFC-002's own Backward Compatibility
 * section already scopes this file to "existing, unchanged behavior" for
 * the interface; encryption is keyed to a real HyperDHT/Hyperswarm Ed25519
 * identity (payload-crypto.ts), which `WebSocketRelayTransportProvider` has
 * no equivalent of, so this capability is Pears-specific by construction,
 * not something `FallbackTransportProvider` needs to arbitrate between.
 */
import { pearNodeRegistry } from './pear.service'
import { prisma } from '../../common/database'
import { encryptForPeer } from './payload-crypto'
import { webSocketRelayTransportProvider } from './websocket-relay.service'
import { childLogger } from '../../common/logger'

const log = childLogger('transport-provider')

export interface PeerHandle {
  peerId: string
}

export interface TransportProvider {
  name: string
  // No longer takes a caller-supplied secret key (2026-08-09 key-custody
  // fix, pear.service.ts's own PearNode.start() doc comment has the full
  // reasoning) — each implementer is responsible for its own identity
  // material, if any.
  start(participantId: string): Promise<PeerHandle>
  stop(participantId: string): Promise<void>
  joinTopic(participantId: string, topic: string): Promise<void>
  broadcast(participantId: string, payload: unknown): Promise<number>
  sendToPeer(participantId: string, targetParticipantId: string, payload: unknown): Promise<boolean>
  onMessage(participantId: string, handler: (peerId: string, payload: unknown) => void): void
  isConnected(participantId: string): boolean
}

// ─── PearsTransportProvider — wraps pearNodeRegistry, zero behavioral change ──
export class PearsTransportProvider implements TransportProvider {
  name = 'pears'

  async start(participantId: string): Promise<PeerHandle> {
    const peerId = await pearNodeRegistry.start(participantId)
    return { peerId }
  }

  async stop(participantId: string): Promise<void> {
    await pearNodeRegistry.stop(participantId)
  }

  async joinTopic(participantId: string, topic: string): Promise<void> {
    const node = pearNodeRegistry.get(participantId)
    if (!node) throw new Error(`PearsTransportProvider: no active node for ${participantId} — call start() first`)
    await node.joinTopic(topic)
  }

  async broadcast(participantId: string, payload: unknown): Promise<number> {
    const node = pearNodeRegistry.get(participantId)
    if (!node) return 0
    return node.broadcast(payload as Record<string, unknown>)
  }

  async sendToPeer(participantId: string, targetParticipantId: string, payload: unknown): Promise<boolean> {
    const node = pearNodeRegistry.get(participantId)
    if (!node) return false
    // TransportProvider never assumes continuous connectivity (RFC-002
    // v8.7 amendment) — a `false` return here is a normal, expected
    // outcome, not an error the caller needs to catch.
    return node.sendToPeer(targetParticipantId, payload as Record<string, unknown>)
  }

  onMessage(participantId: string, handler: (peerId: string, payload: unknown) => void): void {
    const node = pearNodeRegistry.get(participantId)
    if (!node) throw new Error(`PearsTransportProvider: no active node for ${participantId} — call start() first`)
    node.on('message', ({ peerId, message }: { peerId: string; message: unknown }) => {
      handler(peerId, message)
    })
  }

  isConnected(participantId: string): boolean {
    return pearNodeRegistry.isRunning(participantId)
  }

  // Direct, encrypted, server-free Intent delivery: the sending
  // participant's node joins the trade-scoped topic (`PearNode.joinTradeTopic`,
  // real Hyperswarm/HyperDHT discovery — the DHT + swarm perform NAT
  // hole-punching automatically as part of `swarm.join(topic,
  // {server:true, client:true})`; no separate "listen for hole-punching"
  // step exists or is needed in the Hyperswarm API), resolves the
  // recipient's real Ed25519 identity key, encrypts the Intent payload so
  // only that key can read it (payload-crypto.ts), and hands the
  // ciphertext to sendToPeer — which travels over the direct Hyperswarm
  // connection between these two specific nodes. No Postgres write is
  // required for the delivery itself; `intentEngine.create()` already
  // persisted the Intent for durability/audit (RFC-008's hash-chained
  // IntentEvent) before this is ever called — that's a separate concern
  // (audit trail) from this one (real-time handoff to the counterparty),
  // not a substitute for it.
  async sendIntentToPeer(
    participantId: string,
    targetParticipantId: string,
    intent: unknown,
    tradeId: string
  ): Promise<boolean> {
    const node = pearNodeRegistry.get(participantId)
    if (!node) {
      throw new Error(`PearsTransportProvider: no active node for ${participantId} — call start() first`)
    }

    await node.joinTradeTopic(tradeId)

    // Prefer a peerId proven reachable by an already-completed handshake;
    // fall back to the Postgres-stored `User.peerId` directory (written by
    // PearNode.start() the first time that user ever started a node) —
    // this is a public-key lookup, not a stand-in for the P2P delivery
    // itself, the same role a known_hosts file or DNS TXT record plays
    // for other systems. If neither resolves, there is no key to encrypt
    // against and no meaningful way to proceed.
    const targetPeerId =
      node.getConnectedPeerId(targetParticipantId) ??
      (await prisma.user.findUnique({ where: { id: targetParticipantId } }))?.peerId

    if (!targetPeerId) {
      return false
    }

    const ciphertext = encryptForPeer(intent, targetPeerId)
    // never assumes continuous connectivity (RFC-002 v8.7 amendment) —
    // `false` here is `sendToPeer`'s normal "not currently reachable"
    // outcome, not an error the caller needs to catch.
    return node.sendToPeer(targetParticipantId, { type: 'INTENT', ciphertext })
  }
}

export const pearsTransportProvider = new PearsTransportProvider()

// ─── FallbackTransportProvider — Pears first, WebSocket relay on timeout ─────
// 03-implementation_plan.md section 3: pear.service gets a connection
// timeout; websocket-relay activates only once that timeout is exhausted.
// Implemented here (racing PearsTransportProvider.start() against a timer)
// rather than inside pear.service.ts's own DHT bootstrap code — same
// user-visible behavior, without touching HyperDHT/Hyperswarm internals
// that have no way to be verified against live network conditions in this
// environment. Core depends on this composite, never on either transport
// directly, per RFC-002.
const DEFAULT_FALLBACK_TIMEOUT_MS = 5000

export class FallbackTransportProvider implements TransportProvider {
  name = 'fallback(pears→websocket-relay)'
  private activeProvider = new Map<string, TransportProvider>()
  private startGeneration = new Map<string, number>()

  constructor(
    private readonly primary: TransportProvider,
    private readonly secondary: TransportProvider,
    private readonly timeoutMs: number = DEFAULT_FALLBACK_TIMEOUT_MS
  ) {}

  async start(participantId: string): Promise<PeerHandle> {
    const generation = (this.startGeneration.get(participantId) ?? 0) + 1
    this.startGeneration.set(participantId, generation)
    const primaryStart = this.primary.start(participantId)
    let timedOut = false
    try {
      const handle = await this.withTimeout(primaryStart, this.timeoutMs, () => { timedOut = true })
      if (this.startGeneration.get(participantId) !== generation) {
        throw new Error(`FallbackTransportProvider: obsolete primary start for ${participantId}`)
      }
      this.activeProvider.set(participantId, this.primary)
      return handle
    } catch (err) {
      if (this.startGeneration.get(participantId) !== generation) throw err
      log.warn(
        { primary: this.primary.name, secondary: this.secondary.name, participantId, timeoutMs: this.timeoutMs, err: err instanceof Error ? err.message : err },
        '[FallbackTransportProvider] primary did not connect in time — falling back'
      )
      // Register late-primary cleanup only after relay is active, so a Pears
      // completion while secondary.start() is pending cannot escape cleanup.
      const handle = await this.secondary.start(participantId)
      if (this.startGeneration.get(participantId) !== generation) {
        // The secondary has already started but another start/stop superseded
        // this attempt. Do not stop it here: providers are keyed by participant,
        // and stop() could tear down the newer session. Surface the race until
        // per-attempt resource ownership is available.
        log.warn({ participantId, generation },
          '[FallbackTransportProvider] obsolete relay start completed; cleanup requires per-attempt ownership')
        throw new Error(`FallbackTransportProvider: obsolete relay start for ${participantId}`)
      } else {
        this.activeProvider.set(participantId, this.secondary)
      }
      if (timedOut) {
        void primaryStart.then(async () => {
          if (this.startGeneration.get(participantId) === generation &&
              this.activeProvider.get(participantId) === this.secondary) {
            await this.primary.stop(participantId)
          }
        }).catch(cleanupErr => {
          log.warn({ participantId, err: cleanupErr instanceof Error ? cleanupErr.message : cleanupErr },
            '[FallbackTransportProvider] late primary cleanup failed')
        })
      }
      return handle
    }
  }

  private provider(participantId: string): TransportProvider {
    return this.activeProvider.get(participantId) ?? this.primary
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { onTimeout?.(); reject(new Error(`timed out after ${ms}ms`)) }, ms)
      promise.then(
        (value) => { clearTimeout(timer); resolve(value) },
        (err) => { clearTimeout(timer); reject(err) }
      )
    })
  }

  async stop(participantId: string): Promise<void> {
    const generation = (this.startGeneration.get(participantId) ?? 0) + 1
    this.startGeneration.set(participantId, generation)
    await this.provider(participantId).stop(participantId)
    if (this.startGeneration.get(participantId) === generation) this.activeProvider.delete(participantId)
  }

  async joinTopic(participantId: string, topic: string): Promise<void> {
    await this.provider(participantId).joinTopic(participantId, topic)
  }

  async broadcast(participantId: string, payload: unknown): Promise<number> {
    return this.provider(participantId).broadcast(participantId, payload)
  }

  async sendToPeer(participantId: string, targetParticipantId: string, payload: unknown): Promise<boolean> {
    return this.provider(participantId).sendToPeer(participantId, targetParticipantId, payload)
  }

  onMessage(participantId: string, handler: (peerId: string, payload: unknown) => void): void {
    this.provider(participantId).onMessage(participantId, handler)
  }

  isConnected(participantId: string): boolean {
    return this.provider(participantId).isConnected(participantId)
  }

  // Which transport actually won the race for this participant — surfaced
  // to callers (pear.routes.ts's /v1/peers/start response) so a client can
  // show a degraded-connectivity state when Pears didn't connect in time.
  // Falls back to `this.primary.name` before start() has ever been called,
  // matching `provider()`'s own default.
  activeTransportName(participantId: string): string {
    return this.provider(participantId).name
  }
}

// Shared singleton — Pears first, WebSocket relay only if Pears doesn't
// connect within the timeout (03-implementation_plan.md section 3).
// `/v1/peers/start` (pear.routes.ts) is the only current caller; every
// other Pears-specific route (join-trade, broadcast-offer, sendIntentToPeer)
// still depends on `pearNodeRegistry` directly and has no relay equivalent —
// a centralized relay has no concept of a DHT topic, so that gap is
// structural, not an oversight (see this file's class doc above).
export const fallbackTransportProvider = new FallbackTransportProvider(
  pearsTransportProvider,
  webSocketRelayTransportProvider
)
