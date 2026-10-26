// Deterministic vectors for lab format v1. All keys derive from public test seeds: nothing here is a secret.
import fs from 'node:fs'
import path from 'node:path'
import { cf1, Chain, bindingBundle, bindingRevocation, bindingStatement, commitParty, commitTrade, confirmation, delegatePop, disputeClaim, keyFromSeed, pubkyGrant, input, idOf } from '../src/issue.mjs'

const seed = (n) => new Uint8Array(32).fill(n)
const NOW = 1_800_000_000
const AUD = 'sails.market'
const root = keyFromSeed(seed(1)); const delegate = keyFromSeed(seed(2)); const delegate2 = keyFromSeed(seed(7))
const P = keyFromSeed(seed(3)); const P2 = keyFromSeed(seed(8))
const Q = [4, 5, 6, 9, 10].map((n) => keyFromSeed(seed(n)))
const hexs = (n) => Buffer.alloc(32, n).toString('hex')

function bind (participant, { consent = true, dlg = delegate, jti, ttl = 86400, iatOffset = -10 }) {
  const iat = NOW + iatOffset
  const caps = ['/pub/sails.market/pear/devices/:rw']
  if (consent) caps.push(`/pub/sails.market/bindings/${participant.pk}/:rw`)
  const grant = pubkyGrant(root, dlg, { caps, clientId: 'wallet.example', jti, iat: NOW - 100, exp: NOW + 2 * 365 * 86400 })
  const statement = bindingStatement(root, participant, { audience: AUD, nonce: hexs(0xa0 + (jti.length % 16)), iat, exp: iat + ttl })
  const pop = delegatePop(dlg, { jti, iat, nonce: 'AAAAAAAAAAAAAAAAAAAAAA', data: statement })
  return bindingBundle({ statement, participant, grant, pop })
}

// trades of P: 4 completed with Q0 (cap 3), 1 completed with Q1, 1 completed WITHOUT confirmation (one-sided), 1 disputed-lost
const chain = new Chain(P)
const openings = {}; const confirmations = []
const trades = [[0, 'completed', true], [0, 'completed', true], [0, 'completed', true], [0, 'completed', true], [1, 'completed', true], [2, 'completed', false], [3, 'disputed-lost', false]]
trades.forEach(([qi, outcome, confirm], i) => {
  const tradeSalt = hexs(0x40 + i); const partySalt = hexs(0x50 + i); const tradeRef = `trade-ref-${i}`
  const tc = commitTrade(tradeSalt, tradeRef); const pc = commitParty(partySalt, Q[qi].pk)
  chain.append({ tradeCommit: tc, counterpartyCommit: pc, outcome, iat: NOW - 1000 + i })
  openings[tc] = { tradeRef, tradeSalt, counterparty: Q[qi].pk, partySalt }
  if (confirm) confirmations.push(confirmation(Q[qi], P.pk, { tradeCommit: tc, outcome, iat: NOW - 990 + i }))
})
const head = chain.head(NOW - 900)
const claims = [disputeClaim(Q[4], P.pk, { tradeCommit: hexs(0x77), iat: NOW - 800 })]

const bindingA = bind(P, { jti: 'jtiGrantA00000000000A' })
const bindingA2 = bind(P2, { jti: 'jtiGrantB00000000000B', dlg: delegate2 })
const bindingDelegatedOnly = bind(P, { consent: false, jti: 'jtiGrantC00000000000C' })
const expiredBinding = bind(P, { jti: 'jtiGrantD00000000000D', ttl: 5, iatOffset: -3600 })
const revocation = bindingRevocation(P2, bindingA2.statement.pubky, NOW - 5)

const pkg = { bindings: [bindingA], chains: [{ participant: P.pk, facts: chain.facts, head }], confirmations, openings, disputeClaims: claims }
const vectors = {
  _warning: 'TEST VECTORS from public seeds 01..0a. Not secrets. Never reuse these keys.',
  version: 1, now: NOW, audience: AUD,
  keys: { root: root.pk, delegate: delegate.pk, participant: P.pk, participant2: P2.pk, counterparties: Q.map((k) => k.pk) },
  canonical: [
    { value: { b: [1, 'x', null, true], a: { z: 'q"\\\n', y: 0 } }, bytesHex: Buffer.from(cf1({ b: [1, 'x', null, true], a: { z: 'q"\\\n', y: 0 } })).toString('hex'), text: cf1({ b: [1, 'x', null, true], a: { z: 'q"\\\n', y: 0 } }) },
    { value: { k: 'é€\u0001' }, text: cf1({ k: 'é€\u0001' }) }
  ],
  signingInputExample: { purpose: 'fact', body: chain.facts[0].body, inputHex: input('fact', chain.facts[0].body).toString('hex'), id: idOf('fact', chain.facts[0].body) },
  bindings: { root_consented: bindingA, root_consented_p2: bindingA2, delegated_only: bindingDelegatedOnly, expired: expiredBinding },
  package: pkg,
  expected: {
    positive: { ok: true, reputation: { score: 3 + 1 - 3 - 1, trades: 7, completedConfirmed: 4, oneSided: 1, distinctCounterparties: 2, capped: 1, lost: 1, disputeClaims: 1 } },
    bindingLevels: { root_consented: 'root-consented', delegated_only: 'delegated-only' }
  },
  extra: { bindingRevocationP2: revocation, pinnedHead: { [P.pk]: { seq: head.body.seq, hash: head.body.hash } } }
}

