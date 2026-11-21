/**
 * Official asset catalog (ADR-002 §5A, DECISIONS.md "Catálogo de ativos"): exactly 14 asset/network
 * pairs, one option per network, grouped by the economic asset. This is the only place an asset option
 * list lives (tests/assetCatalog.test.ts guards it); pickers, labels and icons read from here.
 *
 * Availability is derived, never asserted: a pair is `available` only when its AssetType has a settlement
 * rail (`recommendedEscrowType`, the SDK mirror of the server's map) that may run in production. Only
 * MULTISIG may today (backend `PRODUCTION_INELIGIBLE_TYPES`, escrow-providers.ts). Only 4 of the 14
 * pairs exist in the AssetType enum; the other 10 wait for ADR-002's Asset + SettlementRail model
 * (LOOSE_WIRES.assetCatalogPairs). Lightning is out of the catalog with no exception (EPM, 2026-11-20).
 */
import { recommendedEscrowType, type AssetType as EnumAssetType, type EscrowType } from '@satsails/p2p-trading-sdk'
import type { AssetType } from '../types'
import { MULTISIG_SIGNING_HOLD } from './multisigSigningIntent'
import { t } from '../i18n'

/** The real AssetType enum (SDK, Prisma, schemas): what offers and trades can carry. Not an option list. */
export const ENUM_ASSET_TYPES = ['BTC', 'LIQUID_BTC', 'LN_BTC', 'RSK_BTC', 'STACKS', 'USDT_ERC20', 'USDT_LIGHTNING', 'USDT_LIQUID', 'USDT_TRC20'] as const satisfies readonly EnumAssetType[]

export type CatalogAsset = 'BTC' | 'USDT' | 'USDC'
export type CatalogNetwork = 'bitcoin' | 'liquid' | 'ethereum' | 'polygon' | 'base' | 'arbitrum' | 'ton' | 'tron' | 'solana'

export interface AssetPair {
  id: string
  asset: CatalogAsset
  /** Logo of the network; null for the dev-only test rail (no official mark). */
  network: CatalogNetwork | null
  networkLabel: string
  /** "USDT · Tron": the one way a pair is written anywhere in the UI. */
  label: string
  /** Existing enum value, or null when the enum cannot represent the pair yet. */
  assetType: EnumAssetType | null
  availability: 'available' | 'soon'
  /** Why it is not available yet, or the caveat on an available pair. Empty when there is none. */
  note: string
  /** Dev/demo builds only (Arkade on mutinynet). */
  testOnly?: true
}

export const ASSET_GROUPS: readonly { asset: CatalogAsset; name: string }[] = [
  { asset: 'BTC', name: 'Bitcoin' },
  { asset: 'USDT', name: 'Tether (USDT)' },
  { asset: 'USDC', name: 'USD Coin (USDC)' },
]

export const ASSET_LOGO: Record<CatalogAsset, string> = {
  BTC: '/brand/assets/btc.svg', USDT: '/brand/assets/usdt.svg', USDC: '/brand/assets/usdc.svg',
}
export const NETWORK_LOGO: Record<CatalogNetwork, string> = {
  bitcoin: '/brand/networks/bitcoin.svg', liquid: '/brand/networks/liquid.svg', ethereum: '/brand/networks/ethereum.svg',
  polygon: '/brand/networks/polygon.svg', base: '/brand/networks/base.svg', arbitrum: '/brand/networks/arbitrum.svg',
  ton: '/brand/networks/ton.svg', tron: '/brand/networks/tron.svg', solana: '/brand/networks/solana.svg',
}

/**
 * Network logo for the chip on an asset logo, or null when it would repeat the asset's own logo (BTC on the
 * Bitcoin network). The network name stays written next to the logo (DECISIONS.md, PO 2026-11-21, item 13).
 */
const NATIVE_NETWORK: Partial<Record<CatalogAsset, CatalogNetwork>> = { BTC: 'bitcoin' }
export function networkChipLogo(asset: CatalogAsset, network: CatalogNetwork | null | undefined): string | null {
  if (!network || NATIVE_NETWORK[asset] === network) return null
  return NETWORK_LOGO[network]
}

