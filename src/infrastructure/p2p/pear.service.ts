/**
 * Sails Protocol — Infrastructure Layer: P2P Transport (Pears / HyperDHT)
 *
 * MOVED from src/modules/identity/pear.service.ts (see prior review pass
 * for the Domain/Infrastructure boundary fix).
 *
 * DECISION RESOLVED (this pass): the previous version had `PearPeerManager`
 * as a single process-wide singleton, but `start(userId, ...)` implied
 * multi-user support — a second call silently clobbered the first user's
 * node. Fixed by splitting responsibilities:
 *
 *   PearNode           → one DHT node for ONE user (was PearPeerManager).
 *                        Pure instance, no static/singleton state.
 *   PearNodeRegistry   → owns a Map<userId, PearNode>. This is the
 *                        singleton — there's exactly one registry per
 *                        server process, and it hands out/reuses one
 *                        PearNode per active user.
 *
 * Route handlers should depend on `pearNodeRegistry`, never construct a
 * `PearNode` directly. This makes "one DHT identity per user, N users per
 * process" the enforced shape instead of an accidental one.
 */

import HyperDHT from 'hyperdht'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import { createHash } from 'crypto'
import { EventEmitter } from 'events'
import { eventBus } from '../../common/events/event-bus'
import { prisma } from '../../common/database'
import { config } from '../../config'
import { childLogger } from '../../common/logger'
import { loadOrCreateParticipantTransportIdentitySeed } from './participant-transport-identity'

const log = childLogger('pear')

// ─── Types ────────────────────────────────────────────────────────────────────
export interface PearPeer {
  userId: string
  publicKey: string
  peerId: string
  connection?: unknown
  connectedAt: Date
}

// ─── Topic derivation ─────────────────────────────────────────────────────────
export function deriveTopic(name: string): Buffer {
  return createHash('sha256').update(`sails:v1:${name}`).digest()
}

// Security fix (Fase 1 Red Team review, Task 2's real finding —
// "reconciliation poisoning" turned out to live here, not in
// ReconciliationService — see tests/reconciliation-poisoning.test.ts's
// header comment). Extracted as a standalone function (not inlined in
// handleNewConnection() below) specifically so it's unit-testable —
// handleNewConnection() itself needs a real Hyperswarm connection object
// and can't be, the same limitation this file's own PearNode already has
// throughout ("cannot be verified without a live network").
//
// `remotePeerId` is the only cryptographically real part of an incoming
// P2P connection (HyperDHT's own Noise-handshake public key) —
// `claimedUserId` (the HANDSHAKE message's own `userId` field) is just a
// claim the connecting peer makes about themselves. Before this fix,
// that claim was trusted outright: any peer could bind an arbitrary
// userId to their real connection in `userPeerMap`, hijacking
// sendToPeer() delivery meant for whoever they claimed to be, and
// poisoning reconcilePeerPair() via the peer.connected event that
// followed. Verified here against the same `User.peerId` Postgres
// already records the moment a legitimate node's own start() call
// succeeds (below) — a claimed userId whose real peerId doesn't match
// this connection's actual remotePeerId is not a legitimate identity
// claim for this connection.
export async function verifyHandshakeIdentity(claimedUserId: unknown, remotePeerId: string): Promise<boolean> {
  if (typeof claimedUserId !== 'string' || !claimedUserId) return false
  const claimedUser = await prisma.user.findUnique({ where: { id: claimedUserId }, select: { peerId: true } })
  return claimedUser?.peerId === remotePeerId
}

export const TOPICS = {
  marketplace: deriveTopic('marketplace'),
  btc: deriveTopic('offers:BTC'),
  lnBtc: deriveTopic('offers:LN_BTC'),
  liquidBtc: deriveTopic('offers:LIQUID_BTC'),
  usdtErc20: deriveTopic('offers:USDT_ERC20'),
  usdtLiquid: deriveTopic('offers:USDT_LIQUID'),
  trade: (tradeId: string) => deriveTopic(`trade:${tradeId}`),
} as const

// ─── PearNode — one DHT node for ONE user. No singleton state. ────────────────
export class PearNode extends EventEmitter {
  private dht: InstanceType<typeof HyperDHT> | null = null
  private swarm: InstanceType<typeof Hyperswarm> | null = null
  private peers = new Map<string, PearPeer>()
  private userPeerMap = new Map<string, string>()
  private topicAnnouncements = new Set<string>()
  private keyPair: { publicKey: Buffer; secretKey: Buffer } | null = null
  private isStarted = false

