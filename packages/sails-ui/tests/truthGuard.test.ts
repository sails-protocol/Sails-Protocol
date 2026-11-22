/**
 * Truth and structure guard (DECISIONS.md, CTO 437; plan items 4.2 and 4.3).
 * Locks in decisions that are easy to undo by accident: forbidden user-facing copy and things that
 * must live in exactly one place. Copy rules look only at string literals and JSX text, never at
 * comments, so code can still explain why a rule exists.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { ASSET_CATALOG } from '../src/lib/assetCatalog'
import { PAYMENT_METHODS, PAYMENT_METHODS_FILTERABLE } from '../src/data/mock'
import { COUNTRY_PRIORITY_METHODS } from '../src/lib/paymentMethodMeta'
import { MULTISIG_SIGNING_HOLD } from '../src/lib/multisigSigningIntent'
import { LOOSE_WIRES } from '../src/lib/looseWires'
import { CATALOGS, type MessageKey } from '../src/i18n/catalog'
import type { Message } from '../src/i18n/define'

const SRC = join(__dirname, '..', 'src')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return files(p)
    return /\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

/** Removes // and /* *\/ comments (and JSX {/* *\/} comments) but keeps strings, so copy rules see only real text. */
export function stripComments(src: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += n ?? ''; i += 2; continue }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++ } i += 2; continue }
    out += c
    i++
  }
  return out
}

// Catalogs are checked per language below (every value, every locale), with key-level exemptions.
const SOURCES = files(SRC)
  .map((p) => ({ path: relative(SRC, p).replace(/\\/g, '/'), code: stripComments(readFileSync(p, 'utf8')) }))
  .filter((f) => !f.path.startsWith('i18n/areas/'))

// Legacy labels must keep rendering old records (DECISIONS: "ofertas antigas continuam mostrando o nome").
const LEGACY_LABEL_FILES = new Set(['lib/labels.ts'])

const COPY_RULES: { name: string; re: RegExp; skip?: Set<string> }[] = [
  { name: '"servidor" (the word is "nó Sails")', re: /servidor/i },
  { name: 'generic non-custodial claim', re: /n[ãa]o[ -]custodial|non-?custodial/i },
  // Score-like text ("82/100", "{score}/100"), not arithmetic such as `${v / 100}`.
  { name: 'reputation as a fraction', re: /(?:\d|\})\s?\/\s?100\b/ },
  { name: 'invented reputation metric', re: /%\s*positivo|Power Trader|Alta reputação/i },
  { name: 'misleading rail label', re: /Lightning HODL/ },
  // DECISIONS.md "Nós e mercados privados": the experience is Sails' own, no Nostr keys, relays or invites.
  { name: 'Nostr copy (npub, Nostr keys or relays)', re: /npub|nostr/i },
  { name: 'cash payment copy outside legacy labels', re: /Dinheiro em espécie|Dinheiro por correio|Depósito em lotérica/i, skip: LEGACY_LABEL_FILES },
]

describe('truth guard: forbidden user-facing copy', () => {
  for (const rule of COPY_RULES) {
    it(`no ${rule.name}`, () => {
      const hits = SOURCES.filter((f) => !rule.skip?.has(f.path)).flatMap((f) =>
        f.code.split('\n').flatMap((line, i) => (rule.re.test(line) ? [`${f.path}:${i + 1}: ${line.trim().slice(0, 120)}`] : [])),
      )
      expect(hits).toEqual([])
    })
  }
})

