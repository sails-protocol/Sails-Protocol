/**
 * #307 Phase B — participant-to-participant delivery over the WebSocket relay
 * (Phase B.1: ownership, internal channel and delivery semantics hardened).
 *
 * Contract v1 (client → relay), exactly these keys:
 *   {"v":1,"type":"SEND","id":"<16-64 base64url>","to":"<participantId>","trade":"<tradeId>","body":"<string>"}
 * Relay → recipient:  {"type":"MESSAGE","v":1,"id","from","trade","body"}
 * Relay → sender:     {"type":"SENT","id"} | {"type":"UNDELIVERED","id"}
 *                     | {"type":"REJECTED","id","reason":"MALFORMED"|"DUPLICATE"}
 *
 * Delivery semantics (real, not idealised):
 * - SENT: the recipient's owning instance accepted the write on the
 *   recipient's socket. Not read, not persisted by the client; a socket that
 *   dies right after the write can still lose it.
 * - UNDELIVERED: delivery not confirmed. Either definitely not delivered
 *   (no owner, ownership not proven, recipient instance refused) — the id is
 *   released and may be retried — or ambiguous (the owning instance did not
 *   acknowledge in time): the message MAY have reached the recipient, and the
 *   id stays consumed so a retry with the same id is DUPLICATE. At most once
 *   per (sender, id) within the id window; never exactly-once.
 * - DUPLICATE: this sender already used the id within the window.
 *
 * Ownership: one Redis key per participant, value "<instanceId>|<token>", the
 * token unique per connection. Claimed atomically before READY with a TTL and
 * refreshed by a heartbeat only while the value is still ours; an abrupt
 * process death therefore leaves at most one TTL of stale ownership, during
 * which delivery fails (no live subscriber) rather than misdelivers. A claim
 * that displaces another instance's connection revokes it: that instance
 * closes the old socket. A heartbeat that finds the key changed also closes
 * the local socket. Delivery always resolves the owner from Redis and writes
 * only to the socket whose token matches it — locally too: there is no
 * "the socket is here, deliver anyway" path.
 *
 * Trust model of the internal channel (relay:instance:<id>): Redis pub/sub is
 * NOT authenticated between processes. Frames are strictly validated, deliver
 * frames are deduplicated per request id and expire, acks are accepted only
 * from the instance the request was sent to — but anyone who can write to
 * this Redis can forge deliveries to any connected participant. This is the
 * same trust Redis already holds for sessions and tickets (auth:session:*,
 * auth:ws-ticket:*): Redis must be operationally isolated, reachable only by
 * the relay's own server processes. There is no cryptographic authentication
 * between processes, and this module does not pretend there is.
 *
 * Authorization: sender and recipient are the trade's buyer and seller and
 * the trade is PENDING or ACTIVE. Every other status, known or unknown, is
 * refused pending a CTO decision. Refusals, unknown trades and an offline
 * recipient answer the same UNDELIVERED; a non-party's answer never depends on
 * the recipient's presence. `body` is opaque, never parsed or logged. No
 * offline storage. This module does NOT provide end-to-end encryption.
 *
 * Every Redis or database failure on the sender's path throws; relay.routes.ts
 * closes the socket 1011 (fail closed).
 */
import { randomBytes, randomUUID } from 'crypto'
import type Redis from 'ioredis'

export const RELAY_ENVELOPE_VERSION = 1
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const REF_PATTERN = /^[A-Za-z0-9-]{1,64}$/
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const ENVELOPE_KEYS = ['body', 'id', 'to', 'trade', 'type', 'v']
const AUTHORIZED_TRADE_STATUSES = new Set(['PENDING', 'ACTIVE'])
// A message id may be delivered once per sender within this window.
const MESSAGE_ID_TTL_SECONDS = 600
// Internal frames larger than one client frame plus envelope overhead are not ours.
const MAX_INTERNAL_FRAME_CHARS = 96 * 1024
// Beyond this many in-window deliver ids an instance refuses new ones
// (ack false) rather than grow without bound.
const MAX_SEEN_REQUESTS = 50_000

export interface RelayEnvelope { id: string; to: string; trade: string; body: string }

export interface RelaySocketHost {
  /** True only for an open local socket registered with exactly this token. */
  ownsToken(participantId: string, token: string): boolean
  sendToPeer(fromParticipantId: string, targetParticipantId: string, payload: unknown): Promise<boolean>
  /** Closes the local socket if, and only if, it is still registered with this token. */
  closeIfToken(participantId: string, token: string, code: number, reason: string): void
}

export interface TradeParties { buyerId: string; sellerId: string; status: string }

export interface RelayRouterOptions {
  ownerTtlMs?: number
  remoteAckTimeoutMs?: number
  maxPendingRemote?: number
}