  constructor(private readonly ownerUserId: string) {
    super()
  }

  // Key-custody fix (2026-08-09, project-owner decision, docs/TODO.md's
  // own "as chaves privadas do usuário podem ser consultadas?" item) —
  // this used to take the caller's raw Ed25519 secret key over the wire
  // (HTTP request body) and hand it straight to HyperDHT/Hyperswarm.
  // That secret key never left this server's memory afterward (no
  // logging, no persistence — only the derived public peerId went to
  // Postgres), but it DID transit the network on this one call, an
  // avoidable exposure this reference implementation doesn't need: the
  // server already runs this node, so it can generate its own
  // identity instead of receiving one. HyperDHT.keyPair()
  // (the library's own generator, not hand-rolled) produces the exact
  // shape HyperDHT/Hyperswarm's own `keyPair` constructor option expects
  // — used directly, not sliced apart, unlike the old client-supplied
  // path this replaces. Full production custody (the P2P node running
  // entirely client-side, server never involved at all) stays real,
  // separate future work — see this same TODO.md item's own note on
  // that larger design.
  //
  // ADR-001 §7.2, Persistent Participant Transport Identity (2026-09-09,
  // renamed from "Persistent Node Identity" in a CTO Gate B correction —
  // see `participant-transport-identity.ts`'s own header comment for the
  // full rationale). Previously `HyperDHT.keyPair()` was called with no
  // argument here, generating a brand-new, unrelated keypair on every
  // call — meaning every ordinary server restart (this class holds all
  // state in process memory only) produced a different `peerId` for this
  // `ownerUserId`, confirmed directly to violate ADR-001 §7's own frozen
  // property ("a Sails Node participating in network discovery must have
  // a stable operational identity across ordinary restarts") as it
  // applies to this participant's own transport identity.
  // `loadOrCreateParticipantTransportIdentitySeed()` now supplies a
  // persisted 32-byte seed — the exact input `HyperDHT.keyPair(seed)`
  // uses for its own OFFICIAL, deterministic Ed25519 derivation
  // (confirmed directly against `hyperdht`'s real source) — so an
  // ordinary restart reloads the identical seed and reproduces the
  // identical keypair. This is strictly additive to this method's own
  // pre-existing custody model: the secret this now persists is the SAME
  // one this method already generated and held in server memory before
  // this change; nothing that wasn't already server-held is newly
  // exposed.
  async start(): Promise<string> {
    if (this.isStarted) return this.keyPair!.publicKey.toString('hex')

    const seed = await loadOrCreateParticipantTransportIdentitySeed(this.ownerUserId)
    const keyPair = HyperDHT.keyPair(seed)
    this.keyPair = keyPair

    this.dht = new HyperDHT({
      keyPair,
      bootstrap:
        config.pear.bootstrapNodes.length > 0
          ? config.pear.bootstrapNodes.map((addr) => {
              const [host, port] = addr.split(':')
              return { host, port: parseInt(port || '49737') }
            })
          : undefined,
    })

    this.swarm = new Hyperswarm({ dht: this.dht, keyPair })
    this.swarm.on('connection', (conn: unknown, info: unknown) => {
      this.handleNewConnection(conn, info)
    })

    this.isStarted = true
    const peerId = keyPair.publicKey.toString('hex')

    await prisma.user.update({ where: { id: this.ownerUserId }, data: { peerId } })
    await this.joinTopic('marketplace')

    // correlationId = userId (RFC-010) — no trade to correlate a connectivity
    // event to; userId is the most specific trace identifier available.
    await eventBus.emit('peer.connected', { userId: this.ownerUserId, peerId, publicKey: peerId }, this.ownerUserId)
    log.info({ msg: 'Node started', ownerUserId: this.ownerUserId, peerId })
    return peerId
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return

    await this.swarm?.destroy()
    await this.dht?.destroy()

    this.isStarted = false
    this.peers.clear()
    this.topicAnnouncements.clear()

    await eventBus.emit('peer.disconnected', {
      userId: this.ownerUserId,
      peerId: this.keyPair?.publicKey.toString('hex') ?? '',
    }, this.ownerUserId)   // correlationId = userId (RFC-010)
    log.info({ msg: 'Node stopped', ownerUserId: this.ownerUserId })
  }

