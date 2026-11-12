// tests/logger.test.ts
//
// Missão 11 Fase 8.1 LB-09 — proves the shared common/logger.ts config
// (used outside the Fastify request lifecycle) actually redacts
// credential-shaped fields and connection-string substrings in real
// output, while correlation identifiers (escrowId, module, etc.) survive
// unredacted — a real behavioral test, not just a config-shape assertion.
//
// Builds its own pino instance from the EXACT exported `loggerOptions`
// (the same options the real `logger` singleton is constructed from)
// against a synchronous, directly-readable in-memory destination — pino
// writes via sonic-boom by default, not a plain synchronous
// `stream.write()`, so spying on process.stdout.write on the real
// singleton is not reliably synchronous with the log call.

import pino from 'pino'
import { Writable } from 'stream'
import { loggerOptions } from '../src/common/logger'

function buildTestLogger() {
  const lines: string[] = []
  const destination = new Writable({
    write(chunk, _enc, callback) {
      lines.push(chunk.toString())
      callback()
    },
  })
  const log = pino(loggerOptions, destination)
  return { log, lines }
}

function lastLine(lines: string[]): Record<string, unknown> {
  return JSON.parse(lines[lines.length - 1])
}

describe('common/logger.ts — Missão 11 Fase 8.1 LB-09 (redaction outside the Fastify request lifecycle)', () => {
  it('redacts a top-level token field', () => {
    const { log, lines } = buildTestLogger()
    log.info({ msg: 'session created', token: 'super-secret-session-token' })
    expect(lastLine(lines).token).toBe('[REDACTED]')
  })

  it('redacts a top-level password field', () => {
    const { log, lines } = buildTestLogger()
    log.info({ msg: 'db connect', password: 'hunter2' })
    expect(lastLine(lines).password).toBe('[REDACTED]')
  })

  it('redacts databaseUrl/redisUrl fields directly', () => {
    const { log, lines } = buildTestLogger()
    log.info({ msg: 'connecting', databaseUrl: 'postgresql://user:pass@host:5432/db', redisUrl: 'redis://user:pass@host:6379' })
    const parsed = lastLine(lines)
    expect(parsed.databaseUrl).toBe('[REDACTED]')
    expect(parsed.redisUrl).toBe('[REDACTED]')
  })

  it('redacts a seed/privateKey/mnemonic field wherever one appears', () => {
    const { log, lines } = buildTestLogger()
    log.info({ msg: 'key material', seed: 'abandon abandon abandon', privateKey: 'deadbeef', mnemonic: 'zoo zoo zoo' })
    const parsed = lastLine(lines)
    expect(parsed.seed).toBe('[REDACTED]')
    expect(parsed.privateKey).toBe('[REDACTED]')
    expect(parsed.mnemonic).toBe('[REDACTED]')
  })

  it('redacts a one-level-nested credential field via the wildcard path', () => {
    const { log, lines } = buildTestLogger()
    log.info({ msg: 'nested', session: { token: 'nested-secret' } })
    const parsed = lastLine(lines) as any
    expect(parsed.session.token).toBe('[REDACTED]')
  })

  it('scrubs credentials embedded INSIDE a real Error.message, without destroying the rest of the message', () => {
    const { log, lines } = buildTestLogger()
    const err = new Error('connect ECONNREFUSED to postgresql://postgres:password@localhost:5432/sails_protocol')
    log.error({ msg: 'db connection failed', err })
    const errField = lastLine(lines).err as Record<string, unknown>
    expect(String(errField.message)).not.toContain('password')
    expect(String(errField.message)).toContain('[REDACTED]')
    expect(String(errField.message)).toContain('ECONNREFUSED') // the rest of the message survives — logs stay useful
  })

  it('scrubs credentials embedded inside Error.stack too', () => {
    const { log, lines } = buildTestLogger()
    const err = new Error('boom')
    err.stack = `Error: boom\n    at postgresql://postgres:password@localhost:5432/sails_protocol`
    log.error({ msg: 'failure', err })
    const errField = lastLine(lines).err as Record<string, unknown>
    expect(String(errField.stack)).not.toContain('password')
  })

  it.each([
    ['an empty user', 'redis://:redis-secret@cache:6379', 'redis-secret'],
    ['a query parameter', 'postgresql://db:5432/sails?sslmode=require&password=query-secret', 'query-secret'],
  ])('scrubs a credential carried with %s, keeping the host', (_, dsn, credential) => {
    const { log, lines } = buildTestLogger()
    log.error({ msg: 'connect failed', err: new Error(`connect failed: ${dsn}`) })
    const message = String((lastLine(lines).err as Record<string, unknown>).message)
    expect(message).not.toContain(credential)
    expect(message).toContain('[REDACTED]')
    expect(message).toMatch(/cache:6379|db:5432/)
  })

  it('leaves useful correlation identifiers (module, escrowId, tradeId) fully readable — redaction does not make logs useless', () => {
    const { log, lines } = buildTestLogger()
    log.child({ module: 'multisig-fee-confirmation-job' }).info({ msg: 'sweep completed', escrowId: 'escrow-42', tradeId: 'trade-7', collected: 3 })
    const parsed = lastLine(lines)
    expect(parsed.module).toBe('multisig-fee-confirmation-job')
    expect(parsed.msg).toBe('sweep completed')
    expect(parsed.escrowId).toBe('escrow-42')
    expect(parsed.tradeId).toBe('trade-7')
    expect(parsed.collected).toBe(3)
  })

  it('a plain error message with no embedded credentials is left completely untouched', () => {
    const { log, lines } = buildTestLogger()
    const err = new Error('Escrow escrow-1 not found')
    log.error({ msg: 'lookup failed', err })
    const errField = lastLine(lines).err as Record<string, unknown>
    expect(errField.message).toBe('Escrow escrow-1 not found')
  })
})
