// Parsing of a Pubky public key (z-base-32) via the real SDK. Public data only.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pubky = require('@synonymdev/pubky')

export function pubkyPublicKeyFromZ32 (z32) {
  const pk = pubky.PublicKey.from(z32)
  const bytes = new Uint8Array(pk.toUint8Array())
  pk.free()
  return bytes
}

export { pubky }