  async joinTopic(topicName: string): Promise<void> {
    if (!this.swarm) throw new Error('Swarm not started')
    if (this.topicAnnouncements.has(topicName)) return

    const topicKey = TOPICS[topicName as keyof typeof TOPICS]
    if (!topicKey || typeof topicKey === 'function') {
      throw new Error(`Unknown static topic: ${topicName}`)
    }

    const discovery = this.swarm.join(topicKey as Buffer, { server: true, client: true })
    await discovery.flushed()
    this.topicAnnouncements.add(topicName)
    log.info({ msg: 'Joined topic', ownerUserId: this.ownerUserId, topicName, peerCount: this.peers.size })
  }

  async joinTradeTopic(tradeId: string): Promise<void> {
    if (!this.swarm) throw new Error('Swarm not started')
    const topicKey = TOPICS.trade(tradeId)
    const topicName = `trade:${tradeId}`
    if (this.topicAnnouncements.has(topicName)) return

    const discovery = this.swarm.join(topicKey, { server: true, client: true })
    await discovery.flushed()
    this.topicAnnouncements.add(topicName)
    log.info({ msg: 'Joined trade topic', ownerUserId: this.ownerUserId, tradeId })
  }

  async leaveTradeTopic(tradeId: string): Promise<void> {
    if (!this.swarm) return
    await this.swarm.leave(TOPICS.trade(tradeId))
    this.topicAnnouncements.delete(`trade:${tradeId}`)
  }

  // Only handles the generic HANDSHAKE (peer identification). Higher-level
  // message types (chat/negotiation, offer announcements) are the
  // responsibility of OpenP2P / OpenLiquidity — they subscribe via the
  // `message` event this class emits, rather than this class special-casing
  // their payload shapes.
  private handleNewConnection(conn: unknown, info: unknown) {
    const socket = conn as any
    const peerInfo = info as any
    const remotePeerId: string = peerInfo?.publicKey ? b4a.toString(peerInfo.publicKey, 'hex') : 'unknown'

    log.info({ msg: 'New connection', ownerUserId: this.ownerUserId, remotePeerId })
    socket.write(JSON.stringify({ type: 'HANDSHAKE', userId: this.ownerUserId }))

    socket.on('data', async (data: Buffer) => {
      let msg: any
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }

      if (msg.type === 'HANDSHAKE') {
        // See verifyHandshakeIdentity()'s doc comment above for the full
        // explanation — an unidentified connection is left open, not
        // closed outright (RFC-002's "never assumes continuous
        // connectivity" — a mismatch isn't inherently hostile, e.g. a
        // client mid-way through its own start() sequence), it's simply
        // never registered as the identity it claimed.
        const verified = await verifyHandshakeIdentity(msg.userId, remotePeerId)
        if (!verified) {
          log.warn({
            msg: 'HANDSHAKE identity mismatch — claim ignored, not registered in userPeerMap, no peer.connected emitted',
            ownerUserId: this.ownerUserId,
            remotePeerId,
            claimedUserId: typeof msg.userId === 'string' ? msg.userId : String(msg.userId),
          })
          return
        }

        const peer: PearPeer = {
          userId: msg.userId,
          publicKey: remotePeerId,
          peerId: remotePeerId,
          connection: conn,
          connectedAt: new Date(),
        }
        this.peers.set(remotePeerId, peer)
        this.userPeerMap.set(msg.userId, remotePeerId)
        log.info({ msg: 'Peer identified', ownerUserId: this.ownerUserId, remoteUserId: msg.userId, remotePeerId })
        // correlationId = userId (RFC-010). localUserId (RFC-011) is set
        // here — this is a real two-party handshake, unlike the
        // self-node-start peer.connected above — so handlers.ts can look up
        // shared active trades between these two specific users and
        // reconcile them. Not awaited — this is a plain (non-async) socket
        // callback, matching the fire-and-forget pattern eventBus.on()
        // already uses for its own async listener errors.
        eventBus.emit(
          'peer.connected',
          { userId: msg.userId, peerId: remotePeerId, publicKey: remotePeerId, localUserId: this.ownerUserId },
          msg.userId
        ).catch((err) => log.error({ msg: 'Failed to publish peer.connected', ownerUserId: this.ownerUserId, err: err.message }))
        return
      }

      // Negotiation messages (chat, payment proof, offer announcements) are
      // forwarded here — OpenP2P's chat module and OpenLiquidity's discovery
      // module attach listeners to this instance instead of this class
      // knowing their payload shapes.
      this.emit('message', { peerId: remotePeerId, message: msg })
    })

