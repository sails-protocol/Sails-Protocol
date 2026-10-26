// ROLE: an INDEPENDENT verifier app (think: a third marketplace). It has no Pubky SDK, no grant, no secret and imports no
// Sails code except the standalone portable verifier (node:crypto only). It reads the user's PUBLIC storage over plain HTTP.
import { verifyBinding, verifyPortable } from '../portable/src/verify.mjs'
import { HOMESERVER_HTTP, serve } from './lib.mjs'

const base = process.env.PPR_BASE ?? HOMESERVER_HTTP
const get = async (identity, path) => {
  const r = await fetch(base + path, { headers: { 'pubky-host': identity }, signal: AbortSignal.timeout(8000) }).catch(() => null)
  return r && r.status === 200 ? r : null
}
const ls = async (identity, path) => {
  const r = await get(identity, `${path}?shallow=true`)
  if (!r) return []
  return (await r.text()).split('\n').map((l) => l.trim()).filter(Boolean).map((u) => u.slice(u.indexOf(path) + path.length).replace(/\/$/, '')).filter(Boolean)
}

serve({
  // Public part of the package: bindings found in the identity's storage, and every participant's chain.
  async collect ({ identity }) {
    const bindings = []; const chains = []
    for (const p of await ls(identity, '/pub/sails.market/bindings/')) {
      const r = await get(identity, `/pub/sails.market/bindings/${p}/binding.json`)
      if (r) bindings.push(await r.json())
    }
    for (const p of await ls(identity, '/pub/sails.market/facts/')) {
      const files = (await ls(identity, `/pub/sails.market/facts/${p}/`)).filter((f) => /^\d+\.json$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b))
      const facts = []
      for (const f of files) facts.push(await (await get(identity, `/pub/sails.market/facts/${p}/${f}`)).json())
      const h = await get(identity, `/pub/sails.market/facts/${p}/head.json`)
      chains.push({ participant: p, facts, head: h ? await h.json() : null })
    }
    return { bindings, chains }
  },
  async verify ({ pkg, now, audience, expectedPubky, pinnedHead }) { return verifyPortable(pkg, { now, audience, expectedPubky, pinnedHead }) },
  async verifyBinding ({ bundle, now, audience, requireLevel }) { return verifyBinding(bundle, { now, audience, requireLevel }) }
})
