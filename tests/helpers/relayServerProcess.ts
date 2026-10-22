// #307 Phase B: one complete Sails server in its own OS process, for the
// two-instance delivery test. Started with child_process.fork and
// `-r ts-node/register/transpile-only`; reports its port over IPC and shuts
// down like app.ts's graceful shutdown when it receives 'stop'.
// HTTP rate limiting is not under test; every participant comes from 127.0.0.1.
process.env.RATE_LIMIT_MAX ??= '1000'
process.env.RATE_LIMIT_AUTH_MAX ??= '1000'

async function main(): Promise<void> {
  const { buildApp } = require('../../src/app')
  const { prisma } = require('../../src/common/database')
  const { redis } = require('../../src/common/redis')
  if (process.env.RELAY_DIAG === '1') {
    // #307 B.2 stall investigation: event-loop delay and Redis connection
    // lifecycle, one JSON line each on stdout. No payloads, tokens or keys.
    const { monitorEventLoopDelay } = require('perf_hooks')
    const eld = monitorEventLoopDelay({ resolution: 10 })
    eld.enable()
    setInterval(() => {
      const maxMs = eld.max / 1e6
      if (maxMs > 100) console.log(JSON.stringify({ diag: 'event-loop-delay', maxMs: Math.round(maxMs), at: Date.now() }))
      eld.reset()
    }, 1000).unref()
    for (const event of ['connect', 'ready', 'close', 'reconnecting', 'end', 'error']) {
      redis.on(event, (arg: unknown) => console.log(JSON.stringify({
        diag: 'redis', event, at: Date.now(), detail: event === 'error' ? String((arg as Error)?.message) : undefined,
      })))
    }
  }
  const app = await buildApp({ registerSwaggerUi: false })
  await app.listen({ port: 0, host: '127.0.0.1' })
  process.on('message', async (message: unknown) => {
    if (message !== 'stop') return
    await app.close()
    await prisma.$disconnect()
    await redis.quit()
    process.exit(0)
  })
  process.send?.({ port: (app.server.address() as { port: number }).port })
}

main().catch(error => {
  process.send?.({ error: String(error && error.stack || error) })
  process.exit(1)
})
