/**
 * @satsails/p2p-trading-sdk — Capability declaration module (verified against
 * src/modules/open-agents/capability.routes.ts directly).
 *
 * rfcs/RFC-013-capability-registry-and-wallet-adapter.md. Self-issued
 * grants only, matching the real route's current scope — a caller
 * declares and grants themselves scope over their own capabilities.
 *
 * Issue #303 — a self-issued grant is the participant's OWN consent/
 * delegation, NOT independent third-party authorization. Production
 * servers enforce Capability Authority (ENFORCE_CAPABILITIES=true is
 * mandatory) and accept ONLY the canonical (capabilityName, scope) pairs in
 * CANONICAL_CAPABILITY_SCOPES below (mirrors src/core/capability-registry.ts,
 * which a root-level test keeps in lockstep). ensureCanonicalGrants() is the
 * supported onboarding call: every participant that must trade, seller,
 * arbiter or integrator, needs these grants before the gated actions work.
 */
import type { SailsTransport } from '../transport'
import type { CapabilityGrant } from '../types'
import type { WalletAdapter } from '../wallet-adapter'

export interface RegisterCapabilityInput {
  capabilityName: string
  scope: string[]
  constraints?: Record<string, unknown>
}

/** The only (capabilityName -> action scopes) pairs the server accepts and its gates consume. */
export const CANONICAL_CAPABILITY_SCOPES: Readonly<Record<string, readonly string[]>> = {
  'trade-coordination': ['intent.created', 'intent.discovering'],
  settlement: ['settlement.escrow.released', 'settlement.escrow.refunded', 'settlement.escrow.split'],
}

function grantIsLive(grant: CapabilityGrant): boolean {
  const expiresAt = grant.constraints?.expiresAt
  return !(typeof expiresAt === 'string' && new Date(expiresAt) <= new Date())
}

export class SailsCapabilitiesModule {
  constructor(private readonly transport: SailsTransport) {}

  /** Requires an active session. */
  async register(input: RegisterCapabilityInput): Promise<CapabilityGrant> {
    return this.transport.post<CapabilityGrant>('/v1/capabilities/register', input, true)
  }

  async list(participantId: string): Promise<CapabilityGrant[]> {
    return this.transport.get<CapabilityGrant[]>(`/v1/capabilities/${participantId}`)
  }

  /** Requires an active session. */
  async revoke(grantId: string): Promise<void> {
    await this.transport.post(`/v1/capabilities/${grantId}/revoke`, undefined, true)
  }

  /**
   * Issue #303 - the supported onboarding call. Idempotent: lists the
   * caller's live grants and self-issues ONLY the canonical capabilities
   * whose action scopes are not yet fully covered by a live grant, so it is
   * safe to call on every login. Needed by every actor that reaches a gate:
   * buyers/sellers (trade-coordination + settlement), and arbiters (the
   * settlement grant - an assigned arbiter without one fails closed on
   * release/refund/split). Requires an active session. Returns the caller's
   * live canonical grants after the call.
   */
  async ensureCanonicalGrants(participantId: string): Promise<CapabilityGrant[]> {
    const live = (await this.list(participantId)).filter(grantIsLive)
    for (const [capabilityName, scopes] of Object.entries(CANONICAL_CAPABILITY_SCOPES)) {
      const covered = new Set(live.filter((g) => g.capabilityName === capabilityName).flatMap((g) => g.scope))
      if (scopes.every((s) => covered.has(s))) continue
      live.push(await this.register({ capabilityName, scope: [...scopes] }))
    }
    return live.filter((g) => Object.prototype.hasOwnProperty.call(CANONICAL_CAPABILITY_SCOPES, g.capabilityName))
  }

  /**
   * @deprecated Issue #303 - a wallet's technical capabilities
   * (`getCapabilities()`: assets, rails, supportsP2PTrading...) describe what
   * the wallet CAN do; they are not permission and never define which
   * CapabilityGrant a participant holds. The old implementation turned them
   * into a single grant with capability names as scopes, which no gate
   * consumes and which the server now rejects. This method is kept for
   * source compatibility only: `wallet` is intentionally NOT consulted, it
   * self-issues both canonical grants (trade-coordination, settlement) and
   * returns the trade-coordination one. Prefer ensureCanonicalGrants().
   */
  async registerFromWallet(_wallet: WalletAdapter): Promise<CapabilityGrant> {
    const grants: CapabilityGrant[] = []
    for (const [capabilityName, scopes] of Object.entries(CANONICAL_CAPABILITY_SCOPES)) {
      grants.push(await this.register({ capabilityName, scope: [...scopes] }))
    }
    return grants[0]
  }
}
