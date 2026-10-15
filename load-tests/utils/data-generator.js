/**
 * Real Ed25519 identity generation + the real challenge-response auth
 * flow (common/middleware/auth.ts) — ported from load-tests/artillery/processor.js's
 * proven `setupAuthenticatedUser` (Artillery, fetch-based) to k6's http
 * module. Every k6 VU registers its own participant, requests a real
 * challenge, signs it for real, and authenticates for real — the same
 * discipline this repo's e2e/Artillery suites already established
 * ("mock only the database boundary a unit test needs to, never the
 * thing actually being proven").
 *
 * Two real, non-obvious things this file has to get right, found by
 * testing directly against k6's Goja JS runtime (not assumed from how
 * this works in Node/Artillery):
 *
 * 1. tweetnacl's own UMD footer (nacl-fast.js, tail of the file)
 *    auto-detects its environment to wire up a PRNG: browsers via
 *    `self.crypto.getRandomValues`, Node via `require('crypto')`. k6's
 *    Goja engine has neither `self` nor a requirable `'crypto'` module
 *    (it exposes the Web Crypto API as a real global `crypto` instead,
 *    graduated out of `k6/experimental/webcrypto` as of this k6
 *    version) — so tweetnacl's own auto-detect picks the Node branch
 *    (`typeof require !== 'undefined'` is true in k6 too) and crashes
 *    on `require('crypto')`, which k6 doesn't provide. Setting
 *    `globalThis.self = globalThis` before tweetnacl loads makes its
 *    browser branch fire instead, which finds k6's real global `crypto`
 *    exactly the way a real browser's would.
 *
 * 2. That polyfill has to run *before* tweetnacl's own top-level code
 *    executes. `import` declarations are hoisted and evaluate before
 *    the rest of the importing module's body regardless of where the
 *    `import` line is written — so `require()` is used for tweetnacl
 *    here instead (executes in the position it's written), not `import`.
 *
 * Registration now additionally signs the PoP domain-separated message\n * `sails-registration-proof-of-possession:v1:<challenge>:<displayName>`\n * before participant creation; this is required by the live server.\n *\n * Signing detail carried over unchanged from processor.js: the server
 * verifies against the UTF-8 bytes of the challenge *string* itself,
 * not the raw bytes the returned hex represents (a hex round-trip is a
 * documented no-op — see common/middleware/auth.ts).
 */
import http from 'k6/http'
import { check } from 'k6'

globalThis.self = globalThis
// eslint-disable-next-line
const nacl = require('../../node_modules/tweetnacl/nacl-fast.js')

// Real AssetType enum — src/core/intent.routes.ts's tradeIntentPayloadSchema
// (which is also what liquidity/trade/settlement routes constrain to at
// the Prisma level, per that schema's own comment). Verified against
// the actual zod schema, not guessed — an invented value here 400s
// randomly under load in a way that's easy to misread as a real bug.
const ASSETS = ['BTC', 'USDT_ERC20', 'USDT_TRC20', 'USDT_LIQUID', 'USDT_LIGHTNING', 'LN_BTC', 'LIQUID_BTC', 'SPARK', 'STACKS', 'RSK_BTC']
const CURRENCIES = ['USD', 'BRL', 'EUR', 'GBP', 'ARS', 'MXN', 'NGN', 'INR']

function bytesToHex(bytes) {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return bytes
}

function utf8Bytes(str) {
  // No TextEncoder in k6's Goja runtime — ASCII-safe manual encode is
  // enough here (challenge strings are hex, publicKeys/signatures are
  // hex — no non-ASCII input ever flows through this path).
  const bytes = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i)
  return bytes
}

/**
 * Registers a brand-new Ed25519 identity and runs the real
 * register -> challenge -> sign -> authenticate flow against a live
 * server. Returns `null` (after recording a check failure) rather than
 * throwing, so a single VU's auth failure shows up as a real threshold
 * breach instead of aborting the whole run.
 */
