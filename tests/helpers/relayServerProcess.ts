// #307 Phase B: one complete Sails server in its own OS process, for the
// two-instance delivery test. Started with child_process.fork and
// `-r ts-node/register/transpile-only`; reports its port over IPC and shuts
// down like app.ts's graceful shutdown when it receives 'stop'.
// HTTP rate limiting is not under test; every participant comes from 127.0.0.1.
process.env.RATE_LIMIT_MAX = '1000'
process.env.RATE_LIMIT_AUTH_MAX = '1000'

async function main(): Promise<void> {
  const { buildApp } = require('../../src/app')
  const { prisma } = require('../../src/common/database')
  const { redis } = require('../../src/common/redis')
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
