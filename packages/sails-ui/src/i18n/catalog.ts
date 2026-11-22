import type { Locale } from '../lib/locale'
import { REVIEW_AREAS, type Area, type Message, type ReviewArea } from './define'
import common from './areas/common'
import shell from './areas/shell'
import auth from './areas/auth'
import market from './areas/market'
import offer from './areas/offer'
import labels from './areas/labels'
import reputation from './areas/reputation'
import ui from './areas/ui'
import trade from './areas/trade'
import escrow from './areas/escrow'
import agent from './areas/agent'
import trades from './areas/trades'
import publish from './areas/publish'
import disputes from './areas/disputes'
import profile from './areas/profile'
import markets from './areas/markets'
import settings from './areas/settings'
import looseWires from './areas/looseWires'
import spaces from './areas/spaces'
import shop from './areas/shop'

/** Every area, in one list. Add a new area file here (keys must start with the area name). */
export const AREAS = { common, shell, auth, market, offer, labels, reputation, ui, trade, escrow, agent, trades, publish, disputes, profile, markets, settings, looseWires, spaces, shop } as const

type KeysOf<A> = A extends Area<infer K> ? K : never
export type MessageKey = KeysOf<(typeof AREAS)[keyof typeof AREAS]>

export const CATALOGS = Object.fromEntries(
  (['pt-BR', 'en', 'es', 'fr', 'de'] as const).map((l) => [l, Object.assign({}, ...Object.values(AREAS).map((a) => a.messages[l]))]),
) as Record<Locale, Record<MessageKey, Message>>

/** All keys that need native review before en/es/fr/de ship, by review area. */
export const NEEDS_NATIVE_REVIEW = Object.fromEntries(
  REVIEW_AREAS.map((r) => [r, Object.values(AREAS).flatMap((a) => ((a as Area<string>).review[r] ?? []) as MessageKey[])]),
) as Record<ReviewArea, MessageKey[]>
