/**
 * #235 R7G-B2A — MULTISIG unit fixtures describe escrows whose buyer and seller
 * keys went through submitParticipantKey(), which always persists the funding
 * address those keys (plus the arbiter commitment) derive. The provider now
 * refuses to consume a funding surface without that persisted address
 * (SCRIPT_AUTHORITY_IMMUTABILITY_V1), so a fixture that omits `multisigAddr`
 * gets the address its own keys derive — exactly what production would have
 * stored. A fixture that sets `multisigAddr` itself (null, or a mismatching
 * address) is passed through untouched, so fail-closed cases stay testable.
 */
import * as bitcoin from 'bitcoinjs-lib'

type ProviderModule = { multisigProvider: object; networkFor: (n: never) => bitcoin.Network }

export function withPersistedFundingAddress<M extends ProviderModule>(mod: M): M {
  const { config } = require('../../src/config')
  const network = mod.networkFor(config.multisig.network as never)
  const derive = (e: { buyerPubkey?: string; sellerPubkey?: string; arbiterPubkey?: string | null }): string | null => {
    if (!e.buyerPubkey || !e.sellerPubkey || !e.arbiterPubkey) return null
    try {
      const pubkeys = [e.buyerPubkey, e.sellerPubkey, e.arbiterPubkey].map((h) => Buffer.from(h, 'hex')).sort(Buffer.compare)
      return bitcoin.payments.p2wsh({ redeem: bitcoin.payments.p2ms({ m: 2, pubkeys, network }), network }).address ?? null
    } catch {
      return null
    }
  }
  const withAddress = (arg: unknown) =>
    arg && typeof arg === 'object' && !Array.isArray(arg) && !('multisigAddr' in arg) && 'tradeId' in arg
      ? { ...(arg as object), multisigAddr: derive(arg as never) }
      : arg
  const provider = new Proxy(mod.multisigProvider, {
    get(target, prop) {
      const value = Reflect.get(target, prop)
      return typeof value === 'function'
        ? (...args: unknown[]) => value.apply(target, [withAddress(args[0]), ...args.slice(1)])
        : value
    },
  })
  return { ...mod, multisigProvider: provider }
}
