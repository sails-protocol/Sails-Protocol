// tests/diagnostics/containerFlowSmoke.ts — Node 24 runtime migration evidence.
//
// NOT a CI test. Exercises the security-critical flows against a server that
// runs inside the real production image (docker compose stack: postgres,
// redis, migrate, app), from the host, through the published port:
//   health -> SDK identity.create/authenticate (Postgres + Redis session)
//   -> authenticated read -> SDK connectRelay (HTTP ticket, Redis burn, READY)
//   -> ticket replay rejected -> Alice -> Bob delivery on an authorized trade
//   (envelope, authorization, routing) with Carol receiving nothing.
// The Trade/Offer rows that authorize the pair are inserted with psql inside
// the compose postgres container (fixtures; the authorization reads them).
//
// The relay READY handshake and Alice -> Bob delivery exist only once #307
// Phases A/B land; against a build without them (e.g. main) the script checks
// the relay ticket on its own (the socket stays open, a replay gets ERROR) and
// reports delivery as NOT_AVAILABLE instead of failing or pretending.
//
// Run: node -r ts-node/register/transpile-only tests/diagnostics/containerFlowSmoke.ts http://localhost:3000 <compose-project>

import { execFileSync } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import WebSocket from 'ws'

const base = process.argv[2] ?? 'http://localhost:3000'
const project = process.argv[3] ?? 'sails'
const { SailsClient } = require('../../packages/sails-sdk/src/client')

type Frame = Record<string, unknown>
const results: Record<string, unknown> = {}
const check = (name: string, ok: boolean, detail?: unknown) => {
  results[name] = ok ? 'PASS' : { FAIL: detail }
  if (!ok) process.exitCode = 1
}

const psql = (sql: string) => execFileSync('docker', [
  'compose', '-p', project, 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'sails_protocol', '-v', 'ON_ERROR_STOP=1', '-c', sql,
], { encoding: 'utf-8' })

const inbox = (ws: WebSocket) => {
  const frames: Frame[] = []
  ws.on('message', d => frames.push(JSON.parse(d.toString()) as Frame))
  return frames
}
const waitFor = async (frames: Frame[], match: (f: Frame) => boolean, ms = 5000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const f = frames.find(match)
    if (f) return f
    await new Promise(r => setTimeout(r, 25))
  }
  return undefined
}

async function main(): Promise<void> {
  const health = await fetch(base + '/health').then(r => r.json() as Promise<Frame>)
  check('health ok', health.status === 'ok', health)

  const party = async () => {
    const sdk = new SailsClient({ baseUrl: base, webSocketImpl: WebSocket })
    const { keypair } = await sdk.identity.create()
    const { participantId, sessionToken } = await sdk.identity.authenticate(keypair)
    return { sdk, id: participantId as string, token: sessionToken as string }
  }
  const [alice, bob, carol] = [await party(), await party(), await party()]
  check('identity create + authenticate (Postgres + Redis session)', Boolean(alice.id && bob.id && carol.id))

  const me = await fetch(base + '/v1/identity/me', { headers: { authorization: 'Bearer ' + alice.token } })
  check('authenticated read', me.status === 200, me.status)

  const offerId = randomUUID()
  const tradeId = randomUUID()
  psql(`INSERT INTO offers ("id","userId","asset","side","priceUsd","minAmount","maxAmount","paymentMethod","status","moduleId","protocolVersion","createdAt","updatedAt")
        VALUES ('${offerId}','${bob.id}','BTC','SELL',1,1,1,'PIX','ACTIVE','openliquidity','0.1',now(),now())`)
  psql(`INSERT INTO trades ("id","offerId","buyerId","sellerId","asset","amount","priceUsd","totalUsd","status","moduleId","protocolVersion","intentType","createdAt","updatedAt")
        VALUES ('${tradeId}','${offerId}','${alice.id}','${bob.id}','BTC',1,1,1,'ACTIVE','openp2p','0.1','TradeIntent',now(),now())`)

  // Ticket issued over HTTP, burned on upgrade, READY consumed by the SDK.
  const ticketRes = await fetch(base + '/v1/identity/ws-ticket', {
    method: 'POST', headers: { authorization: 'Bearer ' + alice.token, 'content-type': 'application/json' }, body: '{}',
  })
  const { data: { ticket } } = await ticketRes.json() as { data: { ticket: string } }
  const first = new WebSocket(base.replace(/^http/, 'ws') + '/ws/relay?ticket=' + ticket)
  const firstFrames = inbox(first)
  const hasReady = Boolean(await waitFor(firstFrames, f => f.type === 'READY', 1500))
  if (hasReady) {
    check('ws-ticket upgrade -> READY', true)
  } else {
    // Pre-READY relay: an accepted ticket leaves the socket open, no ERROR.
    check('ws-ticket upgrade accepted (socket open, no ERROR)',
      first.readyState === WebSocket.OPEN && !firstFrames.some(f => f.type === 'ERROR'), { readyState: first.readyState, firstFrames })
  }
  first.terminate()
  const replay = new WebSocket(base.replace(/^http/, 'ws') + '/ws/relay?ticket=' + ticket)
  const replayFrames = inbox(replay)
  const replayClosed = await new Promise<boolean>(resolve => {
    replay.once('close', () => resolve(true))
    setTimeout(() => resolve(false), 5000)
  })
  check('ticket replay rejected (closed, no READY)', replayClosed && !replayFrames.some(f => f.type === 'READY'), replayFrames)

  if (typeof alice.sdk.peers.connectRelay !== 'function' || !hasReady) {
    results['Alice -> Bob delivery'] = 'NOT_AVAILABLE in this build (relay READY / Phase B delivery not present)'
    console.log(JSON.stringify(results, null, 2))
    return
  }

  const [a, b, c] = [await alice.sdk.peers.connectRelay(), await bob.sdk.peers.connectRelay(), await carol.sdk.peers.connectRelay()]
  const [aIn, bIn, cIn] = [inbox(a), inbox(b), inbox(c)]
  const id = randomBytes(16).toString('base64url')
  a.send(JSON.stringify({ v: 1, type: 'SEND', id, to: bob.id, trade: tradeId, body: 'hello from inside the Node 24 image' }))
  const ack = await waitFor(aIn, f => f.id === id)
  const msg = await waitFor(bIn, f => f.type === 'MESSAGE')
  await new Promise(r => setTimeout(r, 300))
  check('Alice -> Bob: SENT', JSON.stringify(ack) === JSON.stringify({ type: 'SENT', id }), ack)
  check('Bob receives MESSAGE with from = Alice', msg?.from === alice.id && msg?.body === 'hello from inside the Node 24 image', msg)
  check('Carol receives nothing', cIn.length === 0, cIn)
  for (const ws of [a, b, c]) ws.terminate()

  console.log(JSON.stringify(results, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
