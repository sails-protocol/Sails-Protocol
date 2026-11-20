export function formatBrl(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function formatUsd(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export function formatAmount(value: number, decimals = 8): string {
  return value.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '')
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

/** Exact USD decimal string from the record (e.g. "1.002"), never rounded to cents. Same en-US style as formatPrice/formatUsd on the Market. */
export function formatUsdExact(decimal: string): string {
  const n = Number(decimal)
  if (!Number.isFinite(n)) return `$${decimal}`
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 12 })
}
