/**
 * Sails OpenSettlement — Settlement Orchestrator
 *
 * `executeSettlement()`: the single real entrypoint that carries a matched
 * Trade through escrow creation, the seller locking collateral, the
 * (emulated) PIX receipt confirmation, and the seller's agent releasing
 * USDT — a real, digitally signed on-chain transfer via
 * `wdk-settlement.provider.ts`'s `WdkSettlementProvider`
 * (`@tetherto/wdk-wallet-evm`), reached through `escrow.service.ts`'s
 * already-real `releaseFunds()`.
 *
 * Naming note, checked against the actual npm registry before writing any
 * import (this codebase's standing rule — never guess a package name):
 * `@tetherto/wdk-core` does not exist as a published package. The closest
 * real match is `@tetherto/wdk` (keywords `["wdk","core"]`, "a flexible
 * manager that can register and manage multiple wallet instances for
 * different blockchains dynamically") — a multi-chain umbrella manager,
 * not itself what signs an EVM transfer. `wdk-settlement.provider.ts`
 * already uses the correct, chain-specific package for that:
 * `@tetherto/wdk-wallet-evm`'s `WalletManagerEvm`, which is what actually
 * derives the seller's escrow-account keypair and signs the transfer
 * locally (`WalletAccountEvm.transfer()` — real, not mocked, verified
 * against the package's own API before that file was written). This
 * orchestrator reuses that existing real signing path via
 * `escrowService.releaseFunds()` rather than introducing a second,
 * redundant WDK integration.
 *
 * "Quando o motor P2P der 'Match'": in this reference implementation's
 * actually-built code (not the aspirational Intent Engine `MATCHED` state,
 * which has no real matching engine wired to it yet — BACKLOG.md's
 * Coordination Engine entry), the real match event is
 * `openp2p.trade.created` (`trade.service.ts`'s `createTrade()`, fired the
 * moment a counterparty accepts an `Offer`). `common/events/handlers.ts`
 * wires that event to this function, gated behind
 * `config.features.autoSettleOnMatch` (default `false`) — see that file's
 * own comment for why this is not unconditional. This function itself
 * has no opinion on how it's invoked: a route, the demo script, or an
 * agent can all call it directly too.
 *
 * PIX receipt is emulated, not integrated with a real payment rail —
 * `emulateSellerPixReceipt()` below produces a clearly-labeled synthetic
 * confirmation object (`emulated: true`), not a silent stand-in dressed
 * up as real. A real integration is Sails OpenProof's job (RFC-003,
 * Claim/Proof/Verification), still 📋 future — this orchestrator does not
 * pretend to have built that.
 */
import { prisma } from '../../common/database'
import { EscrowError, NotFoundError } from '../../common/errors'
import type { AssetType } from '../../common/types'
import type { EscrowType } from '../../common/types/trade'
import { escrowService } from './escrow.service'
import { config } from '../../config'

export interface ExecuteSettlementInput {
  tradeId: string
  // Optional release destination for the MOCK rail. Omitted, releaseFunds() resolves the buyer's own
  // registered payout address (the same authority every value-moving release uses).
  buyerReceivingAddress?: string
  // The agent acting on the seller's behalf, if any (WalletAgent.agentId,
  // modules/open-agents/wallet-agent.ts) — recorded as `triggeredBy` on
  // every escrow transition below, the same precedent RFC-012's
  // `Intent.agentId` threading already established: it's just data that
  // flows through, not special-cased. Falls back to the trade's own
  // sellerId when no agent is acting (a human seller, or a route that
  // hasn't been given an agent identity).
  sellerAgentId?: string
  escrowType?: EscrowType // defaults to WDK_USDT_EVM
}

export interface PixReceiptConfirmation {
  emulated: true
  method: 'PIX'
  confirmedBy: string
  confirmedAt: Date
  reference: string
}

export interface ExecuteSettlementResult {
  escrowId: string
  lockTxId: string
  pixConfirmation: PixReceiptConfirmation
  releaseTxId: string
}

