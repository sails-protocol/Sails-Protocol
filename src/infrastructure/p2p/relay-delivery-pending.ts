/**
 * Bounded request lifecycle for an inter-instance relay transport.
 * Transport adapters must publish and receive authenticated commands/ACKs.
 * This module cannot prove publication, socket delivery, or client receipt.
 */
import { randomUUID } from 'node:crypto'
import { parseRelayDeliveryAck } from './relay-delivery-ack'

export const RELAY_MAX_PENDING_DELIVERIES = 256
export const RELAY_DELIVERY_TIMEOUT_MS = 3000

type Pending = {
  resolve: (accepted: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

/** A bounded, fail-closed correlation registry; no opaque payload retention. */
export class RelayDeliveryPendingRegistry {
  private readonly pending = new Map<string, Pending>()
  private closed = false

  get size(): number { return this.pending.size }

  register(): { requestId: string; result: Promise<boolean> } | null {
    if (this.closed || this.pending.size >= RELAY_MAX_PENDING_DELIVERIES) return null
    const requestId = randomUUID()
    let resolve!: (accepted: boolean) => void
    const result = new Promise<boolean>(r => { resolve = r })
    const timer = setTimeout(() => {
      this.settle(requestId, false)
    }, RELAY_DELIVERY_TIMEOUT_MS)
    this.pending.set(requestId, { resolve, timer })
    return { requestId, result }
  }

  acknowledge(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    const requestId = (raw as Record<string, unknown>).requestId
    if (typeof requestId !== 'string' || !this.pending.has(requestId)) return false
    const ack = parseRelayDeliveryAck(raw)
    if (!ack || ack.requestId !== requestId) return false
    return this.settle(requestId, ack.accepted)
  }

  reject(requestId: string): boolean { return this.settle(requestId, false) }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, false)
  }

  private settle(requestId: string, accepted: boolean): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    this.pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.resolve(accepted)
    return true
  }
}
