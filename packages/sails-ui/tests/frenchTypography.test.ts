/**
 * French typography (DECISIONS.md, PM 2026-11-23): a non-breaking space (U+00A0 or U+202F), never a normal one,
 * before « : ; ? ! » and inside guillemets, in every fr string.
 */
import { CATALOGS } from '../src/i18n/catalog'
import type { Message } from '../src/i18n/define'

const texts = (m: Message) => (typeof m === 'string' ? [m] : Object.values(m))
const BAD = / [:;?!]|« | »/

describe('French typography', () => {
  it('no fr string has a normal space before : ; ? ! or inside « »', () => {
    const bad = Object.entries(CATALOGS.fr).flatMap(([key, m]) => texts(m as Message).filter((s) => BAD.test(s)).map((s) => `${key}: ${s}`))
    expect(bad).toEqual([])
  })

  it('the rule catches the cases it is meant to', () => {
    expect(['Marché :', 'Supprimer ?', 'a ; b', 'Prêt !', '« x»', '«x »'].every((s) => BAD.test(s))).toBe(true)
    expect(['Marché :', 'Supprimer ?', '« x »', 'https://exemple.fr', '3:4'].some((s) => BAD.test(s))).toBe(false)
  })
})
