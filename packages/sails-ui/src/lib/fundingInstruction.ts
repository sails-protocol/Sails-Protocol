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
  if (a.startsWith('tb1')) return 'Bitcoin testnet ou signet'
  return null
}

function addressFacts(e: FundingEscrow): FundingFact[] {
  const address = e.multisigAddr
  return [
    address
      ? { label: 'Endereço do escrow', value: address, mono: true, copy: address }
      : { label: 'Endereço do escrow', value: 'Ainda não disponível' },
    { label: 'Rede', value: (address && bitcoinNetworkFromAddress(address)) ?? 'Não disponível' },
  ]
}

export function deriveFundingInstruction(i: { escrow: FundingEscrow; isBuyer: boolean; isSeller: boolean; assetLabel: string }): FundingInstructionView | null {
  const e = i.escrow
  if (e.type !== 'MULTISIG' || e.status !== 'CREATED' || (!i.isBuyer && !i.isSeller)) return null

  if (!i.isSeller) {
    return {
      viewer: 'buyer',
      title: 'Endereço de depósito do escrow',
      facts: addressFacts(e),
      requirements: [],
      note: e.multisigAddr ? 'Você pode conferir o depósito num explorador de blocos.' : 'O endereço aparece depois que você e o vendedor registrarem suas chaves no escrow.',
      copyLabel: 'Copiar endereço',
    }
  }

  const rule = amountRule(e)
  const amount = `${e.lockedAmount} ${i.assetLabel}`
  const title = !e.multisigAddr ? 'O endereço de depósito ainda não está disponível'
    : rule === 'atLeast' ? `Deposite pelo menos ${amount} neste endereço`
    : rule === 'exact' ? `Deposite exatamente ${amount} neste endereço`
    : 'O valor exato do depósito não está disponível nesta tela'
  const amountFact: FundingFact = rule === 'atLeast' ? { label: 'Valor mínimo', value: amount }
    : rule === 'exact' ? { label: 'Valor exato', value: amount }
    : { label: 'Valor exato', value: 'Não disponível nesta tela' }

  const requirements = [
    rule === 'atLeast'
      ? 'Um único depósito (uma só saída de transação) com o valor mínimo. Depósitos separados não são somados.'
      : 'Valor exato numa só saída de transação. Valores abaixo, acima ou divididos em mais de um depósito são recusados.',
    ...(rule === 'exactUnavailable'
      ? [`O valor exato é ${amount} mais a reserva máxima da taxa do protocolo, e esse total não é informado nesta tela. Não deposite sem conhecê-lo.`]
      : []),
    'Aguarde as confirmações exigidas pelo nó Sails antes de registrar o bloqueio. O número exigido não é informado nesta tela.',
  ]

  return {
    viewer: 'seller',
    title,
    facts: [amountFact, ...addressFacts(e)],
    requirements: e.multisigAddr ? requirements : ['O endereço é gerado depois que você e o comprador registrarem suas chaves no escrow. Não deposite antes de ele aparecer aqui.'],
    note: 'Depois de enviar, toque em "Bloquear fundos": o nó Sails confere o depósito e recusa se ainda não o encontrar.',
    copyLabel: 'Copiar endereço',
  }
}

/** TradeSpecs rows for the funding outpoint the server recorded at lock; only fields that are present. */
export function deriveFundingRecordRows(e: FundingEscrow): FundingFact[] {
  if (e.type !== 'MULTISIG' || !e.txLockId) return []
  return [
    { label: 'Depósito registrado pelo nó Sails', value: e.txLockId, mono: true, copy: e.txLockId },
    ...(e.txLockVout !== null && e.txLockVout !== undefined ? [{ label: 'Saída registrada (vout)', value: String(e.txLockVout), mono: true }] : []),
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
    return 'O nó Sails ainda não encontrou o depósito exigido neste endereço. Confira o valor e aguarde as confirmações antes de tentar novamente.'
  }
  if (/confirmation\(s\)\. Refusing to lock funds/.test(message)) {
    return 'O depósito encontrado neste endereço ainda não tem as confirmações exigidas pelo nó Sails. Tente novamente mais tarde.'
  }
  return null
}