export function generateTestUser(baseUrl, tag) {
  const keyPair = nacl.sign.keyPair()
  const publicKey = bytesToHex(keyPair.publicKey)
  const displayName = `k6-${tag || 'user'}-${publicKey.slice(0, 8)}`

  // Registration is proof-of-possession protected. A bare publicKey/displayName
  // request is no longer accepted by the live protocol.
  const regChallengeRes = http.post(`${baseUrl}/v1/identity/register-challenge`, JSON.stringify({ publicKey }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'identity_register_challenge' },
  })
  if (!check(regChallengeRes, { 'register challenge: 200': (r) => r.status === 200 })) return null
  const registrationChallenge = regChallengeRes.json('data.challenge')
  if (typeof registrationChallenge !== 'string' || !registrationChallenge) throw new Error('Missing registration challenge')
  const registrationMessage = `sails-registration-proof-of-possession:v1:${registrationChallenge}:${displayName}`
  const registrationSignature = bytesToHex(nacl.sign.detached(utf8Bytes(registrationMessage), keyPair.secretKey))
  const regRes = http.post(`${baseUrl}/v1/identity/participants`, JSON.stringify({
    publicKey, displayName, signature: registrationSignature,
  }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'identity_register' },
  })
  if (!check(regRes, { 'register: 201': (r) => r.status === 201 })) return null
  const participantId = regRes.json('data.id')

  const challengeRes = http.post(`${baseUrl}/v1/identity/challenge`, JSON.stringify({ publicKey }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'identity_challenge' },
  })
  if (!check(challengeRes, { 'challenge: 200': (r) => r.status === 200 })) return null
  const challenge = challengeRes.json('data.challenge')

  const signature = bytesToHex(nacl.sign.detached(utf8Bytes(challenge), keyPair.secretKey))

  const authRes = http.post(`${baseUrl}/v1/identity/authenticate`, JSON.stringify({ publicKey, signature }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'identity_authenticate' },
  })
  if (!check(authRes, { 'authenticate: 200': (r) => r.status === 200 })) return null

  return {
    participantId,
    publicKey,
    secretKey: keyPair.secretKey,
    sessionToken: authRes.json('data.sessionToken'),
  }
}

/** Auth header params for an http.* call — `Object.assign` onto request-specific params (e.g. tags) at the call site. */
export function authHeaders(user) {
  return { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.sessionToken}` } }
}

/** A real TradeIntent payload — src/core/intent.routes.ts's createIntentSchema is the source of truth for these fields. */
export function generateTestIntent(overrides) {
  const asset = ASSETS[Math.floor(Math.random() * ASSETS.length)]
  const currency = CURRENCIES[Math.floor(Math.random() * CURRENCIES.length)]
  return Object.assign(
    {
      type: 'TradeIntent',
      payload: Object.assign(
        {
          asset,
          side: Math.random() < 0.5 ? 'BUY' : 'SELL',
          maxValue: (100 + Math.random() * 900).toFixed(2),
          currency,
        },
        overrides && overrides.payload
      ),
    },
    overrides && overrides.type ? { type: overrides.type } : {}
  )
}

/** A real POST /v1/liquidity/offers body — liquidity.routes.ts's createOfferSchema. */
export function generateTestOffer(overrides) {
  const asset = ASSETS[Math.floor(Math.random() * ASSETS.length)]
  const price = (0.5 + Math.random() * 2).toFixed(2) // deliberately not tiny — see sails-ui's PublishOffer.tsx fix history for why a too-small price silently rounds to zero
  return Object.assign(
    {
      asset,
      side: 'SELL',
      priceUsd: price,
      minAmount: '1',
      maxAmount: '1000',
      paymentMethod: 'PIX',
      paymentDetails: `k6-test-pix-${Date.now()}`,
    },
    overrides
  )
}

/** A real POST /v1/openp2p/trades body — trade.routes.ts's createTradeSchema. Needs a real, already-published offerId. */
export function generateTestTrade(offerId, overrides) {
  return Object.assign({ offerId, amount: '10' }, overrides)
}
