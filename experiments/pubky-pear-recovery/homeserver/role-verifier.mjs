// ROLE: a SECOND integrator that only reads public data (no grant, no secret, no contact with the
// integrator that created the session). It discovers Pear sessions through the identity's public
// directory on the homeserver and verifies them with policy.mjs.
import b4a from 'b4a'
import { HOMESERVER_HTTP, PEAR_DIR, serve, testnet, within } from './lib.mjs'
import { PersistentRollbackGuard, RollbackGuard, challengeInput, grantStatus, verifyChallenge, verifyFreshRecord, verifyPearAuthorization } from './policy.mjs'

const pubky = testnet()
const guard = process.env.PPR_GUARD_FILE ? new PersistentRollbackGuard(process.env.PPR_GUARD_FILE) : new RollbackGuard()
const seenChallenges = new Set()

const addr = (identity, path) => `pubky${identity}${path}`

serve({
  async discover ({ identity }) {
    const entries = await within(pubky.publicStorage.list(addr(identity, `${PEAR_DIR}/devices/`)), 10000, 'list')
    return entries.map((e) => String(e))
  },
  async fetchRecord ({ identity, name }) {
    return within(pubky.publicStorage.getJson(addr(identity, `${PEAR_DIR}/devices/${name}`)), 10000, 'get')
  },
  async verify ({ record, identity, audience, now, allowedClients, online }) {
    const r = verifyPearAuthorization(record, { identity, audience, now, allowedClients, requiredPath: `${PEAR_DIR}/devices/` })
    if (!r.ok) return r
    if (online) {
      const status = await grantStatus(HOMESERVER_HTTP, record.cp.grant)
      if (status === 'revoked') return { ok: false, reason: 'grant-revoked' }
      if (status === 'unavailable') return { ok: false, reason: 'revocation-status-unavailable' } // fail closed
    }
    return r
  },
  async status ({ record }) { return grantStatus(HOMESERVER_HTTP, record.cp.grant) },
  // Raw read of a directory record from ANY base URL (the real homeserver or a hostile proxy), with the
  // homeserver-reported modification time. A missing record is reported, never invented.
  async readRecord ({ base, identity, pear }) {
    const path = `${PEAR_DIR}/devices/${pear}.json`
    const opts = { headers: { 'pubky-host': identity }, signal: AbortSignal.timeout(8000) }
    const get = await fetch(base + path, opts).catch(() => null)
    if (!get || get.status !== 200) return { found: false, status: get?.status ?? 0 }
    const head = await fetch(base + path, { ...opts, method: 'HEAD' }).catch(() => null)
    const lm = head?.headers.get('last-modified')
    return { found: true, record: await get.json(), stats: { lastModifiedMs: lm ? Date.parse(lm) : NaN } }
  },
  // Strict policy for authorizing something NEW: provenance + freshness + anti-rollback + optional online status.
  async verifyStrict ({ read, identity, audience, now, maxAgeSec, online }) {
    if (!read.found) return { ok: false, reason: 'record-unavailable' }
    const r = verifyFreshRecord(read.record, { identity, audience, now, requiredPath: `${PEAR_DIR}/devices/` }, { stats: read.stats, now, maxAgeSec, guard })
    if (!r.ok || !online) return r
    const status = await grantStatus(HOMESERVER_HTTP, read.record.cp.grant)
    if (status === 'revoked') return { ok: false, reason: 'grant-revoked' }
    if (status === 'unavailable') return { ok: false, reason: 'revocation-status-unavailable' }
    return r
  },
  async challenge ({ audience, pear }) {
    const nonce = b4a.toString(b4a.from(globalThis.crypto.getRandomValues(new Uint8Array(16))), 'hex')
    seenChallenges.add(nonce)
    return { nonce, audience, input: b4a.toString(challengeInput({ nonce, audience, pear }), 'hex') }
  },
  async verifyChallenge ({ pear, nonce, audience, sigHex }) {
    if (!seenChallenges.delete(nonce)) return { ok: false, reason: 'challenge-unknown-or-reused' }
    return verifyChallenge({ pear, nonce, audience, sigHex }) ? { ok: true } : { ok: false, reason: 'bad-signature' }
  }
})
