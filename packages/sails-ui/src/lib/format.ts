/**
 * One number/money/date policy (DESIGN_SYSTEM.md 7.1, provisório — ratificação pendente):
 * every number in the UI uses the pt-BR locale (grouping ".", decimal ","), whatever the
 * currency, so BRL, USD and crypto amounts in the same row read the same way.
 * Dates show the year only when it is not the current year.
 */
const LOCALE = 'pt-BR'

export function formatBrl(value: number): string {
  return value.toLocaleString(LOCALE, { style: 'currency', currency: 'BRL' })
}

/** US$ 1.234,56 */
export function formatUsd(value: number): string {
  return value.toLocaleString(LOCALE, { style: 'currency', currency: 'USD' })
}

/** Crypto amount: trailing zeros trimmed, at most `decimals` places (0,0015). */
export function formatAmount(value: number, decimals = 8): string {
  return value.toLocaleString(LOCALE, { maximumFractionDigits: decimals })
}

/** 20/11 14:32 this year, 03/09/2025 14:32 otherwise. */
export function formatDateTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const year = d.getFullYear() === now.getFullYear() ? undefined : 'numeric'
  return d.toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', year, hour: '2-digit', minute: '2-digit' })
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
}

/** Exact USD decimal string from the record (e.g. "1.002" -> US$ 1,002), never rounded to cents. Same style as formatPrice. */
export function formatUsdExact(decimal: string): string {
  const n = Number(decimal)
  if (!Number.isFinite(n)) return `US$ ${decimal}`
  return n.toLocaleString(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 12 })
}

/** Month and year in pt-BR ("nov. de 2026") for "Membro desde"; empty for an unparseable date (never a guess). */
export function formatMonthYear(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat(LOCALE, { month: 'short', year: 'numeric' }).format(d)
}
