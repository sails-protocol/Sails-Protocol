/**
 * Transport-neutral origin coordinator. The caller must supply a transport
 * that sends commands to an authenticated destination instance and routes
 * its ACKs back to acknowledge(). A successful publish is NOT delivery.
 */
import { RelayDeliveryPendingRegistry } from './relay-delivery-pending'
import type { RelayDeliveryCommand } from './relay-delivery-command'

export type RelayCommandPublisher = (command: RelayDeliveryCommand) => Promise<void>

export class RelayDeliveryOrigin {
  private readonly pending = new RelayDeliveryPendingRegistry()
  constructor(private readonly publish: RelayCommandPublisher) {}

  get pendingCount(): number { return this.pending.size }

  async deliver(input: Omit<RelayDeliveryCommand, 'requestId'>): Promise<boolean> {
    const entry = this.pending.register()
    if (!entry) return false
    const command: RelayDeliveryCommand = { ...input, requestId: entry.requestId }
    try {
      await this.publish(command)
    } catch {
      this.pending.reject(entry.requestId)
    }
    return entry.result
  }

  acknowledge(raw: unknown): boolean { return this.pending.acknowledge(raw) }

  close(): void { this.pending.close() }
}