// ---- cases: inputs plus HAND-WRITTEN expectations (never computed by a verifier) ---------------------
const clone = (x) => JSON.parse(JSON.stringify(x))
const flip = (hexStr) => (hexStr[0] === '0' ? '1' : '0') + hexStr.slice(1)
const repOK = vectors.expected.positive.reputation
const cases = []
const bcase = (name, input, expect, opts = {}) => cases.push({ name, type: 'binding', input, opts, expect })
const pcase = (name, input, expect, opts = {}) => cases.push({ name, type: 'package', input, opts, expect })

bcase('binding/root-consented', bindingA, { ok: true, level: 'root-consented' })
bcase('binding/delegated-only is refused when root consent is required', bindingDelegatedOnly, { ok: false, reason: 'not-root-consented' })
bcase('binding/delegated-only is reported as such when allowed', bindingDelegatedOnly, { ok: true, level: 'delegated-only' }, { requireLevel: 'any' })
bcase('binding/expired statement', expiredBinding, { ok: false, reason: 'statement-validity' })
bcase('binding/wrong audience', bindingA, { ok: false, reason: 'audience' }, { audience: 'other.example' })
bcase('binding/now after grant expiry', bindingA, { ok: false, reason: 'grant-not-valid-now' }, { now: NOW + 3 * 365 * 86400 })
{ const b = clone(bindingA); b.participantSig = flip(b.participantSig); bcase('binding/participant signature flipped', b, { ok: false, reason: 'participant-signature' }) }
{ const b = clone(bindingA); const p = b.grant.split('.'); const c = JSON.parse(Buffer.from(p[1], 'base64url')); c.caps.push('/pub/extra/:rw'); p[1] = Buffer.from(JSON.stringify(c)).toString('base64url'); b.grant = p.join('.'); bcase('binding/grant claims altered (caps widened)', b, { ok: false, reason: 'grant-signature' }) }
{ const b = clone(bindingA); b.statement.nonce = hexs(0x11); bcase('binding/statement changed after the delegate signed', b, { ok: false, reason: 'delegate-statement-mismatch' }) }
{ const b = clone(bindingA); const pop = delegatePop(delegate2, { jti: 'jtiGrantA00000000000A', iat: NOW - 10, nonce: 'AAAAAAAAAAAAAAAAAAAAAA', data: b.statement }); b.delegatePop = pop; bcase('binding/PoP signed by a key that is not the grant cnf', b, { ok: false, reason: 'delegate-signature' }) }
{ const b = clone(bindingA); b.statement.pubky = bindingA2.statement.pubky === b.statement.pubky ? b.statement.pubky.replace(/^./, 'y') : bindingA2.statement.pubky; bcase('binding/pubky differs from grant issuer', b, { ok: false, reason: 'pubky-mismatch' }) }
{ const b = clone(bindingA); b.statement.v = 2; bcase('binding/unknown version', b, { ok: false, reason: 'malformed' }) }

