/**
 * View-model for FundingInstructionCard and the recorded-funding rows of
 * TradeSpecs. Pure and type-only, so it can be unit-tested without the SDK
 * runtime.
 *
 * There is no FundingState/FundingInstruction product contract, so this
 * only restates what the MULTISIG provider itself enforces at lock time
 * (src/modules/open-settlement/multisig.provider.ts findFundingCandidate /
 * noFundingCandidateError / lockFunds) and only shows fields the Escrow
 * record carries. It never says a deposit was seen, is confirming or is
 * confirmed: the platform does not report that before lock.
 *
 * Amount rule, exactly as the provider checks it:
 * - legacy escrow (no fee-policy snapshot): one confirmed output of AT
 *   LEAST lockedAmount at the address;
 * - fee-policy escrow: one confirmed output of EXACTLY lockedAmount + the
 *   maximum Protocol Fee reserve. That reserve is not in the Escrow
 *   contract, so the exact total is shown as unavailable, except when the
 *   reserve was waived before funding (reserve = 0, total = lockedAmount).
 * Either way the output must reach the server's required confirmation
 * depth, whose number the contract does not expose.
 */
import type { Escrow } from '@satsails/p2p-trading-sdk'
import { t } from '../i18n'

export type FundingEscrow = Pick<Escrow,
  'type' | 'status' | 'asset' | 'lockedAmount' | 'multisigAddr' | 'txLockId' | 'txLockVout' | 'fundedAmount'
  | 'feePolicyVersionId' | 'snapshotProtocolFeeRate' | 'snapshotFeeCollectionWaivedPreFunding'>

export interface FundingFact { label: string; value: string; mono?: boolean; copy?: string }

export interface FundingInstructionView {
  viewer: 'seller' | 'buyer'
  title: string
  facts: FundingFact[]
  requirements: string[]
  note: string
  copyLabel: string
}

export type FundingAmountRule = 'atLeast' | 'exact' | 'exactUnavailable'

// Same predicate as multisig.provider.ts isPolicyAware().
function amountRule(e: FundingEscrow): FundingAmountRule {
  const policyAware = !!e.feePolicyVersionId && e.snapshotProtocolFeeRate !== null && e.snapshotProtocolFeeRate !== undefined
  if (!policyAware) return 'atLeast'
  const zeroRate = Number(e.snapshotProtocolFeeRate) === 0
  return e.snapshotFeeCollectionWaivedPreFunding || zeroRate ? 'exact' : 'exactUnavailable'
}

/** Network from the address's own bech32 prefix; null when the prefix is not a known one. */
export function bitcoinNetworkFromAddress(address: string): string | null {
  const a = address.toLowerCase()
  if (a.startsWith('bcrt1')) return 'Bitcoin regtest'
  if (a.startsWith('bc1')) return 'Bitcoin mainnet'
  if (a.startsWith('tb1')) return t('escrow.funding.networkTestnet')
  return null
}

function addressFacts(e: FundingEscrow): FundingFact[] {
  const address = e.multisigAddr
  return [
    address
      ? { label: t('escrow.funding.address'), value: address, mono: true, copy: address }
      : { label: t('escrow.funding.address'), value: t('escrow.funding.notYet') },
    { label: t('escrow.funding.network'), value: (address && bitcoinNetworkFromAddress(address)) ?? t('escrow.funding.unavailable') },
  ]
}

export function deriveFundingInstruction(i: { escrow: FundingEscrow; isBuyer: boolean; isSeller: boolean; assetLabel: string }): FundingInstructionView | null {
  const e = i.escrow
  if (e.type !== 'MULTISIG' || e.status !== 'CREATED' || (!i.isBuyer && !i.isSeller)) return null

  if (!i.isSeller) {
    return {
      viewer: 'buyer',
      title: t('escrow.funding.buyerTitle'),
      facts: addressFacts(e),
      requirements: [],
      note: t(e.multisigAddr ? 'escrow.funding.buyerNoteExplorer' : 'escrow.funding.buyerNoteNoAddress'),
      copyLabel: t('escrow.funding.copyAddress'),
    }
  }

  const rule = amountRule(e)
  const amount = `${e.lockedAmount} ${i.assetLabel}`
  const title = !e.multisigAddr ? t('escrow.funding.titleNoAddress')
    : rule === 'atLeast' ? t('escrow.funding.titleAtLeast', { amount })
    : rule === 'exact' ? t('escrow.funding.titleExact', { amount })
    : t('escrow.funding.titleExactUnavailable')
  const amountFact: FundingFact = rule === 'atLeast' ? { label: t('escrow.funding.minAmount'), value: amount }
    : rule === 'exact' ? { label: t('escrow.funding.exactAmount'), value: amount }
    : { label: t('escrow.funding.exactAmount'), value: t('escrow.funding.unavailableHere') }

  const requirements = [
    t(rule === 'atLeast' ? 'escrow.funding.reqSingle' : 'escrow.funding.reqExact'),
    ...(rule === 'exactUnavailable' ? [t('escrow.funding.reqReserve', { amount })] : []),
    t('escrow.funding.reqConfirmations'),
  ]

  return {
    viewer: 'seller',
    title,
    facts: [amountFact, ...addressFacts(e)],
    requirements: e.multisigAddr ? requirements : [t('escrow.funding.reqNoAddress')],
    note: t('escrow.funding.note'),
    copyLabel: t('escrow.funding.copyAddress'),
  }
}

/** TradeSpecs rows for the funding outpoint the server recorded at lock; only fields that are present. */
export function deriveFundingRecordRows(e: FundingEscrow): FundingFact[] {
  if (e.type !== 'MULTISIG' || !e.txLockId) return []
  return [
    { label: t('escrow.funding.recordDeposit'), value: e.txLockId, mono: true, copy: e.txLockId },
    ...(e.txLockVout !== null && e.txLockVout !== undefined ? [{ label: t('escrow.funding.recordVout'), value: String(e.txLockVout), mono: true }] : []),
    // The provider writes the explorer's sats value here while other readers treat the column as BTC; never guess the unit.
    // fundedAmount is not shown: its unit is inconsistent in the backend (provider writes sats,
    // reconciliation reads BTC), so any rendering could be read as a usable amount. Pending CTO.
  ]
}

/**
 * Plain-language toast for the MULTISIG lock refusals; null for any other error.
 * shortcut: matches the provider's English EscrowError text (no reason code exists); switch to a code when the server sends one.
 */
export function lockRefusalMessage(err: unknown): string | null {
  const { code, message } = (err ?? {}) as { code?: unknown; message?: unknown }
  if (code !== 'ESCROW_ERROR' || typeof message !== 'string') return null
  if (/^No funding UTXO/.test(message)) {
    return t('escrow.funding.refusalNotFound')
  }
  if (/confirmation\(s\)\. Refusing to lock funds/.test(message)) {
    return t('escrow.funding.refusalConfirmations')
  }
  return null
}
