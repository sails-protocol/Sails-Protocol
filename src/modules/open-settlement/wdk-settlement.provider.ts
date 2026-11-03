/**
 * Sails OpenSettlement — WDK USDT (EVM) SettlementProvider
 *
 * The first real (non-Mock) `SettlementProvider` implementation
 * (`EscrowType.WDK_USDT_EVM`) — `LightningHodlProvider`/`LiquidCovenantProvider`
 * still throw "not yet implemented" (TODO.md §4); this one is real,
 * using `@tetherto/wdk-wallet-evm`, the actual Tether WDK package.
 *
 * Testnet only — never mainnet. This provider must never be pointed at
 * an RPC/contract holding real value; that boundary is enforced by
 * config (`WDK_RPC_URL` defaults to Sepolia, `.env.example`) and by
 * convention, not by code, since the provider has no way to distinguish
 * "testnet with worthless tokens" from "mainnet with real USDT" other
 * than the RPC URL and contract address it's given.
 *
 * Custody model — stated plainly, not glossed over (same discipline
 * `MOCK`'s own "escrow is theater" config comment already applies):
 * this is a **single-seed, two-hop escrow**, not a trustless multisig.
 * One WDK seed (`WDK_SEED_PHRASE`) controls both the treasury account
 * (index 0) and every per-trade escrow sub-account (a deterministic
 * child derived from the tradeId) — the same key that can lock funds
 * can also move them anywhere. Every lock/release/refund below is a
 * *real* on-chain transfer with a real, checkable transaction hash —
 * what's not yet real is a third, independent party who could stop a
 * bad-faith release. That's the same gap `MULTISIG`'s own "not
 * implemented" status already documents (TODO.md §4); this provider is
 * an honest step between `MOCK` (fakes everything) and a genuine
 * trustless multisig (nobody has built yet), not a claim to have closed
 * that gap.
 *
 * Bounded Remediation (WDK Fund-Moving Safety, 2026-09-08) — every method
 * below that self-initiates a real transfer (`lockFunds`/`releaseFunds`/
 * `refundFunds`/`splitFunds`) now runs through `wdk-execution-truth.ts`'s
 * `ensureAttempt()`/`waitForReceiptOutcome()`, closing the DEMONSTRATED
 * retry-safety and receipt-verification gaps
 * `docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` (#56) and
 * `docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md` (#58) found. See that
 * module's own header comment for the full design. This does NOT change
 * `WDK_USDT_EVM`'s `PRODUCTION-INELIGIBLE` status (RFC-019) — it closes
 * one class of blocker, not all of them.
 */
import WalletManagerEvm, { type WalletAccountEvm } from '@tetherto/wdk-wallet-evm'
import { createHash } from 'crypto'
import { EscrowError } from '../../common/errors'
import { config } from '../../config'
import type { SettlementProvider } from './escrow.service'
import { ensureAttempt, markSubmissionAttempted, waitForReceiptOutcome, decimalAmountsEqual } from './wdk-execution-truth'
import { wdkTransferAttemptRepository } from './wdk-transfer-attempt-repository'

// Issue #251 - Day-0 restart convergence for a terminal WDK_USDT_EVM RELEASE/REFUND whose settlement
// result was never durably persisted. 'MISMATCH' covers every fail-closed corruption/contradiction case
// (Case D): wrong amount, wrong destination, a CONFIRMED row with no txHash, or an unrecognized status.
export type WdkTerminalReconciliationResult =
  | { outcome: 'CONFIRMED'; txHash: string }
  | { outcome: 'PENDING' | 'NO_ATTEMPT' | 'SUBMISSION_UNKNOWN' | 'NOT_STARTED' | 'REVERTED' | 'MISMATCH'; reason: string }

// USDT's real, historically-fixed decimal precision on every EVM chain
// it's deployed on — deliberately not read from the token contract at
// runtime (an extra RPC round-trip for a value that never changes for
// this specific asset). schema.prisma's Decimal(24,8) columns store more
// precision than USDT actually has on-chain; amounts are truncated to 6
// decimals here, not rounded up, so this provider never sends more than
// what was actually locked.
const USDT_DECIMALS = 6

