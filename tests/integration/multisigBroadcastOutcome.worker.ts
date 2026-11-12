// tests/integration/multisigBroadcastOutcome.worker.ts
//
// Issue #299 - one independent OS process, spawned by multisigBroadcastOutcome.test.ts, sharing only PostgreSQL.
//   OP=sign       the final submitTransactionSignature(ESCROW_ID, ACTOR, SIGNED_PSBT); CRASH=before kills the process
//                 (exit 137) when it reaches POST /tx, CRASH=after once the network took the transaction (written to
//                 ACCEPTED_FILE so the parent's explorer knows it).
//   OP=reconcile  one reconcilePendingSettlements() tick (the restart).
// The last stdout line is the JSON result.
import fs from 'fs'
import * as bitcoin from 'bitcoinjs-lib'
import { chainFromJson, explorer } from './pendingRoundLifecycleHarness'

async function main(): Promise<unknown> {
  const chain = chainFromJson(process.env.CHAIN ?? '{}')
  const base = explorer(chain)
  global.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST' && String(input).endsWith('/tx')) {
      if (process.env.CRASH === 'before') process.exit(137)
      if (process.env.CRASH === 'after') {
        const txid = bitcoin.Transaction.fromHex(init.body as string).getId()
        fs.writeFileSync(process.env.ACCEPTED_FILE as string, JSON.stringify({ txid, hex: init.body }))
        process.exit(137)
      }
      const txid = bitcoin.Transaction.fromHex(init.body as string).getId()
      chain.mempool.add(txid)
      chain.broadcasts.push(txid)
    }
    return base(input as string, init as RequestInit)
  }) as typeof fetch

  const id = process.env.ESCROW_ID as string
  if (process.env.OP === 'sign') {
    const { escrowService } = require('../../src/modules/open-settlement/escrow.service')
    const result = await escrowService.submitTransactionSignature(id, process.env.ACTOR, process.env.SIGNED_PSBT)
    return { complete: result.complete }
  }
  if (process.env.OP === 'reconcile') {
    // Test harness only: the external-spend watch pages the shared database; narrowed to the escrow under test.
    const db = require('../../src/common/database').prisma
    const findMany = db.escrow.findMany.bind(db.escrow)
    db.escrow.findMany = (args: any) =>
      findMany(args?.where?.OR?.[0]?.pendingTransaction ? { ...args, where: { ...args.where, AND: [{ id: { in: [id] } }] } } : args)
    const { reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
    const report = await reconcilePendingSettlements({ externalSpendMinIntervalMs: Number.POSITIVE_INFINITY })
    return {
      recovered: report.recovered.filter((x: { escrowId: string }) => x.escrowId === id).map(({ txId, outcome }: { txId: string; outcome: string }) => ({ txId, outcome })),
      failed: report.failed.filter((x: { escrowId: string }) => x.escrowId === id),
    }
  }
  throw new Error(`unknown OP ${process.env.OP}`)
}

main().then(
  async (value) => { process.stdout.write('\n' + JSON.stringify({ ok: true, value }) + '\n'); await shutdown() },
  async (err: Error) => { process.stdout.write('\n' + JSON.stringify({ ok: false, error: err.message }) + '\n'); await shutdown() },
)

async function shutdown() {
  try {
    await require('../../src/common/database').prisma.$disconnect()
  } catch { /* already gone */ }
  process.exit(0)
}
