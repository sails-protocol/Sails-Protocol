// tests/diagnostics/ticketStallMechanisms.ts — #307 Phase B.2.
//
// NOT a CI test. Reproduces, deterministically, the two mechanisms that yield
// the exact client-side signature of the observed stall — both concurrent
// POST /v1/identity/ws-ticket calls to two server processes failing with
// "Request timed out after 15000ms" while Redis SLOWLOG stays empty — and
// records what each server logged, so a recurrence can be attributed:
//
//   E1  Redis stops answering without executing anything slow
//       (CLIENT PAUSE 17000 ALL): the servers wait on Redis.
//   E2  The client process freezes (event loop blocked 16 s): the servers
//       answer in milliseconds, the client's timers fire before it reads them.
//
// Run: node -r ts-node/register/transpile-only tests/diagnostics/ticketStallMechanisms.ts <outDir>

process.env.RATE_LIMIT_MAX = '100000'
process.env.RATE_LIMIT_AUTH_MAX = '100000'

import { fork, type ChildProcess } from 'child_process'
import { createWriteStream, mkdirSync, readFileSync } from 'fs'
import path from 'path'
import WebSocket from 'ws'
import Redis from 'ioredis'

const outDir = process.argv[2] ?? path.join(process.cwd(), 'stall-mechanisms-out')
mkdirSync(outDir, { recursive: true })

async function spawnServer(file: string): Promise<{ child: ChildProcess; base: string }> {
  const out = createWriteStream(path.join(outDir, file))
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

// Server-side responseTime of each ws-ticket request (pino "request completed").
function ticketResponseTimes(file: string): number[] {
  const lines = readFileSync(path.join(outDir, file), 'utf-8').split('\n')
  const ids = new Set<string>()
  const times: number[] = []
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    let entry: { reqId?: string; req?: { url?: string }; responseTime?: number }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.req?.url === '/v1/identity/ws-ticket' && entry.reqId) ids.add(entry.reqId)
    if (entry.reqId && ids.has(entry.reqId) && typeof entry.responseTime === 'number') times.push(Math.round(entry.responseTime))
  }
  return times
}

async function experiment(name: string, disturb: () => Promise<void> | void): Promise<Record<string, unknown>> {
  const { SailsClient } = require('../../packages/sails-sdk/src/client')
  const [p1, p2] = await Promise.all([spawnServer(`${name}-p1.jsonl`), spawnServer(`${name}-p2.jsonl`)])
  const owner = new SailsClient({ baseUrl: p1.base, webSocketImpl: WebSocket })
  const { keypair } = await owner.identity.create()
  await owner.identity.authenticate(keypair)
  const on = (base: string) => {
    const sdk = new SailsClient({ baseUrl: base, webSocketImpl: WebSocket })
    sdk.setSessionToken(owner.getSessionToken())
    return sdk
  }
  const before = { p1: ticketResponseTimes(`${name}-p1.jsonl`).length, p2: ticketResponseTimes(`${name}-p2.jsonl`).length }
  const t0 = Date.now()
  const attempts = Promise.allSettled([on(p1.base).peers.connectRelay(), on(p2.base).peers.connectRelay()])
  await disturb()
  const settled = await attempts
  const elapsedMs = Date.now() - t0
  for (const s of settled) if (s.status === 'fulfilled') (s.value as WebSocket).terminate()
  await new Promise(resolve => setTimeout(resolve, 2500)) // let the servers finish and flush logs
  for (const p of [p1, p2]) p.child.send('stop')
  await new Promise(resolve => setTimeout(resolve, 1500))
  return {
    experiment: name,
    clientElapsedMs: elapsedMs,
    clientOutcomes: settled.map(s => (s.status === 'fulfilled' ? 'connected' : String((s as PromiseRejectedResult).reason))),
    serverTicketResponseTimesMs: {
      p1: ticketResponseTimes(`${name}-p1.jsonl`).slice(before.p1),
      p2: ticketResponseTimes(`${name}-p2.jsonl`).slice(before.p2),
    },
  }
}

async function main(): Promise<void> {
  const admin = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379')
  await admin.call('SLOWLOG', 'RESET')
  const results = []
  results.push(await experiment('E1-redis-pause', async () => {
    await new Promise(resolve => setTimeout(resolve, 5)) // let both requests leave the client
    await admin.call('CLIENT', 'PAUSE', '17000', 'ALL')
  }))
  results.push({ slowlogAfterE1: (await admin.call('SLOWLOG', 'LEN')) })
  results.push(await experiment('E2-client-freeze', () => {
    const until = Date.now() + 16_000
    while (Date.now() < until) { /* the client process's event loop is frozen */ }
  }))
  console.log(JSON.stringify(results, null, 2))
  admin.disconnect()
  require('../../src/common/redis').redis.disconnect()
  await require('../../src/common/database').prisma.$disconnect()
  setTimeout(() => process.exit(0), 1000).unref()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