// Exported for direct unit testing (tests/wdkSettlementProvider.test.ts) —
// pure, deterministic, no network/wallet dependency, so they're tested
// directly rather than only indirectly through a mocked wallet.
export function toBaseUnits(decimalAmount: string, decimals: number): bigint {
  const [whole, fraction = ''] = decimalAmount.split('.')
  const truncatedFraction = fraction.slice(0, decimals).padEnd(decimals, '0')
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(truncatedFraction || '0')
}

// The exact inverse of toBaseUnits() above — used only to give
// WdkTransferAttempt's own `amount` column a human-readable decimal
// record for a split leg's own computed base-unit amount (buyerAmount/
// sellerAmount below never round-trip through this for the actual
// transfer() call itself, which always uses the exact bigint).
export function fromBaseUnits(baseUnits: bigint, decimals: number): string {
  const negative = baseUnits < 0n
  const abs = negative ? -baseUnits : baseUnits
  const divisor = 10n ** BigInt(decimals)
  const whole = abs / divisor
  const fractionDigits = (abs % divisor).toString().padStart(decimals, '0')
  return `${negative ? '-' : ''}${whole}.${fractionDigits}`
}

// Deterministic per-trade escrow account index — a BIP-44 non-hardened
// index must fit in 31 bits (0..2^31-1). sha256(tradeId) gives a stable,
// evenly-distributed source; same tradeId always re-derives the same
// escrow account, which is what lets releaseFunds()/refundFunds() find
// the account lockFunds() funded without persisting the derivation path
// anywhere.
export function escrowIndexFor(tradeId: string): number {
  const hash = createHash('sha256').update(tradeId).digest()
  return hash.readUInt32BE(0) % 0x7fffffff
}

// Same derivation shape as escrowIndexFor, distinct salt (`buyer:` prefix)
// so a buyer's receiving-address index and a trade's escrow-account index
// never collide even for coincidentally-equal input strings. Stands in for
// real per-user EVM address onboarding, which doesn't exist yet in this
// reference implementation (this provider's own header comment) — a
// deterministic per-buyer top-level account at least means different
// buyers get different, stable addresses, not the same hardcoded demo
// address every time settlement-orchestrator.ts's auto-settle handler
// (common/events/handlers.ts) releases funds.
export function buyerIndexFor(buyerId: string): number {
  const hash = createHash('sha256').update(`buyer:${buyerId}`).digest()
  return hash.readUInt32BE(0) % 0x7fffffff
}

export class WdkSettlementProvider implements SettlementProvider {
  name = 'WDK_USDT_EVM'

  // RFC-019 Phase 1 (rfcs/RFC-019-settlement-custody-reference-vs-normative.md)
  // — makes this class's own header comment above (the "single-seed,
  // two-hop escrow" disclosure) introspectable in code, not just
  // readable by whoever opens this file. Any code path holding a
  // `SettlementProvider` can now check this field to tell a genuinely
  // non-custodial implementation apart from this reference one — no
  // such implementation exists yet (`MOCK` is a demonstration, this is
  // the only real one), so this field always reads the same value
  // today, but the field itself is the deliverable: it's what a future
  // wallet-authorized provider (RFC-019's Phase 2, unscoped, not built)
  // would set differently.
  readonly custodyModel = 'server-custodial-reference-implementation' as const

  private wallet: WalletManagerEvm | null = null

  private getWallet(): WalletManagerEvm {
    if (this.wallet) return this.wallet
    if (!config.wdk.seedPhrase) {
      throw new EscrowError('WDK_USDT_EVM provider requires WDK_SEED_PHRASE configured (.env.example) — refusing to construct a wallet from an empty seed')
    }
    if (!config.wdk.usdtContract) {
      throw new EscrowError('WDK_USDT_EVM provider requires WDK_USDT_CONTRACT configured (.env.example) — no token address to transfer')
    }
    this.wallet = new WalletManagerEvm(config.wdk.seedPhrase, { provider: config.wdk.rpcUrl })
    return this.wallet
  }

  private async treasuryAccount(): Promise<WalletAccountEvm> {
    return this.getWallet().getAccount(0)
  }

  private async escrowAccount(tradeId: string): Promise<WalletAccountEvm> {
    const index = escrowIndexFor(tradeId)
    return this.getWallet().getAccountByPath(`0'/0/${index}`)
  }

