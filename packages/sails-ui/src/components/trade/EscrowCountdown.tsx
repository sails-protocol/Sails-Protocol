/**
 * Escrow timelock countdown (2026-07-29, requested directly after
 * finding it: `Escrow.timelockHours`/`expiresAt` are real fields —
 * `escrow.service.ts`'s `lock()` sets `expiresAt = lockedAt +
 * timelockHours` (that file's own line, ~403) — but nothing in this UI
 * ever rendered them before this. Binance P2P/HodlHodl both show this
 * exact countdown on their own trade screens.
 *
 * Framed carefully: `expiresAt` is only ever *set* in the real backend,
 * never *checked* anywhere else (no cron job, no auto-refund route —
 * confirmed by grepping the whole backend for `expiresAt`). For a real
 * MULTISIG/LIGHTNING_HODL escrow this is a genuine Bitcoin-script
 * timelock — passing it makes a refund *path* spendable on-chain, which
 * is enforced by Bitcoin consensus itself, not by this app polling
 * anything — so the copy below says "libera reembolso", never implies
 * this app automatically does something when the clock hits zero.
 */
import { useEffect, useState } from 'react'
import { InfoTooltip } from '../ui/InfoTooltip'
import type { EscrowStatus } from '../../types'

function formatRemaining(ms: number): string {
  const totalMinutes = Math.floor(Math.abs(ms) / 60000)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return h > 0 ? `${h}h ${m}min` : `${m}min`
}

export function EscrowCountdown({
  expiresAt,
  timelockHours,
  status,
}: {
  expiresAt: string | null
  timelockHours: number
  status: EscrowStatus
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!expiresAt) return
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [expiresAt])

  if (status === 'COMPLETED' || status === 'REFUNDED') return null

  if (!expiresAt) {
    return (
      <div className="mt-3 flex items-center gap-1.5 text-xs text-brand-text-muted">
        <span>Timelock: {timelockHours}h após o bloqueio dos fundos</span>
        <InfoTooltip text="Prazo do escrow. Só começa a contar quando os fundos forem bloqueados. Depois dele, o escrow prevê um caminho de reembolso ao vendedor. Esta interface não executa nada automaticamente." />
      </div>
    )
  }

  const remainingMs = new Date(expiresAt).getTime() - now
  const expired = remainingMs <= 0

  return (
    <div
      className={`mt-3 flex items-center gap-1.5 text-xs ${expired ? 'text-brand-danger-fg' : 'text-brand-text-muted'}`}
    >
      <span>
        {expired
          ? `Timelock expirado há ${formatRemaining(remainingMs)}`
          : `Timelock expira em ${formatRemaining(remainingMs)}`}
      </span>
      <InfoTooltip text="Prazo do escrow, contado a partir do bloqueio dos fundos. Depois dele, o escrow prevê um caminho de reembolso ao vendedor. Esta interface não executa nada automaticamente." />
    </div>
  )
}
