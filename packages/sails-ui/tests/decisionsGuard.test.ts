/**
 * Decisions guard (consolidation plan step 4): locks the Product Owner and CTO decisions of 2026-11-21
 * (DECISIONS.md) so no agent undoes them by accident. Copy rules read the i18n catalogs; structure rules
 * read source files (the patterns checked never appear in their comments).
 */
import { readdirSync, readFileSync } from 'fs'
import { join, sep } from 'path'
import { CATALOGS, type MessageKey } from '../src/i18n/catalog'
import type { Message } from '../src/i18n/define'
import { PAYMENT_METHODS_FILTERABLE } from '../src/data/mock'
import { FUTURE_PAYMENT_METHODS, hasAvailablePaymentMethod } from '../src/lib/paymentMethods'

const SRC = join(__dirname, '..', 'src')
const code = (p: string) => readFileSync(join(SRC, p), 'utf8')
const texts = (m: Message): string[] => (typeof m === 'string' ? [m] : Object.values(m).filter((v): v is string => typeof v === 'string'))
const entries = (locales: (keyof typeof CATALOGS)[]) => locales.flatMap((l) =>
  (Object.entries(CATALOGS[l]) as [MessageKey, Message][]).flatMap(([key, msg]) => texts(msg).map((text) => ({ l, key, text }))))
const ALL = entries(Object.keys(CATALOGS) as (keyof typeof CATALOGS)[])
const PT = entries(['pt-BR'])
const hits = (list: typeof ALL, re: RegExp) => list.filter((e) => re.test(e.text)).map((e) => `${e.l} ${e.key}: ${e.text.slice(0, 90)}`)

describe('decisions guard: copy (DECISIONS.md "Textos honestos" and copy audit)', () => {
  it('no invented split ratio (the contract takes any split)', () => expect(hits(ALL, /50\s?\/\s?50/)).toEqual([]))
  it('never tells people to agree payment details in the chat', () => expect(hits(PT, /combin\w* (?:os dados )?pelo chat/i)).toEqual([]))
  it('no third-party product comparison', () => expect(hits(ALL, /\bKeet\b/)).toEqual([]))
  it('no internal names in user copy', () => expect(hits(ALL, /\bRFC-\d|\bMULTISIG\b|AES-256/)).toEqual([]))
  it('no absolute "never leaves your device" claim', () => expect(hits(ALL, /nunca sai do seu|never leaves your|nunca sale de tu|ne quitte jamais|verlässt nie/i)).toEqual([]))
  it('a dispute is "decision recorded", never "resolved"', () => expect(hits(PT, /disputa resolvida|^resolvida$/i)).toEqual([]))
  it('payment details are never shown as fixed or verified (EPM, #735 §14.3)', () =>
    expect(hits(PT, /dados de pagamento[^.]{0,40}\b(?:ficam|são|estão)\s+(?:fixos|congelados|verificados|garantidos)/i)).toEqual([]))
  it('reputation is never a 0-5 scale (UX-048: unbounded score, may be negative)', () => {
    expect(hits(ALL.filter((e) => e.key.startsWith('agent.')), /0\s?[–-]\s?5|0 e 5|0 and 5/)).toEqual([])
    expect(code('components/agent/AgentIntentionPanel.tsx')).not.toMatch(/max="5"/)
  })
  it('an automatic suggestion is never said to take effect by itself (it goes back to the human arbitrator)', () =>
    expect(hits(ALL, /passa a valer|takes effect|entra en vigor|prend effet|, gilt er/i)).toEqual([]))
  it('pt-BR stays in the neutral register (no "pra", "pro", "tá")', () => expect(hits(PT, /\b(?:pra|pro|tá)\b/i)).toEqual([]))
})

describe('decisions guard: structure', () => {
  it('Lightning direto is a future modality: never filterable and never enough to open a trade (CTO 28)', () => {
    expect(FUTURE_PAYMENT_METHODS.has('LIGHTNING_DIRECT')).toBe(true)
    expect((PAYMENT_METHODS_FILTERABLE as readonly string[]).filter((m) => FUTURE_PAYMENT_METHODS.has(m))).toEqual([])
    expect(hasAvailablePaymentMethod({ paymentMethod: 'LIGHTNING_DIRECT' })).toBe(false)
    expect(code('demo/demoBackend.ts')).not.toMatch(/LIGHTNING_DIRECT/)
  })

  it('the demo shows no "Verificado" seal until a verification criterion exists', () => {
    expect(code('demo/demoBackend.ts')).toMatch(/verified: false,/)
  })

  it('one solid orange per screen in the trade chat: tonal Send, blue own bubbles', () => {
    expect(code('components/chat/ChatWindow.tsx')).toMatch(/variant="secondary" onClick=\{handleSend\}/)
    expect(code('components/chat/ChatMessage.tsx')).not.toMatch(/bg-primary/)
    expect(code('components/chat/ChatMessage.tsx')).toMatch(/bg-brand-info-solid text-brand-on-info/)
  })

  it('signed out, in-page connect buttons and "Nova oferta" are tonal (the topbar holds the solid orange)', () => {
    for (const p of ['pages/ActiveTrades.tsx', 'pages/Disputes.tsx', 'pages/MyOffers.tsx', 'pages/TradeHistory.tsx']) {
      expect(code(p)).toMatch(/variant: 'secondary', className: 'min-h-10 touch:min-h-11 px-4' \}\)\)\}>\{t\('trades\.connect'\)\}/)
    }
    expect(code('pages/Marketplace.tsx')).toMatch(/variant: user \? 'default' : 'secondary'/)
  })

  it('small icons use the 14px token, never ad-hoc 12-14px classes', () => {
    const allowed = /components\/ui\/(?:AssetIcon|UserAvatar|checkbox|select)\.tsx$/
    const bad: string[] = []
    for (const d of ['components', 'pages']) {
      for (const f of readdirSync(join(SRC, d), { recursive: true }) as string[]) {
        const p = `${d}/${f}`.split(sep).join('/')
        if (!p.endsWith('.tsx') || allowed.test(p)) continue
        if (/\bh-3(?:\.5)? w-3(?:\.5)?\b|\bw-3(?:\.5)? h-3(?:\.5)?\b/.test(code(p))) bad.push(p)
      }
    }
    expect(bad).toEqual([])
  })
})

describe('decisions guard: Merchant journey (CTO 38, PO 2026-11-23)', () => {
  const merchant = ALL.filter((e) => /^(?:profile\.merchant\.|faq\.merchant)/.test(e.key))
  it('no number except the one reference fee, and no progress, goal or unlock wording', () => {
    expect(merchant.filter((e) => e.key !== 'profile.merchant.referenceFee' && /\d/.test(e.text)).map((e) => `${e.l} ${e.key}`)).toEqual([])
    expect(hits(merchant, /\{(?:done|goal)\}|faltam|desbloquead|unlocked|débloqué|freigeschaltet|ranking|sequência|streak/i)).toEqual([])
  })
  it('the card has no progress bar', () => expect(code('pages/markets/MerchantProgram.tsx')).not.toMatch(/Progress\b/))
})