  // Demo/inspection helper, not part of the SettlementProvider interface
  // — src/demo/pix-to-usdt-flow.ts uses this to get a real address to
  // release funds to, standing in for a buyer's own independently
  // controlled wallet (this reference implementation doesn't onboard
  // per-user EVM keys yet — see that script's own doc comment).
  async getAccountAddress(index: number): Promise<string> {
    const account = await this.getWallet().getAccount(index)
    return account.getAddress()
  }

  // Issue #251 - the reconciler's ONLY point of contact with this provider's wallet/chain access.
  // Deliberately READ-ONLY against both the chain (never calls transfer()) and WdkTransferAttempt
  // (never calls updateStatus()) - a live caller may be concurrently running ensureAttempt()'s own
  // CAS-guarded status transitions for this exact attempt (escrow.service.ts's releaseFunds()/
  // refundFunds() never blocks their own retry on a terminal-but-unrecorded escrow the way a
  // still-PAYMENT_PENDING one would; see this method's own caller for why that race is real), and
  // this method must never contend with that CAS nor with a second, independent classification of
  // the same on-chain fact. It only tells the caller what the durable attempt ledger + a fresh
  // on-chain receipt already prove; escrow-settlement-reconciliation.service.ts is the only thing
  // that ever turns that into a written Escrow.txReleaseId, and only through the frozen write-once
  // persistSettlementResult() path (Issue #291) - WdkTransferAttempt itself never becomes protocol
  // authority.
  async reconcileTerminalTransfer(
    escrow: { id: string; tradeId: string; lockedAmount: string },
    operationType: 'RELEASE' | 'REFUND' | 'SPLIT_BUYER' | 'SPLIT_SELLER',
    expectedDestination: string,
    // Issue #250 - RELEASE/REFUND always transfer the FULL escrow.lockedAmount, so callers always pass
    // it here and get a real, independent anti-corruption check. A SPLIT leg transfers only its own
    // bps-derived share, and buyerBps is not durably recoverable for this direct-call rail (no
    // EscrowPendingTransaction row exists for it) - there is no independently-known expected amount
    // for ONE leg alone to check against. Passing `undefined` skips this check HONESTLY rather than
    // fabricating a value that would make it vacuously pass; reconcileWdkSplitTransfer() (the only
    // SPLIT_BUYER/SPLIT_SELLER caller) instead verifies the one invariant that IS independently true
    // regardless of bps - both legs' own recorded amounts sum to escrow.lockedAmount - before this
    // method is ever called for either leg.
    expectedAmount?: string
  ): Promise<WdkTerminalReconciliationResult> {
    const latest = await wdkTransferAttemptRepository.findLatest(escrow.id, operationType)
    if (!latest) {
      return { outcome: 'NO_ATTEMPT', reason: `No WdkTransferAttempt exists for escrow ${escrow.id}/${operationType} — nothing to converge from.` }
    }
    // Case D - fail closed on any mismatch rather than guessing which attempt/value is the real one.
    // escrowId/operationType mismatches are already excluded by findLatest()'s own WHERE clause.
    if (expectedAmount !== undefined && !decimalAmountsEqual(latest.amount.toString(), expectedAmount)) {
      return {
        outcome: 'MISMATCH',
        reason: `WdkTransferAttempt ${latest.id} amount ${latest.amount.toString()} does not match the expected ${operationType} amount ${expectedAmount} for escrow ${escrow.id} — refusing to treat it as authoritative evidence.`,
      }
    }
    if (latest.destination !== expectedDestination) {
      return {
        outcome: 'MISMATCH',
        reason: `WdkTransferAttempt ${latest.id} destination ${latest.destination} does not match the independently-derived expected ${operationType} destination ${expectedDestination} — refusing to treat it as authoritative evidence.`,
      }
    }

    switch (latest.status) {
      case 'CONFIRMED':
        if (!latest.txHash) {
          return { outcome: 'MISMATCH', reason: `WdkTransferAttempt ${latest.id} is CONFIRMED but has no persisted txHash — data integrity violation, refusing to resume.` }
        }
        return { outcome: 'CONFIRMED', txHash: latest.txHash }

      case 'SUBMITTED': {
        if (!latest.txHash) {
          return { outcome: 'MISMATCH', reason: `WdkTransferAttempt ${latest.id} is SUBMITTED but has no persisted txHash — data integrity violation.` }
        }
        // A genuine RPC/transport failure here throws and propagates to the caller as a technical
        // failure - never silently downgraded to REVERTED/PENDING (Case B: never infer failure
        // merely from a query failure).
        const account = await this.escrowAccount(escrow.tradeId)
        const receipt = await account.getTransactionReceipt(latest.txHash)
        if (!receipt) {
          return { outcome: 'PENDING', reason: `WdkTransferAttempt ${latest.id}'s transaction ${latest.txHash} is not yet confirmed on-chain — remains pending, no resubmission.` }
        }
        if (receipt.status === 1) return { outcome: 'CONFIRMED', txHash: latest.txHash }
        return { outcome: 'REVERTED', reason: `WdkTransferAttempt ${latest.id}'s transaction ${latest.txHash} reverted on-chain — no funds were delivered by this attempt.` }
      }

      case 'SUBMISSION_UNKNOWN':
        // Case C - never inferred as FAILED, never blindly retried. No txHash exists to query, so no
        // automatic convergence is possible; this must remain an explicit, inspectable state.
        return {
          outcome: 'SUBMISSION_UNKNOWN',
          reason: `WdkTransferAttempt ${latest.id} outcome is UNKNOWN — no transaction hash was ever obtained, so nothing can be queried; this cannot be automatically converged and must not be retried blindly.`,
        }

      case 'PREPARED':
      case 'FAILED_BEFORE_SUBMISSION':
      case 'REVERTED':
        // Definitively no funds delivered BY THIS ATTEMPT — but this method has no authority to undo
        // the escrow's own terminal claim (that would be a different, larger recovery than #251
        // scopes: reverting an already-claimed terminal status with no txReleaseId). Surfaced for
        // manual review, exactly like every other case this method cannot positively converge.
        return {
          outcome: 'NOT_STARTED',
          reason: `WdkTransferAttempt ${latest.id} is ${latest.status} — no funds were ever delivered by this attempt; the escrow's terminal claim cannot be automatically corroborated from provider evidence.`,
        }

      default: {
        const exhaustive: never = latest.status
        return { outcome: 'MISMATCH', reason: `WdkTransferAttempt ${latest.id} has an unrecognized status: ${String(exhaustive)}` }
      }
    }
  }

