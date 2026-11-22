/**
 * Soft, non-blocking warning for market conversations (research note, 2026-11-22): a message that looks like it moves
 * payment outside the trade (a PIX key, phone, e-mail, wa.me / t.me link, "manda direto", "pago por fora") gets a
 * reminder that only the trade with escrow protects the amount. A UI heuristic only: it never blocks, never sends
 * anything and never claims to detect fraud. Pure.
 */
const PATTERNS: readonly RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.]+/, // e-mail
  /(?:\+?\d[\s().-]?){10,}/, // phone or a long number (CPF/CNPJ-like key)
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // random PIX key
  /\b(?:wa\.me|t\.me|api\.whatsapp\.com|chat\.whatsapp\.com)\//i,
  /\bchave\s+pix\b|\bmeu\s+pix\b/i,
  /\bmanda\s+direto\b|\bpag[oa]\s+por\s+fora\b|\bfora\s+do\s+(?:trade|app|escrow)\b/i,
]

export function looksOffTrade(text: string): boolean {
  return PATTERNS.some((re) => re.test(text))
}