pcase('package/positive', pkg, { ok: true, reputation: repOK })
{ const p = clone(pkg); p.chains[0].facts.splice(3, 1); pcase('package/a negative-or-any fact removed from the middle (cherry-picking)', p, { ok: false, reason: 'chain:seq-gap' }) }
{ const p = clone(pkg); p.chains[0].facts.pop(); pcase('package/tail removed, old head kept', p, { ok: false, reason: 'chain:head-mismatch' }) }
{ const p = clone(pkg); const body = { ...p.chains[0].head.body }; /* participant re-signs a shorter chain: needs the participant key, so build it with it */ p.chains[0].facts.pop(); const ch = new Chain(P); for (const f of p.chains[0].facts) ch.facts.push(f), ch.prev = idOf('fact', f.body); p.chains[0].head = ch.head(NOW - 800); void body
  pcase('package/tail removed and head re-signed by the participant, verifier has NO pinned head', p, { ok: true, reputation: { ...repOK, trades: 6, lost: 0, score: 4 - 0 - 1 } })
  pcase('package/same truncation, verifier pinned the earlier head', p, { ok: false, reason: 'chain:head-older-than-pinned' }, { pinnedHead: vectors.extra.pinnedHead }) }
{ const p = clone(pkg); p.chains[0].facts[2].body.outcome = 'disputed-lost'; pcase('package/outcome edited after signing', p, { ok: false, reason: 'chain:fact-signature' }) }
{ const p = clone(pkg); p.bindingRevocations = [bindingRevocation(P, bindingA.statement.pubky, NOW - 5)]; pcase('package/binding revoked by the participant', p, { ok: false, reason: 'no-active-binding' }) }
{ const p = clone(pkg); p.bindings = [bindingDelegatedOnly]; pcase('package/only a delegated-only binding', p, { ok: false, reason: 'binding:not-root-consented' }) }
{ const p = clone(pkg); p.chains[0].participant = P2.pk; pcase('package/chain claims a participant that is not bound', p, { ok: false, reason: 'chain:participant-not-bound' }) }
{ const p = clone(pkg); p.confirmations = p.confirmations.map((c) => ({ ...c, sig: flip(c.sig) })); pcase('package/all confirmations forged', p, { ok: true, reputation: { ...repOK, completedConfirmed: 0, oneSided: 6, distinctCounterparties: 0, capped: 0, score: 0 - 3 - 1 } }) }
{ const p = clone(pkg); p.confirmations = p.confirmations.map((c) => confirmation(P, P.pk, { tradeCommit: c.body.tradeCommit, outcome: c.body.outcome, iat: c.body.iat })); pcase('package/self-confirmations (issuer confirms own trades)', p, { ok: true, reputation: { ...repOK, completedConfirmed: 0, oneSided: 6, distinctCounterparties: 0, capped: 0, score: 0 - 3 - 1 } }) }
{ const p = clone(pkg); p.openings = {}; pcase('package/no openings given (privacy: nothing disclosed)', p, { ok: true, reputation: { ...repOK, completedConfirmed: 0, oneSided: 6, distinctCounterparties: 0, capped: 0, score: 0 - 3 - 1 } }) }
{ const p = clone(pkg); p.disputeClaims = []; pcase('package/dispute claim by a counterparty is withheld by the user', p, { ok: true, reputation: { ...repOK, disputeClaims: 0, score: repOK.score + 1 } }) }
{ const p = clone(pkg); p.disputeClaims = [p.disputeClaims[0], p.disputeClaims[0]]; pcase('package/same dispute claim presented twice counts once', p, { ok: true, reputation: repOK }) }
{ const p = clone(pkg); p.disputeClaims = [{ ...p.disputeClaims[0], sig: flip(p.disputeClaims[0].sig) }]; pcase('package/forged dispute claim ignored', p, { ok: true, reputation: { ...repOK, disputeClaims: 0, score: repOK.score + 1 } }) }
{ // Sybil: five sock-puppet counterparties with one confirmed trade each
  const ch = new Chain(P); const op = {}; const cf = []
  Q.forEach((q, i) => { const tradeSalt = hexs(0x60 + i); const partySalt = hexs(0x70 + i); const tc = commitTrade(tradeSalt, `sybil-${i}`); ch.append({ tradeCommit: tc, counterpartyCommit: commitParty(partySalt, q.pk), outcome: 'completed', iat: NOW - 500 + i }); op[tc] = { tradeRef: `sybil-${i}`, tradeSalt, counterparty: q.pk, partySalt }; cf.push(confirmation(q, P.pk, { tradeCommit: tc, outcome: 'completed', iat: NOW - 400 + i })) })
  pcase('package/five colluding keys each confirm one trade: ACCEPTED (known limitation: Sybil), counted as 5 distinct', { bindings: [bindingA], chains: [{ participant: P.pk, facts: ch.facts, head: ch.head(NOW - 300) }], confirmations: cf, openings: op, disputeClaims: [] }, { ok: true, reputation: { score: 5, trades: 5, completedConfirmed: 5, oneSided: 0, distinctCounterparties: 5, capped: 0, lost: 0, disputeClaims: 0 } }) }
{ // wash trading: ten trades with one counterparty
  const ch = new Chain(P); const op = {}; const cf = []
  for (let i = 0; i < 10; i++) { const tradeSalt = hexs(0x80 + i); const partySalt = hexs(0x90 + i); const tc = commitTrade(tradeSalt, `wash-${i}`); ch.append({ tradeCommit: tc, counterpartyCommit: commitParty(partySalt, Q[0].pk), outcome: 'completed', iat: NOW - 500 + i }); op[tc] = { tradeRef: `wash-${i}`, tradeSalt, counterparty: Q[0].pk, partySalt }; cf.push(confirmation(Q[0], P.pk, { tradeCommit: tc, outcome: 'completed', iat: NOW - 400 + i })) }
  pcase('package/ten wash trades with one counterparty are capped at 3', { bindings: [bindingA], chains: [{ participant: P.pk, facts: ch.facts, head: ch.head(NOW - 300) }], confirmations: cf, openings: op, disputeClaims: [] }, { ok: true, reputation: { score: 3, trades: 10, completedConfirmed: 3, oneSided: 0, distinctCounterparties: 1, capped: 7, lost: 0, disputeClaims: 0 } }) }
{ // chain link re-signed with a wrong prev (the participant itself signs the broken link)
  const ch = new Chain(P); const mk = (i) => { const ts = hexs(0xa0 + i); return commitTrade(ts, `lnk-${i}`) }
  ch.append({ tradeCommit: mk(0), counterpartyCommit: hexs(1), outcome: 'completed', iat: NOW - 300 }); ch.append({ tradeCommit: mk(1), counterpartyCommit: hexs(1), outcome: 'completed', iat: NOW - 299 })
  ch.prev = '1'.repeat(64); ch.append({ tradeCommit: mk(2), counterpartyCommit: hexs(1), outcome: 'completed', iat: NOW - 298 })
  pcase('package/a link signed with the wrong previous hash', { bindings: [bindingA], chains: [{ participant: P.pk, facts: ch.facts, head: ch.head(NOW - 200) }], confirmations: [], openings: {}, disputeClaims: [] }, { ok: false, reason: 'chain:chain-broken' }) }
{ // the participant names ITSELF as the counterparty and confirms its own trade
  const ch = new Chain(P); const tradeSalt = hexs(0xb1); const partySalt = hexs(0xb2); const tc = commitTrade(tradeSalt, 'self-1')
  ch.append({ tradeCommit: tc, counterpartyCommit: commitParty(partySalt, P.pk), outcome: 'completed', iat: NOW - 300 })
  pcase('package/the issuer is its own counterparty and confirms itself', { bindings: [bindingA], chains: [{ participant: P.pk, facts: ch.facts, head: ch.head(NOW - 200) }], confirmations: [confirmation(P, P.pk, { tradeCommit: tc, outcome: 'completed', iat: NOW - 290 })], openings: { [tc]: { tradeRef: 'self-1', tradeSalt, counterparty: P.pk, partySalt } }, disputeClaims: [] }, { ok: true, reputation: { score: 0, trades: 1, completedConfirmed: 0, oneSided: 1, distinctCounterparties: 0, capped: 0, lost: 0, disputeClaims: 0 } }) }
{ const p = clone(pkg); const tc0 = p.chains[0].facts[0].body.tradeCommit; p.openings[tc0].partySalt = hexs(0xee)
  pcase('package/an opening that does not match its commitment is ignored (trade stays one-sided)', p, { ok: true, reputation: { ...repOK, completedConfirmed: 4, capped: 0, oneSided: 2, distinctCounterparties: 2, score: 0 } }) }
{ // a later fact for the same trade corrects the outcome: the LAST one counts
  const ch = new Chain(P); const tradeSalt = hexs(0xc1); const partySalt = hexs(0xc2); const tc = commitTrade(tradeSalt, 'fix-1'); const pc = commitParty(partySalt, Q[0].pk)
  ch.append({ tradeCommit: tc, counterpartyCommit: pc, outcome: 'completed', iat: NOW - 300 }); ch.append({ tradeCommit: tc, counterpartyCommit: pc, outcome: 'disputed-lost', iat: NOW - 200 })
  pcase('package/a correction for the same trade replaces the earlier outcome', { bindings: [bindingA], chains: [{ participant: P.pk, facts: ch.facts, head: ch.head(NOW - 100) }], confirmations: [confirmation(Q[0], P.pk, { tradeCommit: tc, outcome: 'completed', iat: NOW - 290 })], openings: { [tc]: { tradeRef: 'fix-1', tradeSalt, counterparty: Q[0].pk, partySalt } }, disputeClaims: [] }, { ok: true, reputation: { score: -3, trades: 1, completedConfirmed: 0, oneSided: 0, distinctCounterparties: 0, capped: 0, lost: 1, disputeClaims: 0 } }) }
pcase('package/the verifier expects another Pubky identity', pkg, { ok: false, reason: 'wrong-identity' }, { expectedPubky: bindingA2.statement.pubky.replace(/^./, 'y') })
pcase('package/the verifier expects exactly this Pubky identity', pkg, { ok: true, reputation: repOK }, { expectedPubky: bindingA.statement.pubky })
vectors.cases = cases
const file = path.resolve(import.meta.dirname, '../vectors/portable-v1.json')
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, JSON.stringify(vectors, null, 1) + '\n')
console.log('wrote', file)