  async lockFunds(escrow: { id: string; tradeId: string; lockedAmount: string }): Promise<{ txId: string; address: string }> {
    const treasury = await this.treasuryAccount()
    const escrowAcct = await this.escrowAccount(escrow.tradeId)
    const escrowAddress = await escrowAcct.getAddress()
    const amount = toBaseUnits(escrow.lockedAmount, USDT_DECIMALS)

    const txId = await this.executeTransfer(escrow.id, 'LOCK', treasury, escrowAddress, escrow.lockedAmount, amount)
    return { txId, address: escrowAddress }
  }

  // Bounded Remediation (WDK Fund-Moving Safety, 2026-09-08) — the one
  // shared, provider-local execution path every self-initiated transfer
  // below (lock/release/refund, and each of splitFunds()'s two legs)
  // goes through: ensureAttempt() (durable identity before the side
  // effect, Property A; blocks an unsafe blind retry, Property B) ->
  // the real transfer() call -> waitForReceiptOutcome() (never declares
  // success on a bare hash, Property C). Kept as one method rather than
  // duplicated per caller — the exact same sequence, same error
  // semantics, same durable bookkeeping, for every WDK_USDT_EVM
  // operation type. See wdk-execution-truth.ts's own header comment for
  // the full design and docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md §13 for
  // why this is the minimum mechanism chosen (a single shared helper
  // inside this ONE provider file, not a generic cross-provider
  // abstraction).
  private async executeTransfer(
    escrowId: string,
    operationType: 'LOCK' | 'RELEASE' | 'REFUND' | 'SPLIT_BUYER' | 'SPLIT_SELLER',
    sourceAccount: WalletAccountEvm,
    destination: string,
    decimalAmount: string,
    baseUnitsAmount: bigint
  ): Promise<string> {
    const outcome = await ensureAttempt(escrowId, operationType, destination, decimalAmount, sourceAccount)
    if (outcome.action === 'RESUME_CONFIRMED') {
      return outcome.txHash
    }

    const attemptId = outcome.attemptId

    // CTO Gate Correction (2026-09-08) — the durable pre-submission
    // commit, written BEFORE transfer() is ever called (not after
    // catching a throw). Closes the PREPARED -> transfer() -> SUBMITTED
    // crash window: a crash at ANY point from here on — including
    // mid-transfer(), after a real broadcast already succeeded, before
    // the JS promise ever settles — now leaves this attempt durably at
    // SUBMISSION_UNKNOWN, which wdk-execution-truth.ts's ensureAttempt()
    // already blocks unconditionally on the next call. See that file's
    // own header comment and markSubmissionAttempted()'s own doc comment
    // for the full reasoning.
    await markSubmissionAttempted(attemptId)

    let hash: string
    try {
      const result = await sourceAccount.transfer({ token: config.wdk.usdtContract, recipient: destination, amount: baseUnitsAmount })
      hash = result.hash
    } catch (err) {
      // Already SUBMISSION_UNKNOWN from the pre-commit above — this call
      // cannot distinguish "never reached the network" from "reached it
      // and the response was lost" either way
      // (docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md's own central finding
      // about this exact WDK API), so nothing further needs writing;
      // re-asserting the same status here is a harmless, idempotent
      // safety net, not the primary mechanism.
      // The pre-submit CAS already established SUBMISSION_UNKNOWN. Do not let a stale catch path\n      // rewrite a newer SUBMITTED/CONFIRMED truth.\n      // No additional status write is needed here.
      throw err
    }

    // If THIS write itself fails (e.g. a transient DB error), the attempt
    // simply remains at whatever the pre-commit above set —
    // SUBMISSION_UNKNOWN — which is exactly correct: Sails has a real
    // hash in local memory that was never durably recorded, so a retry
    // must be blocked exactly as if the outcome were genuinely unknown,
    // never silently reverted to retryable. No try/catch needed here —
    // the thrown error already propagates correctly, and the row's last
    // successfully-written state already blocks the next attempt.
    await wdkTransferAttemptRepository.updateStatus(attemptId, 'SUBMITTED', { txHash: hash }, ['SUBMISSION_UNKNOWN'])

    const receiptOutcome = await waitForReceiptOutcome(sourceAccount, hash)
    if (receiptOutcome === 'CONFIRMED') {
      await wdkTransferAttemptRepository.updateStatus(attemptId, 'CONFIRMED', undefined, ['SUBMITTED'])
      return hash
    }
    if (receiptOutcome === 'REVERTED') {
      await wdkTransferAttemptRepository.updateStatus(attemptId, 'REVERTED', undefined, ['SUBMITTED'])
      throw new EscrowError(`WDK_USDT_EVM ${operationType} transfer ${hash} for escrow ${escrowId} reverted on-chain — no funds were delivered.`)
    }
    // PENDING — the bounded wait elapsed with no receipt yet. Stays
    // SUBMITTED; a subsequent call (retry) will re-check this exact
    // hash's receipt via ensureAttempt() before ever broadcasting again.
    throw new EscrowError(`WDK_USDT_EVM ${operationType} transfer ${hash} for escrow ${escrowId} was submitted but is not yet confirmed on-chain within the bounded wait — this is not a failure; retry will reconcile automatically once the transaction is mined.`)
  }

