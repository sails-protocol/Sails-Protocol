import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import {
  ASSET_CATALOG, ASSET_GROUPS, DEV_TEST_PAIR, ENUM_ASSET_TYPES, referenceNote, signingHoldNote, soonNote,
  pairForAssetType, pickerPairs, selectablePairs,
} from '../src/lib/assetCatalog'
import { ASSET_LABELS } from '../src/lib/labels'
import { moveActiveEnabled } from '../src/lib/combobox'

describe('asset catalog (ADR-002 §5A, DECISIONS.md "Catálogo de ativos")', () => {
  it('has exactly the 14 official pairs, grouped by asset, in order', () => {
    expect(ASSET_CATALOG.map((p) => p.label)).toEqual([
      'BTC · On-chain', 'BTC · Liquid',
      'USDT · Ethereum', 'USDT · Polygon', 'USDT · Base', 'USDT · Arbitrum', 'USDT · TON', 'USDT · Tron', 'USDT · Solana',
      'USDC · Ethereum', 'USDC · Polygon', 'USDC · Base', 'USDC · Arbitrum', 'USDC · Solana',
    ])
    expect(new Set(ASSET_CATALOG.map((p) => p.id)).size).toBe(14)
    expect(ASSET_GROUPS.map((g) => g.name)).toEqual(['Bitcoin', 'Tether (USDT)', 'USD Coin (USDC)'])
  })

  it('maps only the 4 pairs the AssetType enum can represent', () => {
    expect(ASSET_CATALOG.filter((p) => p.assetType).map((p) => [p.id, p.assetType])).toEqual([
      ['btc-bitcoin', 'BTC'], ['btc-liquid', 'LIQUID_BTC'], ['usdt-ethereum', 'USDT_ERC20'], ['usdt-tron', 'USDT_TRC20'],
    ])
    for (const p of ASSET_CATALOG) if (p.assetType) expect(ENUM_ASSET_TYPES).toContain(p.assetType)
  })

  it('only BTC on-chain is available, with the MULTISIG signing HOLD note', () => {
    const available = ASSET_CATALOG.filter((p) => p.availability === 'available')
    expect(available.map((p) => p.id)).toEqual(['btc-bitcoin'])
    expect(available[0].note).toBe(signingHoldNote())
  })

  it('every soon pair has a reason; USDT Ethereum is the reference implementation', () => {
    const soon = ASSET_CATALOG.filter((p) => p.availability === 'soon')
    expect(soon).toHaveLength(13)
    for (const p of soon) expect(p.note.length).toBeGreaterThan(0)
    expect(soon.find((p) => p.id === 'usdt-ethereum')!.note).toBe(referenceNote())
    expect(soon.filter((p) => p.id !== 'usdt-ethereum').every((p) => p.note === soonNote())).toBe(true)
  })

  it('no option is labelled Lightning; the Arkade test rail is dev-only and says so', () => {
    for (const dev of [false, true]) for (const p of pickerPairs(dev)) expect(`${p.label} ${p.networkLabel} ${p.note}`).not.toMatch(/lightning/i)
    expect(pickerPairs(false)).not.toContainEqual(DEV_TEST_PAIR)
    expect(pickerPairs(true).map((p) => p.id)).toEqual(['btc-bitcoin', 'btc-liquid', 'btc-test', ...ASSET_CATALOG.slice(2).map((p) => p.id)])
    expect(DEV_TEST_PAIR).toMatchObject({ assetType: 'LN_BTC', label: 'BTC · Rede de teste', testOnly: true })
  })

  it('publish and filter can choose only available pairs (plus the dev test rail)', () => {
    expect(selectablePairs(false).map((p) => p.assetType)).toEqual(['BTC'])
    expect(selectablePairs(true).map((p) => p.assetType)).toEqual(['BTC'])
  })

  it('existing offers and trades render with the pair label (network always shown)', () => {
    for (const p of [...ASSET_CATALOG, DEV_TEST_PAIR]) if (p.assetType) {
      expect(pairForAssetType(p.assetType)).toBe(p)
      expect(ASSET_LABELS[p.assetType]).toBe(p.label)
    }
    expect(pairForAssetType('DEPIX')).toBeUndefined()
    expect(ASSET_LABELS.DEPIX).toBe('DePix') // kept so old records still render
  })
})

describe('combobox disabled options', () => {
  it('arrow keys skip disabled options and wrap; none enabled = -1', () => {
    const d = [false, true, true, false, true]
    expect(moveActiveEnabled(0, d, 'ArrowDown')).toBe(3)
    expect(moveActiveEnabled(3, d, 'ArrowDown')).toBe(0)
    expect(moveActiveEnabled(0, d, 'ArrowUp')).toBe(3)
    expect(moveActiveEnabled(-1, d, 'ArrowDown')).toBe(0)
    expect(moveActiveEnabled(-1, [true, true], 'ArrowDown')).toBe(-1)
  })
})

describe('asset option list guard', () => {
  const SRC = join(__dirname, '..', 'src')
  const HOME = 'lib/assetCatalog.ts'
  const CODES = Object.keys(ASSET_LABELS).join('|')
  // An array literal holding two or more AssetType codes = a hand-made asset option list.
  const LIST = new RegExp(`\\[\\s*'(?:${CODES})'\\s*,\\s*'(?:${CODES})'`)
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : []
  })
  const offenders = (rel: string, text: string) => {
    const out: string[] = []
    if (rel !== HOME && LIST.test(text)) out.push(`${rel}: asset list outside ${HOME}`)
    if (/<AssetPicker[^>]*\sassets=/.test(text)) out.push(`${rel}: AssetPicker given its own assets`)
    return out
  }

  it('asset options exist only in the catalog module', () => {
    expect(files(SRC).flatMap((p) => offenders(relative(SRC, p).replace(/\\/g, '/'), readFileSync(p, 'utf8')))).toEqual([])
    expect(offenders('x.ts', "const A = ['BTC', 'USDT_ERC20'] as const")).toHaveLength(1)
    expect(offenders('x.ts', "const A = [\n  'BNB', 'BTC',\n]")).toHaveLength(1)
    expect(offenders('x.tsx', '<AssetPicker assets={X} value={v} />')).toHaveLength(1)
    expect(offenders('x.ts', "const A = ['BTC']")).toHaveLength(0)
  })
})

describe('network chip on the asset logo (PO 2026-11-21, item 13)', () => {
  it('is hidden only when it repeats the asset logo', () => {
    const { networkChipLogo } = require('../src/lib/assetCatalog')
    expect(networkChipLogo('BTC', 'bitcoin')).toBeNull()
    expect(networkChipLogo('BTC', 'liquid')).toMatch(/liquid/)
    expect(networkChipLogo('USDT', 'tron')).toMatch(/tron/)
    expect(networkChipLogo('USDC', null)).toBeNull()
  })
})
