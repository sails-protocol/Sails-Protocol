/**
 * CTO 36 + complementary note (2026-11-22): no proposed economic number is shown as active policy. The 35/30/25/10 split and
 * the Merchant fees 0,36 / 0,32 / 0,28 % never appear in src; the 0,40 % reference fee appears only in the one key that
 * words it as "proposed, not charged yet" (profile.merchant.referenceFee).
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..', 'src')
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n)
  return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
})
const FORBIDDEN = [/35\s*\/\s*30\s*\/\s*25\s*\/\s*10/, /0[,.]36\s?%/, /0[,.]32\s?%/, /0[,.]28\s?%/]
const REFERENCE_FEE = /0[,.]40\s?%/
const REFERENCE_KEY = "'profile.merchant.referenceFee'"

function economyViolations(path: string, text: string): string[] {
  return text.split('\n').flatMap((line, i) => {
    const at = `${path}:${i + 1}`
    const out = FORBIDDEN.filter((re) => re.test(line)).map((re) => `${at} ${re}`)
    if (REFERENCE_FEE.test(line) && !line.includes(REFERENCE_KEY)) out.push(`${at} 0,40% outside ${REFERENCE_KEY}`)
    return out
  })
}

describe('economy copy guard (CTO 36)', () => {
  it('src never shows the split, the Merchant fees or the reference fee outside its key', () => {
    expect(files(SRC).flatMap((f) => economyViolations(f, readFileSync(f, 'utf8')))).toEqual([])
  })

  it('the rule catches what it should and allows the reference wording', () => {
    expect(economyViolations('x', "'a': 'Taxa 0,40% ativa'")).toHaveLength(1)
    expect(economyViolations('x', "'a': 'fee 0.40 %'")).toHaveLength(1)
    expect(economyViolations('x', "'a': 'split 35/30/25/10'")).toHaveLength(1)
    expect(economyViolations('x', "'a': 'Merchant 0,36%, 0.32 % e 0,28 %'")).toHaveLength(3)
    expect(economyViolations('x', "    'profile.merchant.referenceFee': 'Taxa de referência proposta: 0,40%, ainda não cobrada.',")).toEqual([])
  })
})