// Explicit, labeled emulation — never silently treated as if it were a
// real Sails OpenProof-verified payment claim (RFC-003). `reference` is a
// synthetic identifier, not a real PIX transaction id.
function emulateSellerPixReceipt(confirmedBy: string): PixReceiptConfirmation {
  return {
    emulated: true,
    method: 'PIX',
    confirmedBy,
    confirmedAt: new Date(),
    reference: `emulated-pix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  }
}

export async function executeSettlement(input: ExecuteSettlementInput): Promise<ExecuteSettlementResult> {
  const trade = await prisma.trade.findUnique({ where: { id: input.tradeId } })
  if (!trade) throw new NotFoundError('Trade', input.tradeId)

  const sellerTriggeredBy = input.sellerAgentId ?? trade.sellerId
  const escrowType: EscrowType = input.escrowType ?? (config.features.mockEscrow ? 'MOCK' : 'WDK_USDT_EVM')

  // #235 R7G NF-B1: this orchestrator acts as both parties - it locks as the seller, claims the fiat payment
  // as the buyer (which also ends the seller's FUNDS_LOCKED expiry path) and releases on an emulated PIX
  // confirmation. That is never authority over real value: every rail but MOCK is refused here, before any
  // escrow, LOCK, claim or event exists.
  if (escrowType !== 'MOCK') {
    throw new EscrowError(
      `executeSettlement() runs only on the MOCK rail: it emulates the seller's PIX confirmation and acts for both ` +
      `parties, so it never moves value on ${escrowType} (trade ${trade.id}). Nothing was executed.`,
      'UNAVAILABLE'
    )
  }

  // Seller locks USDT collateral — a real, signed WDK transfer
  // (WdkSettlementProvider.lockFunds -> WalletManagerEvm's treasury
  // account transferring to a per-trade escrow sub-account) when
  // MOCK_ESCROW=false; a genuinely, honestly MOCK-typed escrow otherwise.
  //
  // Missão 11 Fase 7.3.1 §A — real P0 closed (Fase 7.3 audit): this used
  // to hardcode `type: input.escrowType ?? 'WDK_USDT_EVM'` unconditionally
  // — a REAL type, persisted honestly, that then relied on
  // getSettlementProvider()'s own (now-removed) mockEscrow short-circuit
  // to silently substitute MockSettlementProvider whenever MOCK_ESCROW
  // wasn't explicitly false. That short-circuit no longer exists
  // (escrow-providers.ts), so this default now matches
  // escrow.service.ts's own createEscrow() convention exactly: honestly
  // persist `type: 'MOCK'` when mockEscrow is on, rather than persisting
  // a real type the provider layer would have quietly not honored.
  // createEscrow()'s new membership check (SECURITY_AUDIT_REPORT.md §9)
  // wants a real trade party, the same raw-id convention
  // submitParticipantKey() already uses — not `sellerTriggeredBy`, which
  // may be an agent id (`agent:<type>:<sellerId>`, see this file's own
  // `sellerAgentId` doc comment) that wouldn't match `trade.sellerId`
  // directly.
  const escrow = await escrowService.createEscrow({
    tradeId: trade.id,
    type: escrowType,
    lockedAmount: trade.amount.toString(),
    asset: trade.asset as AssetType,
  }, trade.sellerId)
  const locked = await escrowService.lockFunds(escrow.id, sellerTriggeredBy)

  // Comprador paga PIX (fora do protocolo — fiat nunca é intermediado,
  // PROJECT_CONTEXT.md §1). markPaymentSent() is the real, existing
  // FUNDS_LOCKED -> PAYMENT_PENDING transition; the buyer is who claims to
  // have sent it.
  await escrowService.markPaymentSent(locked.id, trade.buyerId)

  // The step this function exists to make explicit: the seller (or their
  // agent) confirming PIX was received. Emulated, not a real payment-rail
  // integration — see this file's header comment.
  const pixConfirmation = emulateSellerPixReceipt(sellerTriggeredBy)

  // The seller's agent triggers the real, digitally signed USDT release —
  // escrowService.releaseFunds() -> WdkSettlementProvider.releaseFunds()
  // -> WalletAccountEvm.transfer() (@tetherto/wdk-wallet-evm), a genuine
  // on-chain transaction with a real, checkable hash (testnet).
  //
  // RFC-014's capability check and RFC-015's two-person control both live
  // inside releaseFunds() itself (escrow.service.ts), not here — found
  // while implementing RFC-015 that this orchestrator is not the only
  // real caller of releaseFunds(): settlement.routes.ts's direct
  // POST /v1/settlement/escrow/:id/release and dispute.service.ts's
  // arbitrated resolveDispute() both call it too, and a check placed only
  // here (RFC-014's original location) silently missed both. Both flags
  // (config.features.enforceCapabilities, requireDualApprovalForRelease)
  // default false — see their own doc comments in config/index.ts.
  const released = await escrowService.releaseFunds(locked.id, input.buyerReceivingAddress, sellerTriggeredBy)

  return {
    escrowId: escrow.id,
    lockTxId: locked.txLockId ?? '',
    pixConfirmation,
    releaseTxId: released.txReleaseId ?? '',
  }
}
