// Tests import the code under test through load(): scripts/red-green.mjs points
// PPR_SRC at a deliberately broken copy to prove the tests can fail (RED).
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const SRC = process.env.PPR_SRC
  ? path.resolve(process.env.PPR_SRC)
  : path.resolve(import.meta.dirname, '../src')

export const load = (name) => import(pathToFileURL(path.join(SRC, name)).href)

// Fixed clock and TEST-ONLY root. Not a secret: it is public test material.
export const NOW = 1_800_000_000
export const TEST_ROOT = new Uint8Array(32).map((_, i) => i)

export async function world (root = TEST_ROOT) {
  const kdf = await load('kdf.mjs')
  const issue = await load('issue.mjs')
  const verify = await load('verify.mjs')
  const identity = kdf.restorePubkyIdentity(kdf.pubkySecretFromRoot(root))
  const mkDevice = (id, epoch = 0) => kdf.pearKeyPairFromSeed(kdf.pearDeviceSeedFromRoot(root, id, epoch))
  return { kdf, issue, verify, identity, mkDevice, root }
}

export function fixedSource (statements = []) {
  return { list: async () => statements }
}

export function downSource () {
  return { list: async () => { throw new Error('homeserver unreachable') } }
}

export async function session (w, { device, cert, audience = 'market.example', now = NOW, revocations, challenges, expectedSub, requiredScope, challengeNonce, popCert }) {
  const ch = challenges.issue(audience, now, 60, challengeNonce)
  const pop = w.issue.makePop(device, popCert ?? cert, ch)
  return w.verify.verifySession({
    cert, pop, challenge: ch, audience, now, expectedSub, requiredScope, revocations, challenges
  })
}
