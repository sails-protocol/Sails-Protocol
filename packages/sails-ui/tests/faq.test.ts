import { FAQ_GROUPS, FAQ_ITEMS, faqAnchor, faqPath, faqSlugFromHash, protocolFeeRateLabel } from '../src/lib/faq'
import { CATALOGS, type MessageKey } from '../src/i18n/catalog'

describe('FAQ structure', () => {
  it('has the 13 approved questions, "corrigir-pagamento" (CTO D6) the 4 Merchant ones and "perder-tudo" (CTO 29), unique slugs, each in a known group with a question and an answer', () => {
    expect(FAQ_ITEMS).toHaveLength(19)
    expect(new Set(FAQ_ITEMS.map((i) => i.slug)).size).toBe(19)
    for (const i of FAQ_ITEMS) {
      expect(FAQ_GROUPS).toContain(i.group)
      expect(CATALOGS['pt-BR'][`faq.${i.key}.q` as MessageKey]).toBeTruthy()
      expect(CATALOGS['pt-BR'][(i.key === 'fees' ? 'faq.fees.answer' : `faq.${i.key}.a`) as MessageKey]).toBeTruthy()
    }
  })

  it('deep links resolve to their item and nothing else', () => {
    expect(faqPath('escrow')).toBe('/settings/help/faq#faq-escrow')
    expect(faqSlugFromHash('#faq-taxas')).toBe('taxas')
    expect(faqSlugFromHash(`#${faqAnchor('prazo')}`)).toBe('prazo')
    expect(faqSlugFromHash('#faq-corrigir-pagamento')).toBe('corrigir-pagamento')
    expect(faqSlugFromHash('#faq-nada')).toBeNull()
    expect(faqSlugFromHash('')).toBeNull()
  })
})

describe('protocolFeeRateLabel (escrow.snapshotProtocolFeeRate)', () => {
  it('shows nothing without a positive backend rate', () => {
    for (const r of [null, undefined, '', '0', '0.000', '-0.01', 'abc']) expect(protocolFeeRateLabel(r, 'pt-BR')).toBeNull()
  })
  it('formats the backend fraction as a percentage in the locale', () => {
    expect(protocolFeeRateLabel('0.0025', 'en')).toBe('0.25%')
    expect(protocolFeeRateLabel('0.0025', 'pt-BR')?.replace(/\s/g, ' ')).toBe('0,25%')
  })
})
