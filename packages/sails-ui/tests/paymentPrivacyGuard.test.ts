/**
 * Payment instruction privacy guard (DECISIONS.md, CTO D4, 2026-11-23): the raw payment instruction (and any
 * salt or digest of it) is shown only inside the trade view to the two parties. It is never written to the
 * console, a toast, analytics, localStorage/sessionStorage or a URL. This scans `src` for a sink call whose
 * statement (the line and the two after it) names a payment-instruction field.
 * shortcut: line-window match, not a data-flow analysis; a value renamed before reaching a sink is not caught.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const SRC = join(__dirname, '..', 'src')
// src/demo/ is skipped on purpose: its save() persists the simulated server's state (fictional data, demo only) to
// sessionStorage, which the PM accepted as the demo backend's storage, not a UI cache (DECISIONS.md, CTO D4).
const SKIP = join(SRC, 'demo')
const SINK = /\bconsole\.\w+\(|\b(local|session)Storage\b|\.setItem\(|\btoast(\.\w+)?\(|\bsearchParams\b|\bURLSearchParams\b|\bhistory\.(push|replace)State\(|\b(track|analytics|gtag|posthog)\b/
const PAYMENT_FIELD = /paymentDetails|paymentInstruction|instructionDigest|instructionSalt|paymentDigest|paymentSalt/i

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return p === SKIP ? [] : files(p)
    return /\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

export function leaks(source: string): number[] {
  const lines = source.split('\n')
  return lines.flatMap((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line) || !SINK.test(line)) return []
    return PAYMENT_FIELD.test(lines.slice(i, i + 3).join('\n')) ? [i + 1] : []
  })
}

describe('payment instruction privacy (CTO D4)', () => {
  it('catches a planted leak and ignores ordinary code', () => {
    expect(leaks("console.log('x', trade.offer.paymentDetails)")).toEqual([1])
    expect(leaks("localStorage.setItem('k',\n  JSON.stringify({ paymentDetails }))")).toEqual([1])
    expect(leaks("toast.success(t('copied'))\nconst a = 1\nconst b = 2\nconst d = offer.paymentDetails")).toEqual([])
    expect(leaks('// toast never shows paymentDetails')).toEqual([])
  })

  it('no file in src sends a payment instruction to the console, a toast, storage, analytics or a URL', () => {
    const found = files(SRC).flatMap((f) => leaks(readFileSync(f, 'utf8')).map((n) => `${relative(SRC, f)}:${n}`))
    expect(found).toEqual([])
  })
})
