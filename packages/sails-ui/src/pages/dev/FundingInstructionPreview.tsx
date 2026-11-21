/** Dev-only (see App.tsx): FundingInstructionCard and the recorded-funding TradeSpecs rows, with example data only. */
import { useState } from 'react'
import { deriveCurrentAction } from '../../lib/currentAction'
import { deriveFundingInstruction, deriveFundingRecordRows, type FundingEscrow } from '../../lib/fundingInstruction'
import { CurrentActionCard } from '../../components/trade/CurrentActionCard'
import { FundingInstructionCard } from '../../components/trade/FundingInstructionCard'
import { TradeSpecs } from '../../components/trade/TradeSpecs'

// Test-format placeholders, not real addresses or transactions.
const ADDRESS = 'tb1qexampleescrowmultisigaddress000000000000000000000000000000'
const TXID = '0000000000000000000000000000000000000000000000000000000000example'

const base: FundingEscrow = {
  type: 'MULTISIG', status: 'CREATED', asset: 'BTC', lockedAmount: '0.01000000', multisigAddr: ADDRESS,
  txLockId: null, txLockVout: null, fundedAmount: null,
  feePolicyVersionId: null, snapshotProtocolFeeRate: null, snapshotFeeCollectionWaivedPreFunding: null,
}
const policy = { feePolicyVersionId: 'policy-example', snapshotProtocolFeeRate: '0.005' }

const CREATED: { title: string; escrow: FundingEscrow; isSeller: boolean }[] = [
  { title: 'Vendedor — escrow sem política de taxa (valor mínimo)', escrow: base, isSeller: true },
  { title: 'Vendedor — política de taxa (total exato não informado)', escrow: { ...base, ...policy }, isSeller: true },
  { title: 'Vendedor — política de taxa, reserva dispensada (valor exato)', escrow: { ...base, ...policy, snapshotFeeCollectionWaivedPreFunding: true }, isSeller: true },
  { title: 'Vendedor — endereço ainda não gerado', escrow: { ...base, multisigAddr: null }, isSeller: true },
  { title: 'Comprador', escrow: base, isSeller: false },
]
const LOCKED: { title: string; escrow: FundingEscrow }[] = [
  { title: 'FUNDS_LOCKED com transação e valor registrados', escrow: { ...base, ...policy, status: 'FUNDS_LOCKED', txLockId: TXID, txLockVout: 0, fundedAmount: '1005000' } },
  { title: 'FUNDS_LOCKED sem esses campos', escrow: { ...base, status: 'FUNDS_LOCKED' } },
]

export function FundingInstructionPreview() {
  const [last, setLast] = useState('nenhum')
  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div role="note" className="rounded-lg border border-brand-warning/25 bg-brand-warning/10 text-brand-warning text-sm px-4 py-3">
        Pré-visualização de desenvolvimento — dados de exemplo
      </div>
      <p className="mt-3 text-sm text-brand-text-secondary" aria-live="polite">Último clique: {last}</p>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        {CREATED.map((c) => {
          const view = deriveFundingInstruction({ escrow: c.escrow, isBuyer: !c.isSeller, isSeller: c.isSeller, assetLabel: 'BTC' })
          return (
            <section key={c.title}>
              <h1 className="mb-2 text-xs font-mono text-brand-text-muted">{c.title}</h1>
              <CurrentActionCard
                view={deriveCurrentAction({ status: 'CREATED', isBuyer: !c.isSeller, isSeller: c.isSeller })}
                acting={false}
                onAction={(a) => setLast(`${c.title}: ${a}`)}
                onOpenDispute={() => setLast(`${c.title}: disputa`)}
              >
                {view && <FundingInstructionCard view={view} />}
              </CurrentActionCard>
            </section>
          )
        })}
        {LOCKED.map((c) => (
          <section key={c.title}>
            <h1 className="mb-2 text-xs font-mono text-brand-text-muted">{c.title}</h1>
            <TradeSpecs
              title="Detalhes do trade"
              rows={[{ label: 'Tipo de escrow', value: 'MULTISIG', mono: true }, ...deriveFundingRecordRows(c.escrow)]}
            />
          </section>
        ))}
      </div>
    </div>
  )
}