    socket.on('close', () => {
      const peer = this.peers.get(remotePeerId)
      if (peer) {
        this.peers.delete(remotePeerId)
        this.userPeerMap.delete(peer.userId)
        eventBus.emit('peer.disconnected', { userId: peer.userId, peerId: remotePeerId }, peer.userId)   // correlationId = userId (RFC-010)
          .catch((err) => log.error({ msg: 'Failed to publish peer.disconnected', ownerUserId: this.ownerUserId, err: err.message }))
      }
    })

    socket.on('error', (err: Error) => {
      log.error({ msg: 'Connection error', ownerUserId: this.ownerUserId, remotePeerId, err: err.message })
    })
  }

  broadcast(payload: Record<string, unknown>): number {
    if (!this.isStarted) return 0
    const msg = JSON.stringify(payload)
    let sent = 0
    for (const [, peer] of this.peers) {
      try {
        const socket = peer.connection as any
        if (socket?.writable) {
          socket.write(msg)
          sent++
        }
      } catch {
        // skip dead connections
      }
    }
    return sent
  }

  sendToPeer(userId: string, payload: Record<string, unknown>): boolean {
    const peerId = this.userPeerMap.get(userId)
    if (!peerId) return false
    const peer = this.peers.get(peerId)
    if (!peer) return false

    try {
      ;(peer.connection as any).write(JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }

  getStatus() {
    return {
      userId: this.ownerUserId,
      started: this.isStarted,
      peerId: this.keyPair?.publicKey.toString('hex') ?? null,
      connectedPeers: this.peers.size,
      activeTopics: Array.from(this.topicAnnouncements),
      peers: Array.from(this.peers.values()).map((p) => ({
        userId: p.userId,
        peerId: p.peerId.slice(0, 16) + '...',
        connectedAt: p.connectedAt,
      })),
    }
  }

  isRunning(): boolean {
    return this.isStarted
  }

  // This node's own real Ed25519 identity keypair (HyperDHT.keyPair()'s
  // output shape) — payload-crypto.ts's decryptFromPeer() needs it to open
  // a sealed box addressed to this node. Never exposes the connection
  // object or anything beyond the keypair itself.
  getKeyPair(): { publicKey: Buffer; secretKey: Buffer } | null {
    return this.keyPair
  }

  // The Ed25519 public key (hex) of a peer this node has already directly
  // handshaked with over Hyperswarm — the strongest source for
  // "encrypt for this specific peer" since it's proven reachable, not just
  // looked up from a directory. Returns undefined if no handshake with
  // this userId has completed yet (transport-provider.ts falls back to the
  // Postgres-stored `User.peerId` directory in that case).
  getConnectedPeerId(userId: string): string | undefined {
    return this.userPeerMap.get(userId)
  }
}

// ─── PearNodeRegistry — the ONE process-wide singleton ────────────────────────
// Owns exactly one PearNode per active userId. This is what makes "many
// users, one server process" correct: two users calling start() concurrently
// get two independent DHT nodes instead of clobbering a shared one.
class PearNodeRegistry {
  private nodes = new Map<string, PearNode>()

  async start(userId: string): Promise<string> {
    let node = this.nodes.get(userId)
    if (!node) {
      node = new PearNode(userId)
      this.nodes.set(userId, node)
    }
    return node.start()
  }

  async stop(userId: string): Promise<void> {
    const node = this.nodes.get(userId)
    if (!node) return
    await node.stop()
    this.nodes.delete(userId)
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.nodes.values()).map((n) => n.stop()))
    this.nodes.clear()
  }

  get(userId: string): PearNode | undefined {
    return this.nodes.get(userId)
  }

  isRunning(userId: string): boolean {
    return this.nodes.get(userId)?.isRunning() ?? false
  }

  getStatus(userId: string) {
    return (
      this.nodes.get(userId)?.getStatus() ?? {
        userId,
        started: false,
        peerId: null,
        connectedPeers: 0,
        activeTopics: [],
        peers: [],
      }
    )
  }

  activeCount(): number {
    return this.nodes.size
  }
}

// Singleton — exactly one registry per server process. Route handlers import
// this, never PearNode directly.
export const pearNodeRegistry = new PearNodeRegistry()