export interface RelayRouterDeps extends RelayRouterOptions {
  redis: Redis
  host: RelaySocketHost
  findTrade(tradeId: string): Promise<TradeParties | null>
  instanceId?: string
}

/** Strict parse; null means MALFORMED. Never throws on client input. */
export function parseRelayEnvelope(raw: string): RelayEnvelope | null {
  const frame = parseObject(raw)
  if (!frame) return null
  const keys = Object.keys(frame).sort()
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((k, i) => k !== ENVELOPE_KEYS[i])) return null
  if (frame.v !== RELAY_ENVELOPE_VERSION || frame.type !== 'SEND') return null
  const { id, to, trade, body } = frame
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null
  if (typeof to !== 'string' || !REF_PATTERN.test(to)) return null
  if (typeof trade !== 'string' || !REF_PATTERN.test(trade)) return null
  if (typeof body !== 'string' || body.length === 0) return null
  return { id, to, trade, body }
}

/** Both ends must be the trade's two parties, on a trade still in progress. */
export function isAuthorizedPair(trade: TradeParties | null, from: string, to: string): boolean {
  if (!trade || from === to || !AUTHORIZED_TRADE_STATUSES.has(trade.status)) return false
  const parties = [trade.buyerId, trade.sellerId]
  return parties.includes(from) && parties.includes(to)
}

function parseObject(raw: string): Record<string, unknown> | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

const ownerKey = (participantId: string) => 'relay:owner:' + participantId
const channelOf = (instanceId: string) => 'relay:instance:' + instanceId
const ownerValue = (instanceId: string, token: string) => instanceId + '|' + token

function splitOwner(value: string | null): { instanceId: string; token: string } | null {
  if (!value) return null
  const at = value.indexOf('|')
  if (at <= 0) return null
  const instanceId = value.slice(0, at)
  const token = value.slice(at + 1)
  return REF_PATTERN.test(instanceId) && TOKEN_PATTERN.test(token) ? { instanceId, token } : null
}

// GET + SET PX in one step: returns the displaced owner value, if any.
const CLAIM_OWNER_SCRIPT = `
local previous = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return previous
`
// Refresh only while the key is still exactly ours.
const REFRESH_OWNER_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0
`
// Delete only while the key is still exactly ours: a newer connection
// elsewhere must not be unregistered by this one's late close.
const RELEASE_OWNER_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`

type DeliverFrame = { kind: 'deliver'; reqId: string; replyTo: string; to: string; token: string; payload: string; deadline: number }
type AckFrame = { kind: 'ack'; reqId: string; from: string; ok: boolean }
type RevokeFrame = { kind: 'revoke'; participant: string; token: string }

export type DeliveryOutcome = 'SENT' | 'NOT_DELIVERED' | 'AMBIGUOUS'

export function parseInternalFrame(raw: string): DeliverFrame | AckFrame | RevokeFrame | null {
  if (raw.length > MAX_INTERNAL_FRAME_CHARS) return null
  const f = parseObject(raw)
  if (!f) return null
  const str = (v: unknown, p: RegExp) => typeof v === 'string' && p.test(v)
  if (f.kind === 'deliver') {
    const keys = Object.keys(f).sort().join(',')
    if (keys !== 'deadline,kind,payload,replyTo,reqId,to,token') return null
    if (!str(f.reqId, REF_PATTERN) || !str(f.replyTo, REF_PATTERN) || !str(f.to, REF_PATTERN)) return null
    if (!str(f.token, TOKEN_PATTERN) || typeof f.payload !== 'string' || !Number.isSafeInteger(f.deadline)) return null
    return f as unknown as DeliverFrame
  }
  if (f.kind === 'ack') {
    if (Object.keys(f).sort().join(',') !== 'from,kind,ok,reqId') return null
    if (!str(f.reqId, REF_PATTERN) || !str(f.from, REF_PATTERN) || typeof f.ok !== 'boolean') return null
    return f as unknown as AckFrame
  }
  if (f.kind === 'revoke') {
    if (Object.keys(f).sort().join(',') !== 'kind,participant,token') return null
    if (!str(f.participant, REF_PATTERN) || !str(f.token, TOKEN_PATTERN)) return null
    return f as unknown as RevokeFrame
  }
  return null
}

export class RelayRouter {
  readonly instanceId: string
  private readonly redis: Redis
  private readonly host: RelaySocketHost
  private readonly findTrade: RelayRouterDeps['findTrade']
  private readonly ownerTtlMs: number
  private readonly remoteAckTimeoutMs: number
  private readonly maxPendingRemote: number
  private subscriber: Redis | null = null
  private subscribing: Promise<Redis> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  /** participantId → token of the local connection this instance claimed for. */
  private readonly claims = new Map<string, string>()
  private readonly pendingAcks = new Map<string, { from: string; settle(outcome: DeliveryOutcome): void }>()
  /** Deliver request ids already handled, until their deadline: internal replay guard. */
  private readonly seenRequests = new Map<string, number>()
  /**
   * Tokens revoked before their socket registered (the revoke raced the
   * READY path): closed the moment they register. Bounded by `claims`.
   */
  private readonly revokedEarly = new Set<string>()