  // Missão 11 Fase 4 — rail-parity audit: NOT extended with fee-aware
  // construction, deliberately. This provider funds its own escrow from
  // Sails' own treasury account (this file's own header comment) — there
  // is no external, seller-controlled deposit for a "seller-funded
  // reserve" to attach to, so this rail is explicitly non-authoritative
  // as evidence for (or against) the non-custodial funding model designed
  // for MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM. Its existing recordObligationForEscrowSettlement()
  // call (via escrow.service.ts's direct-call path) still runs, using the
  // generic, non-Bitcoin-specific fixture-only small-trade rule — never
  // this rail's own (nonexistent) dust/collection-address logic.
  async releaseFunds(escrow: { id: string; tradeId: string; lockedAmount: string }, toAddress: string): Promise<{ txId: string }> {
    const escrowAcct = await this.escrowAccount(escrow.tradeId)
    const amount = toBaseUnits(escrow.lockedAmount, USDT_DECIMALS)

    const txId = await this.executeTransfer(escrow.id, 'RELEASE', escrowAcct, toAddress, escrow.lockedAmount, amount)
    return { txId }
  }

  async refundFunds(escrow: { id: string; tradeId: string; lockedAmount: string }): Promise<{ txId: string }> {
    const treasury = await this.treasuryAccount()
    const treasuryAddress = await treasury.getAddress()
    const escrowAcct = await this.escrowAccount(escrow.tradeId)
    const amount = toBaseUnits(escrow.lockedAmount, USDT_DECIMALS)

    const txId = await this.executeTransfer(escrow.id, 'REFUND', escrowAcct, treasuryAddress, escrow.lockedAmount, amount)
    return { txId }
  }

