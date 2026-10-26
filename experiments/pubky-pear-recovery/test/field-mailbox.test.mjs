// Self-test of field/mailbox.mjs on a LOCAL testnet: sender writes and goes offline, a seeder holds the data, the recipient reads it later.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import readline from 'node:readline'
import createTestnet from 'hyperdht/testnet.js'

const KIT = path.resolve(import.meta.dirname, '../field/mailbox.mjs')
const run = (args, onLine) => {
  const child = spawn(process.execPath, [KIT, ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
  const lines = []
  readline.createInterface({ input: child.stdout }).on('line', (l) => { try { const o = JSON.parse(l); lines.push(o); onLine?.(o) } catch {} })
  return { child, lines, done: new Promise((r) => child.on('exit', r)) }
}
const until = async (pred, ms = 40000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = pred(); if (v) return v; await new Promise((r) => setTimeout(r, 150)) } throw new Error('timeout waiting') }

test('M1 mailbox kit: write -> seeder holds -> sender offline -> recipient reads and opens it', async (t) => {
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',')
  const dirs = ['sender', 'seed', 'read'].map((n) => fs.mkdtempSync(path.join(os.tmpdir(), `ppr-mb-${n}-`)))
  const kids = []
  t.after(async () => { for (const k of kids) k.child.kill(); await testnet.destroy(); await new Promise((r) => setTimeout(r, 500)); for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })

  const id = spawnSync(process.execPath, [KIT, 'identity'], { encoding: 'utf8' })
  const { seed, pear } = JSON.parse(id.stdout)
  const sender = run(['write', '--dir', dirs[0], '--to', pear, '--text', 'offer 0.01 BTC at 14h', '--hold', '25', '--bootstrap', bootstrap]); kids.push(sender)
  const written = await until(() => sender.lines.find((l) => l.event === 'written'))
  const seeder = run(['seed', '--dir', dirs[1], '--key', written.mailboxKey, '--bootstrap', bootstrap]); kids.push(seeder)
  await until(() => seeder.lines.find((l) => l.event === 'replicated'), 90000)
  await until(() => sender.lines.find((l) => l.event === 'sender-offline'), 60000) // sender is gone
  const reader = run(['read', '--dir', dirs[2], '--key', written.mailboxKey, '--seed', seed, '--timeout', '90', '--bootstrap', bootstrap]); kids.push(reader)
  const got = await until(() => reader.lines.find((l) => l.event === 'delivered' || l.event === 'not-delivered' || l.event === 'cannot-open'), 100000)
  assert.equal(got.event, 'delivered')
  assert.equal(got.text, 'offer 0.01 BTC at 14h')
})