  constructor(deps: RelayRouterDeps) {
    this.redis = deps.redis
    this.host = deps.host
    this.findTrade = deps.findTrade
    this.instanceId = deps.instanceId ?? randomUUID()
    this.ownerTtlMs = deps.ownerTtlMs ?? 30_000
    this.remoteAckTimeoutMs = deps.remoteAckTimeoutMs ?? 3_000
    this.maxPendingRemote = deps.maxPendingRemote ?? 10_000
  }

  // Lazy: an instance subscribes when its first participant registers, so
  // building the app touches no Redis. A failed attempt is retried next time.
  private subscribed(): Promise<Redis> {
    if (!this.subscribing) {
      const subscriber = this.redis.duplicate()
      subscriber.on('message', (_channel: string, message: string) => this.onRemote(message))
      this.subscribing = subscriber.subscribe(channelOf(this.instanceId)).then(
        () => {
          this.subscriber = subscriber
          this.startHeartbeat()
          return subscriber
        },
        error => {
          this.subscribing = null
          subscriber.disconnect()
          throw error
        },
      )
    }
    return this.subscribing
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => void this.refreshClaims(), Math.max(50, Math.floor(this.ownerTtlMs / 3)))
    this.heartbeat.unref?.()
  }

  private async refreshClaims(): Promise<void> {
    const now = Date.now()
    for (const [reqId, deadline] of this.seenRequests) if (deadline < now) this.seenRequests.delete(reqId)
    for (const [participantId, token] of [...this.claims]) {
      let kept: unknown
      try {
        kept = await this.redis.eval(REFRESH_OWNER_SCRIPT, 1, ownerKey(participantId), ownerValue(this.instanceId, token), this.ownerTtlMs)
      } catch {
        continue // Redis unavailable: the TTL bounds staleness; retry next beat.
      }
      if (kept !== 1 && this.claims.get(participantId) === token) {
        // Ownership moved or expired: this connection must stop receiving.
        this.claims.delete(participantId)
        this.revokeConnection(participantId, token)
      }
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const pending of this.pendingAcks.values()) pending.settle('AMBIGUOUS')
    this.pendingAcks.clear()
    const subscriber = await this.subscribing?.catch(() => null)
    this.subscribing = null
    this.subscriber = null
    await subscriber?.quit().catch(() => undefined)
  }

  /** Called before READY. Returns this connection's ownership token. */
  async claim(participantId: string): Promise<string> {
    await this.subscribed()
    const token = randomBytes(16).toString('base64url')
    const previous = splitOwner(await this.redis.eval(
      CLAIM_OWNER_SCRIPT, 1, ownerKey(participantId), ownerValue(this.instanceId, token), this.ownerTtlMs,
    ) as string | null)
    this.claims.set(participantId, token)
    if (previous && previous.instanceId !== this.instanceId) {
      // The displaced connection lives elsewhere: tell that instance to close it.
      const revoke: RevokeFrame = { kind: 'revoke', participant: participantId, token: previous.token }
      await this.redis.publish(channelOf(previous.instanceId), JSON.stringify(revoke))
    }
    return token
  }

  // A claimed connection that lost ownership: close it now if registered,
  // otherwise the moment it registers (it may still be in its handshake).
  private revokeConnection(participantId: string, token: string): void {
    if (!this.host.ownsToken(participantId, token)) this.revokedEarly.add(token)
    this.host.closeIfToken(participantId, token, 1008, 'Relay ownership moved')
  }

  /** The socket for this claim is now registered: act on a revoke that arrived first. */
  registered(participantId: string, token: string): void {
    if (!this.revokedEarly.delete(token)) return
    this.host.closeIfToken(participantId, token, 1008, 'Relay ownership moved')
  }

  async release(participantId: string, token: string): Promise<void> {
    this.revokedEarly.delete(token)
    if (this.claims.get(participantId) === token) this.claims.delete(participantId)
    await this.redis.eval(RELEASE_OWNER_SCRIPT, 1, ownerKey(participantId), ownerValue(this.instanceId, token))
  }

  /** One authenticated, budget-admitted frame from `from`. Throws only on infrastructure failure. */
  async route(from: string, raw: string): Promise<void> {
    const envelope = parseRelayEnvelope(raw)
    if (!envelope) {
      await this.reply(from, { type: 'REJECTED', id: null, reason: 'MALFORMED' })
      return
    }
    const { id, to, trade, body } = envelope
    if (!isAuthorizedPair(await this.findTrade(trade), from, to)) {
      await this.reply(from, { type: 'UNDELIVERED', id })
      return
    }
    const claimKey = `relay:msg:${from}:${id}`
    if (await this.redis.set(claimKey, '1', 'EX', MESSAGE_ID_TTL_SECONDS, 'NX') === null) {
      await this.reply(from, { type: 'REJECTED', id, reason: 'DUPLICATE' })
      return
    }
    const message = JSON.stringify({ type: 'MESSAGE', v: RELAY_ENVELOPE_VERSION, id, from, trade, body })
    const outcome = await this.deliver(from, to, message)
    // Only a definite non-delivery frees the id; an ambiguous one keeps it
    // consumed so a retry cannot deliver the same id twice.
    if (outcome === 'NOT_DELIVERED') await this.redis.del(claimKey)
    await this.reply(from, { type: outcome === 'SENT' ? 'SENT' : 'UNDELIVERED', id })
  }

  private async reply(to: string, frame: Record<string, unknown>): Promise<void> {
    await this.host.sendToPeer('relay', to, JSON.stringify(frame))
  }

  private async deliver(from: string, to: string, message: string): Promise<DeliveryOutcome> {
    const owner = splitOwner(await this.redis.get(ownerKey(to)))
    if (!owner) return 'NOT_DELIVERED'
    if (owner.instanceId === this.instanceId) {
      // Local socket, but only the one that holds the current ownership.
      if (!this.host.ownsToken(to, owner.token)) return 'NOT_DELIVERED'
      return await this.host.sendToPeer(from, to, message) ? 'SENT' : 'NOT_DELIVERED'
    }
    if (!this.subscriber || this.pendingAcks.size >= this.maxPendingRemote) return 'NOT_DELIVERED'
    const reqId = randomUUID()
    const outcome = new Promise<DeliveryOutcome>(resolve => {
      const timer = setTimeout(() => settle('AMBIGUOUS'), this.remoteAckTimeoutMs)
      const settle = (result: DeliveryOutcome) => {
        clearTimeout(timer)
        this.pendingAcks.delete(reqId)
        resolve(result)
      }
      this.pendingAcks.set(reqId, { from: owner.instanceId, settle })
    })
    const frame: DeliverFrame = {
      kind: 'deliver', reqId, replyTo: this.instanceId, to, token: owner.token, payload: message,
      deadline: Date.now() + this.remoteAckTimeoutMs,
    }
    let receivers: number
    try {
      receivers = await this.redis.publish(channelOf(owner.instanceId), JSON.stringify(frame))
    } catch (error) {
      // Not known whether the frame went out: ambiguous, then fail closed.
      this.pendingAcks.get(reqId)?.settle('AMBIGUOUS')
      throw error
    }
    // Nobody subscribed: the owner process is gone (abrupt death, stale key).
    if (receivers === 0) this.pendingAcks.get(reqId)?.settle('NOT_DELIVERED')
    return outcome
  }

  private onRemote(message: string): void {
    const frame = parseInternalFrame(message)
    if (!frame) return
    if (frame.kind === 'ack') {
      const pending = this.pendingAcks.get(frame.reqId)
      // Only the instance the request went to may answer it.
      if (pending && pending.from === frame.from) pending.settle(frame.ok ? 'SENT' : 'NOT_DELIVERED')
      return
    }
    if (frame.kind === 'revoke') {
      // The claim stays in `claims`: the heartbeat re-checks Redis and is the
      // backstop for any revoke this instance fails to act on.
      if (this.claims.get(frame.participant) === frame.token) this.revokeConnection(frame.participant, frame.token)
      else this.host.closeIfToken(frame.participant, frame.token, 1008, 'Relay ownership moved')
      return
    }
    if (this.seenRequests.has(frame.reqId)) return // replayed internal frame
    const now = Date.now()
    // A deadline beyond twice our own ack window is not a frame we would
    // send; bounding it also bounds how long seenRequests remembers it.
    const plausible = frame.deadline <= now + 2 * this.remoteAckTimeoutMs
    if (plausible && this.seenRequests.size < MAX_SEEN_REQUESTS) this.seenRequests.set(frame.reqId, frame.deadline)
    const fresh = plausible && now <= frame.deadline && this.seenRequests.has(frame.reqId) &&
      this.host.ownsToken(frame.to, frame.token)
    const send = fresh ? this.host.sendToPeer('relay', frame.to, frame.payload) : Promise.resolve(false)
    void send
      .then(ok => ok, () => false)
      .then(ok => {
        const ack: AckFrame = { kind: 'ack', reqId: frame.reqId, from: this.instanceId, ok }
        return this.redis.publish(channelOf(frame.replyTo), JSON.stringify(ack))
      })
      .catch(() => undefined)
  }
}