const PRODUCTION_ELIGIBLE: ReadonlySet<EscrowType> = new Set(['MULTISIG'])
// Notes are read through getters (`note`, below) so they follow the interface language; these give the current text.
export const soonNote = () => t('common.soon')
export const referenceNote = () => t('labels.asset.referenceNote')
export const signingHoldNote = () => t('labels.asset.signingHoldNote')

function availabilityOf(assetType: EnumAssetType | null): Pick<AssetPair, 'availability' | 'note'> {
  const rail = assetType ? recommendedEscrowType(assetType) : undefined
  if (rail && PRODUCTION_ELIGIBLE.has(rail)) {
    const hold = rail === 'MULTISIG' && MULTISIG_SIGNING_HOLD
    return { availability: 'available', get note() { return hold ? signingHoldNote() : '' } }
  }
  return { availability: 'soon', get note() { return rail ? referenceNote() : soonNote() } }
}

const NETWORK_LABEL: Record<CatalogNetwork, string> = {
  bitcoin: 'On-chain', liquid: 'Liquid', ethereum: 'Ethereum', polygon: 'Polygon', base: 'Base',
  arbitrum: 'Arbitrum', ton: 'TON', tron: 'Tron', solana: 'Solana',
}

function pair(asset: CatalogAsset, network: CatalogNetwork, assetType: EnumAssetType | null): AssetPair {
  const networkLabel = NETWORK_LABEL[network]
  // defineProperties, not a spread: a spread would copy the `note` getter's value once, at import.
  return Object.defineProperties(
    { id: `${asset.toLowerCase()}-${network}`, asset, network, networkLabel, label: `${asset} · ${networkLabel}`, assetType },
    Object.getOwnPropertyDescriptors(availabilityOf(assetType)),
  ) as AssetPair
}

export const ASSET_CATALOG: readonly AssetPair[] = [
  pair('BTC', 'bitcoin', 'BTC'),
  pair('BTC', 'liquid', 'LIQUID_BTC'),
  pair('USDT', 'ethereum', 'USDT_ERC20'),
  pair('USDT', 'polygon', null),
  pair('USDT', 'base', null),
  pair('USDT', 'arbitrum', null),
  pair('USDT', 'ton', null),
  pair('USDT', 'tron', 'USDT_TRC20'),
  pair('USDT', 'solana', null),
  pair('USDC', 'ethereum', null),
  pair('USDC', 'polygon', null),
  pair('USDC', 'base', null),
  pair('USDC', 'arbitrum', null),
  pair('USDC', 'solana', null),
]

/** Arkade (LN_BTC) on mutinynet: a test rail, never "Lightning", never in a production build. */
export const DEV_TEST_PAIR: AssetPair = {
  id: 'btc-test', asset: 'BTC', network: null,
  get networkLabel() { return t('labels.network.test') },
  get label() { return `BTC · ${t('labels.network.test')}` },
  assetType: 'LN_BTC', availability: 'available',
  get note() { return t('labels.asset.devTestNote') },
  testOnly: true,
}

/** Every option a picker shows, in catalog order (the dev test rail last, inside Bitcoin's group). */
export function pickerPairs(includeDevTest: boolean): AssetPair[] {
  if (!includeDevTest) return [...ASSET_CATALOG]
  const lastBtc = ASSET_CATALOG.map((p) => p.asset).lastIndexOf('BTC')
  return [...ASSET_CATALOG.slice(0, lastBtc + 1), DEV_TEST_PAIR, ...ASSET_CATALOG.slice(lastBtc + 1)]
}

/** Pairs that can be chosen to filter or publish: `available` with an enum value. */
export function selectablePairs(includeDevTest: boolean): AssetPair[] {
  return pickerPairs(includeDevTest).filter((p) => p.availability === 'available' && p.assetType !== null)
}

/** The pair an existing offer/trade value renders as (the test rail too, so old data reads honestly). */
export function pairForAssetType(assetType: AssetType): AssetPair | undefined {
  if (assetType === DEV_TEST_PAIR.assetType) return DEV_TEST_PAIR
  return ASSET_CATALOG.find((p) => p.assetType === assetType)
}

/** Logos for enum values outside the catalog that still need to render (USDT on Liquid). */
export const LEGACY_LOGOS: Partial<Record<AssetType, { asset: CatalogAsset; network: CatalogNetwork | null }>> = {
  USDT_LIQUID: { asset: 'USDT', network: 'liquid' },
  RSK_BTC: { asset: 'BTC', network: null },
}