// The same rules in every language (DESIGN_SYSTEM.md 7.3). Legacy cash labels keep old records readable.
// The cash category label only groups those legacy methods; nothing new is offered under it.
const LEGACY_KEYS = /^labels\.(?:legacy\.|paymentCategory\.cash$)/
const CATALOG_RULES: { name: string; re: RegExp; skipKey?: RegExp }[] = [
  { name: 'server as the node word (servidor/server/serveur/Server)', re: /servidor|\bserver\b|serveur/i },
  { name: 'generic non-custodial claim', re: /n[ãa]o[ -]custodial|non-?custodial|no custodial|non[- ]?d[ée]positaire|non[- ]?gard[ée]|nicht[- ]?verwahr|verwahrungsfrei/i },
  { name: 'reputation as a fraction', re: /(?:\d|\})\s?\/\s?100\b/ },
  { name: 'invented reputation metric', re: /%\s*(?:positiv|positive|positivo|positif)|Power Trader|Alta reputação|High reputation|Alta reputación|Haute réputation|Hohe Reputation/i },
  { name: 'misleading rail label', re: /Lightning HODL/ },
  { name: 'Nostr copy', re: /npub|nostr/i },
  { name: 'cash payment copy outside legacy labels', re: /Dinheiro em espécie|Dinheiro (?:por|pelo) correio|Depósito em lotérica|\bcash\b(?! App)|efectivo|espèces|Bargeld/i, skipKey: LEGACY_KEYS },
]

const texts = (m: Message): string[] => (typeof m === 'string' ? [m] : Object.values(m).filter((v): v is string => typeof v === 'string'))
const ENTRIES = (Object.keys(CATALOGS) as (keyof typeof CATALOGS)[]).flatMap((locale) =>
  (Object.entries(CATALOGS[locale]) as [MessageKey, Message][]).flatMap(([key, msg]) => texts(msg).map((text) => ({ locale, key, text }))),
)

describe('truth guard: forbidden copy in every language', () => {
  for (const rule of CATALOG_RULES) {
    it(`no ${rule.name}`, () => {
      const hits = ENTRIES.filter((e) => !rule.skipKey?.test(e.key) && rule.re.test(e.text)).map((e) => `${e.locale} ${e.key}: ${e.text.slice(0, 100)}`)
      expect(hits).toEqual([])
    })
  }

  // Glossary (DESIGN_SYSTEM.md 7.3): when the pt-BR source says it, every translation says it the same way.
  const GLOSSARY: { pt: RegExp; en: RegExp; es: RegExp; fr: RegExp; de: RegExp }[] = [
    { pt: /nó Sails|nós Sails/i, en: /Sails nodes?/i, es: /nodos? Sails/i, fr: /nœuds? Sails/i, de: /Sails-Knoten/i },
    { pt: /Mercado aberto/i, en: /Open market/i, es: /Mercado abierto/i, fr: /Marché ouvert/i, de: /Offene[nrs]? Markt/i },
    { pt: /marcad[oa]s? como enviad/i, en: /marked as sent/i, es: /marc(?:ad[oa]s?|ó|ara|a) como enviad/i, fr: /marqu[ée]e?s? comme envoy/i, de: /als (?:gesendet|versendet) markiert/i },
    { pt: /marcado como concluído/i, en: /marked as completed/i, es: /marcado como completado/i, fr: /marqué comme terminé/i, de: /als abgeschlossen markiert/i },
  ]
  it('glossary terms keep their meaning in every language', () => {
    const pt = CATALOGS['pt-BR']
    const misses: string[] = []
    for (const [key, msg] of Object.entries(pt) as [MessageKey, Message][]) {
      for (const g of GLOSSARY) {
        if (!texts(msg).some((x) => g.pt.test(x))) continue
        for (const l of ['en', 'es', 'fr', 'de'] as const) {
          if (!texts(CATALOGS[l][key]).some((x) => g[l].test(x))) misses.push(`${l} ${key}: expected ${g[l]} — ${texts(CATALOGS[l][key])[0]?.slice(0, 90)}`)
        }
      }
    }
    expect(misses).toEqual([])
  })

  // A translation never makes a claim the pt-BR source does not make ("marcado como enviado" is not "verified").
  const CLAIMS: { pt: RegExp; tr: RegExp }[] = [
    { pt: /verific/i, tr: /\bverified\b|verificad[oa]s?\b|vérifiée?s?\b|verifiziert/i },
    { pt: /final|definitiv|irrevers/i, tr: /\bfinality\b|finalidad|finalité|final settlement|liquidación final|règlement définitif|endgültig|irrevers/i },
    // "aval" (vouch) is "se porter garant" in French: a reputation pledge, not a guarantee of funds.
    { pt: /garant|aval|apadrinh/i, tr: /\bguarantee|garantiz|garantiert|\bgarant(?:ie|i|ir)?\b/i },
    // Case-sensitive: "Safe" is the Gnosis Safe product name.
    { pt: /segur|proteg|guard/i, tr: /\bsafe(?:ly|ty)?\b|\bsecured?\b|\bsegur[oa]\b|\bsûre?\b|\bsicher\b|\bprotect|proteg|schütz/ },
    { pt: /custód|guard|mantém|controla/i, tr: /custod|verwahr/i },
  ]
  it('translations add no verification, finality, guarantee, safety or custody claim', () => {
    const pt = CATALOGS['pt-BR']
    const added: string[] = []
    for (const [key, msg] of Object.entries(pt) as [MessageKey, Message][]) {
      const source = texts(msg).join(' ')
      for (const l of ['en', 'es', 'fr', 'de'] as const) {
        const target = texts(CATALOGS[l][key]).join(' ')
        for (const c of CLAIMS) if (c.tr.test(target) && !c.pt.test(source)) added.push(`${l} ${key}: ${target.slice(0, 100)}`)
      }
    }
    expect(added).toEqual([])
  })
})

