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
 * #235 R7G-F6B / R7G-F6C — this provider no longer moves funds itself: every LOCK, release, refund and
 * split leg is a transaction signed with an explicit nonce, persisted before it is broadcast, and made
 * final only on corroborated evidence (wdk-lock-authority.ts, wdk-outbound-authority.ts). It supplies the
 * accounts, the signing and the read-only reconciliation of legacy transfer() attempts (#251). This does
 * NOT change `WDK_USDT_EVM`'s `PRODUCTION-INELIGIBLE` status (RFC-019).
 */
import WalletManagerEvm, { type WalletAccountEvm } from '@tetherto/wdk-wallet-evm'
import { createHash } from 'crypto'
import { EscrowError } from '../../common/errors'
import { config } from '../../config'
import type { SettlementProvider } from './escrow.service'
import { decimalAmountsEqual, receiptStatusOf } from './wdk-execution-truth'
import { wdkTransferAttemptRepository } from './wdk-transfer-attempt-repository'
import { createWdkRpc, type WdkRpc } from './wdk-rpc'

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

// LEGACY derivation only (#235 R7G-F6A-1). sha256(tradeId) % (2^31-1) is not unique (distinct
// trades collide, and it shares 0'/0/<i> with the treasury and buyer accounts), so it is no longer
// an authority: an escrow's account is its persisted Escrow.wdkAccountPath (wdkEscrowAccountPath()
// below). Kept for the read-only preflight and for tests that prove legacy rows keep this value.
export function escrowIndexFor(tradeId: string): number {
  const hash = createHash('sha256').update(tradeId).digest()
  return hash.readUInt32BE(0) % 0x7fffffff
}

// LEGACY derivation only (#235 R7G NF-B1). sha256('buyer:' + buyerId) % (2^31-1) collides between distinct
// buyers (a pair is found in ~18k random ids) and shares 0'/0/<i> with the treasury and legacy escrow
// accounts; the account is held by the Sails seed, not the buyer. No settlement path derives it any more:
// every WDK release pays the buyer's registered payout address (wdk-outbound-authority.ts). Kept for the
// read-only preflight (scripts/wdk-escrow-account-preflight.ts) and the tests that prove the collision.
export function buyerIndexFor(buyerId: string): number {
  const hash = createHash('sha256').update(`buyer:${buyerId}`).digest()
  return hash.readUInt32BE(0) % 0x7fffffff
}

/** The escrow fields that identify its WDK account. */
export type WdkEscrowAccountIdentity = {
  id: string
  wdkAccountScheme?: string | null
  wdkAccountPath?: string | null
  multisigAddr?: string | null
}
export type WdkEscrowInput = WdkEscrowAccountIdentity & { tradeId: string; lockedAmount: string }

const ACCOUNT_PATH_BY_SCHEME: Record<string, RegExp> = {
  LEGACY_TRADE_HASH_V0: /^0'\/0\/[1-9][0-9]{0,9}$/,
  ALLOCATED_V1: /^1'\/0\/(0|[1-9][0-9]{0,9})$/,
}
const MAX_NON_HARDENED_INDEX = 0x7fffffff

/**
 * #235 R7G-F6A-1 - WDK_ESCROW_ACCOUNT_STABILITY_V1. The escrow's account is the derivation path the
 * database persisted for it (allocated on INSERT, or the legacy path the migration recorded), never
 * a value recomputed from the trade. Anything else fails closed. Same checks as the database CHECK.
 */
export function wdkEscrowAccountPath(escrow: WdkEscrowAccountIdentity): string {
  const path = escrow.wdkAccountPath
  const pattern = escrow.wdkAccountScheme ? ACCOUNT_PATH_BY_SCHEME[escrow.wdkAccountScheme] : undefined
  if (!path || !pattern || !pattern.test(path) || Number(path.split('/')[2]) > MAX_NON_HARDENED_INDEX) {
    throw new EscrowError(
      `WDK_USDT_EVM escrow ${escrow.id} has no valid persisted account identity (scheme=${escrow.wdkAccountScheme ?? 'none'}, path=${path ?? 'none'}) — refusing to derive its account`
    )
  }
  return path
}

function outboundOnlyThroughAuthority(escrowId: string, operation: string): EscrowError {
  return new EscrowError(`WDK_USDT_EVM ${operation} for escrow ${escrowId} is executed only by the signed outbound authority (wdk-outbound-authority.ts)`, 'UNAVAILABLE')
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
    this.wallet = new WalletManagerEvm(config.wdk.seedPhrase, { provider: config.wdk.rpcUrl, ...(config.wdk.chainId ? { chainId: config.wdk.chainId } : {}) })
    return this.wallet
  }

  private rpcClient: WdkRpc | null = null

  /** #235 R7G-F6B — the JSON-RPC primitives WDK does not expose safely (wdk-rpc.ts), on the pinned chain. */
  rpc(): WdkRpc {
    if (this.rpcClient) return this.rpcClient
    if (!config.wdk.chainId) {
      throw new EscrowError('WDK_USDT_EVM requires WDK_CHAIN_ID: no WDK economic operation runs on an unpinned chain', 'UNAVAILABLE')
    }
    this.rpcClient = createWdkRpc(config.wdk.rpcUrl, config.wdk.chainId)
    return this.rpcClient
  }

  /**
   * #235 R7G-F6B — WDK_CHAIN_ID_PINNING_V1. The RPC must serve exactly the configured chain, checked before
   * every economic operation (an endpoint behind a failover can change). Returns the pinned chain id.
   */
  async verifyNetwork(): Promise<number> {
    const rpc = this.rpc()
    const configured = config.wdk.chainId as number
    const reported = await rpc.chainId()
    if (reported !== BigInt(configured)) {
      throw new EscrowError(`WDK RPC serves chain ${reported}, but WDK_CHAIN_ID is ${configured} — refusing every WDK economic operation`, 'UNAVAILABLE')
    }
    return configured
  }

  private corroboratorClient: WdkRpc | null = null

  /**
   * #235 R7G-F6B-P1 — the corroborating endpoint (WDK_IRREVERSIBLE_RPC_CORROBORATION_V1): evidence authority
   * only, never used to broadcast. Missing, or the same URL as the primary, means no irreversible WDK
   * conclusion is available.
   */
  corroboratorRpc(): WdkRpc {
    if (this.corroboratorClient) return this.corroboratorClient
    const url = config.wdk.corroboratingRpcUrl
    if (!url) throw new EscrowError('WDK_CORROBORATING_RPC_URL is not configured: no irreversible WDK conclusion can be reached', 'UNAVAILABLE')
    if (url.toLowerCase() === config.wdk.rpcUrl.trim().toLowerCase()) {
      throw new EscrowError('WDK_CORROBORATING_RPC_URL is the primary WDK_RPC_URL: it cannot corroborate anything', 'UNAVAILABLE')
    }
    if (!config.wdk.chainId) throw new EscrowError('WDK_USDT_EVM requires WDK_CHAIN_ID: no WDK economic operation runs on an unpinned chain', 'UNAVAILABLE')
    if (config.wdk.rpcLabel === config.wdk.corroboratingRpcLabel) throw new EscrowError('WDK_RPC_LABEL and WDK_CORROBORATING_RPC_LABEL must name two different sources', 'UNAVAILABLE')
    this.corroboratorClient = createWdkRpc(url, config.wdk.chainId)
    return this.corroboratorClient
  }

  /** The corroborating endpoint must also serve exactly the pinned chain. */
  async verifyCorroboratorNetwork(): Promise<WdkRpc> {
    const rpc = this.corroboratorRpc()
    const reported = await rpc.chainId()
    if (reported !== BigInt(config.wdk.chainId as number)) {
      throw new EscrowError(`WDK corroborating RPC serves chain ${reported}, but WDK_CHAIN_ID is ${config.wdk.chainId} — no corroborated conclusion`, 'UNAVAILABLE')
    }
    return rpc
  }

  async treasuryAddress(): Promise<string> {
    return (await this.treasuryAccount()).getAddress()
  }

  /** The escrow's own account address, from its persisted identity (WDK_ESCROW_ACCOUNT_STABILITY_V1). */
  async escrowAddress(escrow: WdkEscrowAccountIdentity): Promise<string> {
    return (await this.escrowAccount(escrow)).getAddress()
  }

  /** Signs locally with the treasury key; WDK's signTransaction() neither populates nor broadcasts. */
  async signTreasuryTransaction(tx: Parameters<WalletAccountEvm['signTransaction']>[0]): Promise<string> {
    return (await this.treasuryAccount()).signTransaction(tx)
  }

  private async treasuryAccount(): Promise<WalletAccountEvm> {
    return this.getWallet().getAccount(0)
  }

  // The persisted path is the authority; a persisted economic address (set by a completed lock) must
  // be what that path derives, otherwise nothing is done with this account.
  private async escrowAccount(escrow: WdkEscrowAccountIdentity): Promise<WalletAccountEvm> {
    const account = await this.getWallet().getAccountByPath(wdkEscrowAccountPath(escrow))
    if (escrow.multisigAddr) {
      const derived = await account.getAddress()
      if (derived.toLowerCase() !== escrow.multisigAddr.toLowerCase()) {
        throw new EscrowError(
          `WDK_USDT_EVM escrow ${escrow.id}: its account path derives ${derived}, not its persisted address ${escrow.multisigAddr} — refusing to use either`
        )
      }
    }
    return account
  }

  // Inspection helper, not part of the SettlementProvider interface: the address of account 0'/0/<index>
  // (the reconciler reads the treasury, index 0). #235 R7G NF-B1: never a settlement destination - a
  // Sails-seed account is not a buyer's wallet.
  async getAccountAddress(index: number): Promise<string> {
    const account = await this.getWallet().getAccount(index)
    return account.getAddress()
  }

  // Issue #251 - the reconciler's ONLY point of contact with this provider's wallet/chain access.
  // #235 R7G-F6C: it now serves only legacy transfer() attempts - the transfer() path and its
  // ensureAttempt() writer were removed; signed outbound converges in wdk-outbound-authority.ts.
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
    escrow: WdkEscrowInput,
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
        const account = await this.escrowAccount(escrow)
        const receipt = await account.getTransactionReceipt(latest.txHash)
        if (!receipt) {
          return { outcome: 'PENDING', reason: `WdkTransferAttempt ${latest.id}'s transaction ${latest.txHash} is not yet confirmed on-chain — remains pending, no resubmission.` }
        }
        const status = receiptStatusOf(receipt)
        if (status === 1) return { outcome: 'CONFIRMED', txHash: latest.txHash }
        if (status === null) {
          // #235 R7G-F6B — NF2: no recognizable status is unresolved, never a revert.
          return { outcome: 'PENDING', reason: `WdkTransferAttempt ${latest.id}'s transaction ${latest.txHash} has a receipt with no recognizable status (${JSON.stringify((receipt as { status?: unknown }).status)}) — unresolved, no resubmission.` }
        }
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

      case 'SIGNED':
      case 'NONCE_CONSUMED_ELSEWHERE':
        // #235 R7G-F6B — signed-raw states exist only for LOCK, which this terminal reconciler never reads.
        return { outcome: 'MISMATCH', reason: `WdkTransferAttempt ${latest.id} is ${latest.status}, a signed-transaction LOCK state, on a ${operationType} attempt.` }

      default: {
        const exhaustive: never = latest.status
        return { outcome: 'MISMATCH', reason: `WdkTransferAttempt ${latest.id} has an unrecognized status: ${String(exhaustive)}` }
      }
    }
  }

  // #235 R7G-F6B — a WDK LOCK is no longer a transfer() call (RPC-chosen nonce, hash known only after
  // broadcast). It is signed, persisted and broadcast by wdk-lock-authority.ts, which escrow.service's
  // lockFunds() uses for this rail; nothing else may lock WDK funds.
  async lockFunds(escrow: WdkEscrowInput): Promise<{ txId: string; address: string }> {
    throw new EscrowError(`WDK_USDT_EVM LOCK for escrow ${escrow.id} is executed only by the signed-transaction LOCK authority (wdk-lock-authority.ts)`, 'UNAVAILABLE')
  }

  // #235 R7G-F6C — WDK outbound (release / refund / split) is no longer a transfer() call either (RPC-chosen
  // nonce, hash known only after broadcast, a revert of the escrow claim on any error: DF1). Each leg is signed
  // by the escrow's own account, persisted, then broadcast, by wdk-outbound-authority.ts, which escrow.service
  // uses for this rail; nothing else may move WDK escrow funds.
  async releaseFunds(escrow: WdkEscrowInput): Promise<{ txId: string }> {
    throw outboundOnlyThroughAuthority(escrow.id, 'RELEASE')
  }

  async refundFunds(escrow: WdkEscrowInput): Promise<{ txId: string }> {
    throw outboundOnlyThroughAuthority(escrow.id, 'REFUND')
  }

  async splitFunds(escrow: WdkEscrowInput): Promise<{ txIds: string[] }> {
    throw outboundOnlyThroughAuthority(escrow.id, 'SPLIT')
  }

  /** #235 R7G-F6C — signs one outbound leg with the escrow's own account (its persisted path; see escrowAccount()). */
  async signEscrowTransaction(escrow: WdkEscrowAccountIdentity, tx: Parameters<WalletAccountEvm['signTransaction']>[0]): Promise<string> {
    return (await this.escrowAccount(escrow)).signTransaction(tx)
  }
}

export const wdkSettlementProvider = new WdkSettlementProvider()
