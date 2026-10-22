// tests/diagnostics/ticketStallProbe.ts — #307 Phase B.2 stall investigation.
//
// NOT a CI test. Re-runs the load shape under which two concurrent
// POST /v1/identity/ws-ticket calls to two server processes both hit the
// SDK's 15 s timeout once in ~700 rounds, with every observation point
// recorded so a recurrence can be attributed instead of guessed:
//   - per ticket request: client-side start/end/duration and outcome;
//   - client event-loop delay (perf_hooks), > 100 ms;
//   - independent Redis PING round-trip every 200 ms, > 100 ms;
//   - each server's stdout (pino request logs with responseTime, plus the
//     RELAY_DIAG event-loop and Redis connection lines) to its own file.
// No tokens, tickets or payloads are written by this probe.
//
// Run (real Postgres + Redis, fresh DB recommended):
//   node -r ts-node/register/transpile-only tests/diagnostics/ticketStallProbe.ts <rounds> <outDir>

process.env.RATE_LIMIT_MAX = '100000'
process.env.RATE_LIMIT_AUTH_MAX = '100000'

import { fork, type ChildProcess } from 'child_process'
import { createWriteStream, mkdirSync } from 'fs'
import path from 'path'
import { monitorEventLoopDelay } from 'perf_hooks'
import WebSocket from 'ws'
import Redis from 'ioredis'

const rounds = Number(process.argv[2] ?? 500)
const outDir = process.argv[3] ?? path.join(process.cwd(), 'stall-probe-out')
// Pause between rounds: without it ~30k connections in 35 s exhaust Windows'
// 16k dynamic ports (TIME_WAIT), which fails fast and is a different signature.
const pauseMs = Number(process.argv[4] ?? 50)
mkdirSync(outDir, { recursive: true })
const events = createWriteStream(path.join(outDir, 'client-events.jsonl'))
const log = (o: Record<string, unknown>) => events.write(JSON.stringify({ at: Date.now(), ...o }) + '\n')

async function spawnServer(name: string): Promise<{ child: ChildProcess; base: string }> {
  const out = createWriteStream(path.join(outDir, `server-${name}.jsonl`))
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, '..', 'helpers', 'relayServerProcess.ts'), [], {
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, RELAY_DIAG: '1' },
    })
    child.stdout!.pipe(out)
    child.stderr!.pipe(out)
    child.once('message', (m: { port?: number; error?: string }) =>
      m.port ? resolve({ child, base: 'http://127.0.0.1:' + m.port }) : reject(new Error(m.error)))
  })
}

async function main(): Promise<void> {
  const { SailsClient } = require('../../packages/sails-sdk/src/client')
  const { prisma } = require('../../src/common/database')

  const eld = monitorEventLoopDelay({ resolution: 10 })
  eld.enable()
  const eldTimer = setInterval(() => {
    const maxMs = eld.max / 1e6
    if (maxMs > 100) log({ kind: 'client-event-loop-delay', maxMs: Math.round(maxMs) })
    eld.reset()
  }, 1000)

  const pinger = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1 })
  const pingTimer = setInterval(async () => {
    const t0 = Date.now()
    try {
      await pinger.ping()
      const ms = Date.now() - t0
      if (ms > 100) log({ kind: 'redis-ping-slow', ms })
    } catch (e) {
      log({ kind: 'redis-ping-error', ms: Date.now() - t0, error: String((e as Error).message) })
    }
  }, 200)

  const [p1, p2] = await Promise.all([spawnServer('p1'), spawnServer('p2')])
  // Every ticket request is timed on the client side; the URL path only.
  let seq = 0
  const timedFetch = (server: string): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const id = ++seq
    const url = new URL(String(input))
    const t0 = Date.now()
    try {
      const res = await fetch(input, init)
      const ms = Date.now() - t0
      if (url.pathname === '/v1/identity/ws-ticket') log({ kind: 'ticket', id, server, ms, status: res.status })
      return res
    } catch (e) {
      log({ kind: 'fetch-error', id, server, path: url.pathname, ms: Date.now() - t0, error: String((e as Error).message) })
      throw e
    }
  }) as typeof fetch
  const client = (base: string, server: string) =>
    new SailsClient({ baseUrl: base, fetchImpl: timedFetch(server), webSocketImpl: WebSocket })

  const makeParty = async (base: string, server: string) => {
    const sdk = client(base, server)
    const { keypair } = await sdk.identity.create()
    const { participantId } = await sdk.identity.authenticate(keypair)
    return { sdk, id: participantId as string }
  }
  const bob = await makeParty(p1.base, 'p1')
  const bobOn = (base: string, server: string) => {
    const sdk = client(base, server)
    sdk.setSessionToken(bob.sdk.getSessionToken())
    return sdk
  }
  let alice = await makeParty(p1.base, 'p1')
  const newTrade = async () => {
    const offer = await prisma.offer.create({ data: {
      userId: bob.id, asset: 'BTC', side: 'SELL', priceUsd: '1', minAmount: '1', maxAmount: '1', paymentMethod: 'PIX',
    } })
    return (await prisma.trade.create({ data: {
      offerId: offer.id, buyerId: alice.id, sellerId: bob.id, asset: 'BTC', amount: '1', priceUsd: '1', totalUsd: '1', status: 'ACTIVE',
    } })).id as string
  }
  let tradeId = await newTrade()
  let aliceWs: WebSocket = await alice.sdk.peers.connectRelay()

  const open: WebSocket[] = []
  let failures = 0
  const started = Date.now()
  for (let round = 0; round < rounds; round++) {
    if (round > 0 && round % 50 === 0) {
      aliceWs.terminate()
      alice = await makeParty(p1.base, 'p1')
      tradeId = await newTrade()
      aliceWs = await alice.sdk.peers.connectRelay()
    }
    const r0 = Date.now()
    const settled = await Promise.allSettled([bobOn(p1.base, 'p1').peers.connectRelay(), bobOn(p2.base, 'p2').peers.connectRelay()])
    const rejected = settled.filter(s => s.status === 'rejected').map(s => String((s as PromiseRejectedResult).reason))
    const fulfilled = settled.filter(s => s.status === 'fulfilled').length
    if (fulfilled === 0) {
      failures++
      log({ kind: 'BOTH-REJECTED', round, ms: Date.now() - r0, reasons: rejected })
    }
    for (const s of settled) if (s.status === 'fulfilled') open.push(s.value as WebSocket)
    aliceWs.send(JSON.stringify({ v: 1, type: 'SEND', id: 'r' + round + '-' + Date.now().toString(36).padStart(12, '0'), to: bob.id, trade: tradeId, body: 'x' }))
    while (open.length > 4) open.shift()!.terminate()
    await new Promise(resolve => setTimeout(resolve, pauseMs))
    if (round % 100 === 0) log({ kind: 'progress', round, elapsedS: Math.round((Date.now() - started) / 1000), failures })
  }
  log({ kind: 'done', rounds, failures, elapsedS: Math.round((Date.now() - started) / 1000) })
  console.log(JSON.stringify({ rounds, failures, outDir }))

  clearInterval(eldTimer)
  clearInterval(pingTimer)
  for (const ws of open) ws.terminate()
  aliceWs.terminate()
  for (const p of [p1, p2]) p.child.send('stop')
  pinger.disconnect()
  await prisma.$disconnect()
  require('../../src/common/redis').redis.disconnect()
  setTimeout(() => process.exit(0), 3000).unref()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