describe('structure guard: one home for each decision', () => {
  it('fundedAmount is never rendered (only dev fixtures may carry it)', () => {
    const hits = SOURCES.filter((f) => f.path.endsWith('.tsx') && !f.path.startsWith('pages/dev/') && /fundedAmount/.test(f.code)).map((f) => f.path)
    expect(hits).toEqual([])
  })

  it('MULTISIG signing stays on HOLD (CTO 28 Despacho 033)', () => {
    expect(MULTISIG_SIGNING_HOLD).toBe(true)
  })

  it('no physical-cash payment method is offered (publish, filter, country suggestions)', () => {
    const cash = ['CASH', 'CASH_BY_MAIL', 'LOTERICA_DEPOSIT']
    const offered = [...PAYMENT_METHODS, ...PAYMENT_METHODS_FILTERABLE, ...Object.values(COUNTRY_PRIORITY_METHODS).flat()] as string[]
    expect(offered.filter((m) => cash.includes(m))).toEqual([])
  })

  it('the asset catalog is the official 14 pairs and never offers Lightning', () => {
    expect(ASSET_CATALOG).toHaveLength(14)
    expect(ASSET_CATALOG.some((o) => /lightning/i.test(`${o.label} ${o.networkLabel} ${o.network}`))).toBe(false)
  })

  it('demo-only fields are filled by the demoMarkers guards and read only by their single readers', () => {
    // Writers: the demo backend and lib/demoMarkers.ts. Readers: offerPaymentMethods() and lib/ratings.ts.
    const HOMES = new Set(['lib/demoMarkers.ts', 'lib/paymentMethods.ts', 'lib/ratings.ts'])
    const readers = SOURCES.filter((f) => !HOMES.has(f.path) && !f.path.startsWith('demo/') && /\.demo(?:PaymentMethods|Ratings|MemberSince|AppealView)\b/.test(f.code)).map((f) => f.path)
    expect(readers).toEqual([])
  })
})

describe('nodes and private markets guard', () => {
  it('the demo nodes and markets fixtures are read only through lib/demoMarkers.ts', () => {
    const readers = SOURCES.filter((f) => f.path !== 'lib/demoMarkers.ts' && /demo\/nodesMarkets['"]/.test(f.code)).map((f) => f.path)
    expect(readers).toEqual([])
  })

  it('every new backend dependency is a loose wire with a contract', () => {
    for (const id of ['disputeAppealView', 'nodeCatalog', 'nodeStateSync', 'marketInvite', 'marketInviteQr', 'marketMembership', 'marketPortability', 'createMarket', 'marketDiscovery', 'marketBranding'] as const) {
      expect(LOOSE_WIRES[id].contract.length).toBeGreaterThan(20)
    }
  })
})

describe('stripComments', () => {
  it('drops comments, keeps strings', () => {
    expect(stripComments("a // servidor\nb /* servidor */ 'x // y'")).toBe("a \nb  'x // y'")
  })
})
