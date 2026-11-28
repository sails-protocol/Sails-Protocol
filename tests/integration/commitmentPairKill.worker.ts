// tests/integration/commitmentPairKill.worker.ts
//
// One OS process that runs ONE CommitmentPairService.signPair() call and freezes at a chosen point so the test can
// SIGKILL it there (commitmentPairPersistence.test.ts, D-1 / "pair never partial"). Test harness only: production code
// is unchanged on disk; this process wraps prisma.$transaction at runtime to observe it. Coordination is by files in
// SYNC_DIR, never by sleeping: the worker writes `arrived` (JSON: the point) and then waits forever.
//
// KILL_AT:
//   before-tx               the envelope already read (outside the transaction), before prisma.$transaction starts:
//                           the D-1 window between the read and the COMMITTED write (envelope-window barrier tests)
//   after-tx-envelope-read  inside the transaction, after its first getLatest call (only a design that re-reads the
//                           envelope inside the transaction reaches it; the result records `afterTxEnvelopeRead`)
//   after-pair-update       inside the transaction, the pair row already UPDATEd, before the idempotency claim insert
//   after-claim             inside the transaction, pair UPDATEd and claim inserted, before COMMIT
//   after-commit            the transaction committed, before the call returns to its caller
//   none                    no stop; the call runs to its end
// HOLD=1: at KILL_AT the worker waits for a `go` file instead of forever (a barrier, not a kill), then continues.
// The call's outcome is written to `result` (JSON: { ok: true, view } or { ok: false, code }, plus `afterTxEnvelopeRead`).
// `arrived` also carries the envelope reads seen so far: { getLatestCalls, revisionsRead, statusesRead }.
import { existsSync, writeFileSync } from 'fs'
import path from 'path'

const syncDir = process.env.SYNC_DIR!
const killAt = process.env.KILL_AT!
const input = JSON.parse(process.env.SIGN_INPUT!)
const hold = process.env.HOLD === '1'
const reads: Array<{ revision: number | null; status: string | null; inTx: boolean }> = []
let inTx = false
let afterTxEnvelopeRead = false
const freeze = async (point: string): Promise<void> => {
  writeFileSync(path.join(syncDir, 'arrived'), JSON.stringify({
    point, pid: process.pid, getLatestCalls: reads.length, revisionsRead: reads.map((r) => r.revision), statusesRead: reads.map((r) => r.status),
  }))
  if (!hold) return new Promise<void>(() => {})
  while (!existsSync(path.join(syncDir, 'go'))) await new Promise((r) => setTimeout(r, 25))
}

async function main() {
  const { prisma } = require('../../src/common/database')
  // Observe the envelope reads (spy, same behavior): which revision signPair actually read, and whether inside a tx.
  const { offerEnvelopeRepository } = require('../../src/modules/open-liquidity/offer-envelope-repository')
  const realGetLatest = offerEnvelopeRepository.getLatest.bind(offerEnvelopeRepository)
  offerEnvelopeRepository.getLatest = async (owner: string, logicalId: string) => {
    const latest = await realGetLatest(owner, logicalId)
    reads.push({ revision: latest?.row?.revision ?? null, status: latest?.row?.status ?? latest?.status ?? null, inTx })
    if (inTx && killAt === 'after-tx-envelope-read' && !afterTxEnvelopeRead) { afterTxEnvelopeRead = true; await freeze(killAt) }
    return latest
  }
  const realTx = prisma.$transaction.bind(prisma)
  prisma.$transaction = async (fn: (tx: any) => Promise<unknown>, opts?: unknown) => {
    if (killAt === 'before-tx') await freeze(killAt)
    const result = await realTx(async (tx: any) => {
      inTx = true
      const proxied = new Proxy(tx, {
        get(target, prop) {
          if (prop === 'commitmentPair') {
            const model = target.commitmentPair
            return { ...model, findUniqueOrThrow: model.findUniqueOrThrow.bind(model), update: async (a: unknown) => {
              const r = await model.update(a)
              if (killAt === 'after-pair-update') await freeze(killAt)
              return r
            } }
          }
          if (prop === 'idempotencyKey') {
            const model = target.idempotencyKey
            return { ...model, create: async (a: unknown) => {
              const r = await model.create(a)
              if (killAt === 'after-claim') await freeze(killAt)
              return r
            } }
          }
          const v = target[prop]
          return typeof v === 'function' ? v.bind(target) : v
        },
      })
      try { return await fn(proxied) } finally { inTx = false }
    }, opts)
    if (killAt === 'after-commit') await freeze(killAt)
    return result
  }
  const { CommitmentPairService } = require('../../src/modules/open-p2p/commitment-pair.service')
  const svc = new CommitmentPairService({ enabledRails: () => new Set(JSON.parse(process.env.ENABLED_RAILS ?? '["MULTISIG"]')) })
  try {
    const view = await svc.signPair(input)
    writeFileSync(path.join(syncDir, 'result'), JSON.stringify({ ok: true, view, afterTxEnvelopeRead }))
  } catch (err) {
    writeFileSync(path.join(syncDir, 'result'), JSON.stringify({ ok: false, code: (err as { code?: string }).code ?? String(err), afterTxEnvelopeRead }))
  }
  process.exit(0)
}

main().catch((err) => { process.stderr.write(`WORKER_ERROR ${err instanceof Error ? err.message : String(err)}\n`); process.exit(2) })
