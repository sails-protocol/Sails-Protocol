/** Dev-only (see App.tsx): every role x status of CurrentActionCard, with example data. */
import { useState } from 'react'
import type { EscrowStatus } from '../../types'
import { deriveCurrentAction } from '../../lib/currentAction'
import { CurrentActionCard } from '../../components/trade/CurrentActionCard'

const STATUSES: EscrowStatus[] = ['CREATED', 'FUNDS_LOCKED', 'PAYMENT_PENDING', 'COMPLETED', 'DISPUTED', 'REFUNDED', 'EXPIRED', 'SPLIT']
const ROLES = [
  { label: 'Vendedor', isBuyer: false, isSeller: true },
  { label: 'Comprador', isBuyer: true, isSeller: false },
  { label: 'Não participante', isBuyer: false, isSeller: false },
]

export function CurrentActionPreview() {
  const [acting, setActing] = useState(false)
  const [last, setLast] = useState('nenhum')

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div role="note" className="rounded-lg border border-brand-warning/25 bg-brand-warning/10 text-brand-warning text-sm px-4 py-3">
        Pré-visualização de desenvolvimento — dados de exemplo
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-brand-text-secondary">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={acting} onChange={(e) => setActing(e.target.checked)} />
          Simular ação em andamento
        </label>
        <span aria-live="polite">Último clique: {last}</span>
      </div>
      {STATUSES.map((status) => (
        <section key={status} className="mt-6">
          <h1 className="text-xs font-mono text-brand-text-muted">{status}</h1>
          <div className="grid gap-4 md:grid-cols-3">
            {ROLES.map((r) => (
              <div key={r.label}>
                <p className="mt-2 text-xs text-brand-text-muted">{r.label}</p>
                <CurrentActionCard
                  view={deriveCurrentAction({ status, ...r })}
                  acting={acting}
                  onAction={(a) => setLast(`${r.label} / ${status}: ${a}`)}
                  onOpenDispute={() => setLast(`${r.label} / ${status}: disputa`)}
                />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
