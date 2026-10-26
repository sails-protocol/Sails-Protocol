// Shared helpers for the homeserver experiment. Runs inside the runner container.
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import path from 'node:path'

const require = createRequire(import.meta.url)
export const sdk = require('@synonymdev/pubky')

export const HOST = process.env.PUBKY_TESTNET_HOST ?? 'localhost'
export const HOMESERVER_PK = '8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo' // testnet static homeserver key
export const HOMESERVER_HTTP = `http://${HOST}:6286`
export const RELAY = `http://${HOST}:15412/link/`
export const PEAR_DIR = '/pub/sails.market/pear'
export const STATE_DIR = '/state'

export const testnet = () => sdk.Pubky.testnet(HOST)

// Bound every call: Pubky 0.16.2 sets no total HTTP deadline by default.
export const within = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms))
])

// ---- tiny JSON-lines RPC between the test (parent) and a role process (child) -------

export function serve (handlers) {
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', async (line) => {
    const { id, cmd, args } = JSON.parse(line)
    try {
      const result = await handlers[cmd](args ?? {})
      process.stdout.write(JSON.stringify({ id, ok: true, result: result ?? null }) + '\n')
    } catch (e) {
      process.stdout.write(JSON.stringify({ id, ok: false, error: { name: e?.name, message: String(e?.message ?? e).slice(0, 300) } }) + '\n')
    }
  })
}

const live = new Set()
export const closeAll = () => { for (const c of live) c.kill(); live.clear() }

export function spawnRole (script, env = {}) {
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, script)], {
    // Minimal environment on purpose: a role only gets what its job needs.
    env: { PATH: process.env.PATH, PUBKY_TESTNET_HOST: HOST, ...env },
    stdio: ['pipe', 'pipe', 'inherit']
  })
  live.add(child)
  child.on('exit', () => live.delete(child))
  const pending = new Map()
  let seq = 0
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line)
    pending.get(msg.id)?.(msg)
    pending.delete(msg.id)
  })
  return {
    child,
    call (cmd, args = {}, ms = 30000) {
      const id = ++seq
      const p = new Promise((resolve) => pending.set(id, resolve))
      child.stdin.write(JSON.stringify({ id, cmd, args }) + '\n')
      return within(p, ms, `${script}:${cmd}`).then((m) => (m.ok ? m.result : Promise.reject(Object.assign(new Error(m.error.message), { name: m.error.name }))))
    },
    async ok (cmd, args, ms) { return this.call(cmd, args, ms) },
    async fails (cmd, args, ms) {
      try { await this.call(cmd, args, ms) } catch (e) { return e }
      throw new Error(`expected ${cmd} to fail`)
    },
    close () { child.stdin.end(); child.kill() }
  }
}
