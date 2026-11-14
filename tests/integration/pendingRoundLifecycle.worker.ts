// tests/integration/pendingRoundLifecycle.worker.ts
//
// Issue #239 (T12) - one independent OS process running ONE production entry point against the shared PostgreSQL,
// spawned by pendingRoundLifecycleProcesses.test.ts. It shares nothing with its sibling but the database. The
// explorer is the same deterministic stub the in-process suite uses, handed over as JSON (CHAIN).
//   OP=cancel     cancelPendingSignatureRound(ESCROW_ID, PENDING_ID, ACTOR)
//   OP=sign       submitTransactionSignature(ESCROW_ID, ACTOR, SIGNED_PSBT)
//   OP=reconcile  reconcilePendingSettlements()
// The last stdout line is the JSON result: { ok, value } or { ok: false, error }.
import { chainFromJson, explorer } from './pendingRoundLifecycleHarness'

async function main(): Promise<unknown> {
  global.fetch = explorer(chainFromJson(process.env.CHAIN ?? '{}'))
  const op = process.env.OP
  if (op === 'cancel') {
    const { escrowService } = require('../../src/modules/open-settlement/escrow.service')
    const { asTrustedActor } = require('../../src/modules/open-settlement/escrow-lifecycle')
    return escrowService.cancelPendingSignatureRound(process.env.ESCROW_ID, process.env.PENDING_ID, asTrustedActor(process.env.ACTOR))
  }
  if (op === 'sign') {
    const { escrowService } = require('../../src/modules/open-settlement/escrow.service')
    const result = await escrowService.submitTransactionSignature(process.env.ESCROW_ID, process.env.ACTOR, process.env.SIGNED_PSBT)
    return { complete: result.complete }
  }
  if (op === 'reconcile') {
    // Test harness only, this process only: the external-spend watch pages every MULTISIG escrow of the shared
    // database; narrowed to the escrow under test so its convergence never depends on where its id falls.
    const db = require('../../src/common/database').prisma
    const findMany = db.escrow.findMany.bind(db.escrow)
    db.escrow.findMany = (args: any) =>
      findMany(args?.where?.OR?.[0]?.pendingTransaction ? { ...args, where: { ...args.where, AND: [{ id: { in: [process.env.ESCROW_ID] } }] } } : args)
    const { reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
    const report = await reconcilePendingSettlements()
    const id = process.env.ESCROW_ID
    return {
      externallyCompleted: report.externallyCompleted.filter((x: { escrowId: string }) => x.escrowId === id).length,
      alreadyClaimedConcurrently: report.alreadyClaimedConcurrently.filter((x: string) => x === id).length,
      failed: report.failed.filter((x: { escrowId: string }) => x.escrowId === id),
    }
  }
  throw new Error(`unknown OP ${op}`)
}

main().then(
  async (value) => { process.stdout.write('\n' + JSON.stringify({ ok: true, value }) + '\n'); await shutdown(0) },
  async (err: Error) => { process.stdout.write('\n' + JSON.stringify({ ok: false, error: err.message }) + '\n'); await shutdown(0) },
)

async function shutdown(code: number) {
  try {
    await require('../../src/common/database').prisma.$disconnect()
  } catch { /* already gone */ }
  process.exit(code)
}