  // RFC-021 D9 (2026-08-02) — real, two separate on-chain transfers (no
  // atomic multi-recipient primitive on this provider's transfer() API,
  // same constraint releaseFunds()/refundFunds() above already live
  // with). buyerBps is out of 10000; the seller gets the exact remainder
  // (computed from what's left over, not a second independent
  // percentage) so the two legs always sum to the full lockedAmount with
  // no truncation dust unaccounted for.
  // Bounded Remediation (WDK Fund-Moving Safety, 2026-09-08) — Property D
  // (Safe Multi-Leg Resume), closing docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md
  // §5's DEMONSTRATED partial-execution gap. The two legs are tracked as
  // two entirely independent logical operations (SPLIT_BUYER,
  // SPLIT_SELLER — separate WdkTransferAttempt rows), each going through
  // the exact same executeTransfer() every other method above uses. The
  // seller leg is never attempted until the buyer leg has a real,
  // receipt-confirmed txHash — resuming (skipping the transfer() call
  // entirely) whenever a prior attempt already reached CONFIRMED, exactly
  // satisfying the mission's own four named cases: buyer CONFIRMED +
  // seller not started -> resumes at seller only; buyer CONFIRMED +
  // seller UNKNOWN -> executeTransfer()'s own ensureAttempt() call for
  // the seller leg blocks until reconciled; buyer UNKNOWN -> blocked
  // before ever reaching the seller leg (buyer never repeated); buyer
  // CONFIRMED + a prior seller REVERTED -> the seller leg's own
  // ensureAttempt() call safely starts a fresh seller attempt (a
  // definitively reverted transfer proves no funds moved), the buyer leg
  // is never touched again.
  async splitFunds(escrow: { id: string; tradeId: string; lockedAmount: string }, buyerAddress: string, sellerAddress: string, buyerBps: number): Promise<{ txIds: string[] }> {
    const escrowAcct = await this.escrowAccount(escrow.tradeId)
    const total = toBaseUnits(escrow.lockedAmount, USDT_DECIMALS)
    const buyerAmount = (total * BigInt(buyerBps)) / 10000n
    const sellerAmount = total - buyerAmount

    const buyerTxId = await this.executeTransfer(escrow.id, 'SPLIT_BUYER', escrowAcct, buyerAddress, fromBaseUnits(buyerAmount, USDT_DECIMALS), buyerAmount)
    // The seller leg is only ever attempted once the buyer leg above has
    // returned — executeTransfer() either resumed a real, confirmed prior
    // txHash or genuinely reached CONFIRMED just now; either way, by this
    // line, the buyer leg is durably CONFIRMED. If it wasn't, the line
    // above already threw and this code is never reached — the seller
    // leg's transfer() is never even attempted, let alone the buyer leg
    // repeated.
    const sellerTxId = await this.executeTransfer(escrow.id, 'SPLIT_SELLER', escrowAcct, sellerAddress, fromBaseUnits(sellerAmount, USDT_DECIMALS), sellerAmount)

    return { txIds: [buyerTxId, sellerTxId] }
  }

}

export const wdkSettlementProvider = new WdkSettlementProvider()
