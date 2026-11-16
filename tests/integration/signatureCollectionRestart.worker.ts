// tests/integration/signatureCollectionRestart.worker.ts
//
// #341 requirement 3: one OS process of the Sails server, spawned by disputedDispositionProductionPath.test.ts.
// It shares nothing with the test or its siblings but PostgreSQL.
//
// ROLE=finalize  submits the last signature of a disputed LIGHTNING_HODL/SAFE_GUARD_EVM pending operation through
//                escrowService.submitTransactionSignature() and dies by SIGKILL at KILL_AT:
//                  after-effect    the provider's finalize*() returned (the external effect happened), before
//                                  anything else is recorded: on entry to recordObligationForEscrowSettlement()
//                  before-publish  on entry to the settlement.escrow.* publication
// ROLE=recover   a fresh process: runs the production reconciler until the escrow's settlement transition (the one
//                into TO_STATUS) is projected. Only that one: the escrow's earlier DISPUTED transition is projected
//                too, and much sooner, so waiting on "any transition" exited while the settlement's handlers were
//                still running and left its outcomes unapplied.
//
// Test harness only, in this process only: the provider's finalize*() is the external boundary and returns
// FAKE_TX_ID (no Ark/bundler here); every call is appended to SYNC_DIR/effects.log, so the test can count the
// external effects across processes. The kill point wraps one production function at runtime; nothing is patched on disk.

import { appendFileSync, writeFileSync, writeSync } from 'fs'
import path from 'path'

const role = process.env.ROLE
const syncDir = process.env.SYNC_DIR!
const escrowId = process.env.ESCROW_ID!
const stderr = (line: string) => writeSync(2, line + '\n')

// Windows reports a self-SIGKILL as a plain exit code, so the kill is proven by this marker, written synchronously.
function die(point: string): never {
  writeFileSync(path.join(syncDir, `${role}.killed.json`), JSON.stringify({ pid: process.pid, point, at: Date.now() }))
  stderr('SIGKILL_MARKER')
  process.kill(process.pid, 'SIGKILL')
  throw new Error('unreachable')
}

async function main(): Promise<void> {
  const { prisma } = require('../../src/common/database')
  const { eventBus } = require('../../src/common/events/event-bus')
  const { intentEngine } = require('../../src/core/intent-engine')
  const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
  intentEngine.registerHandler(OpenP2PTradeIntentHandler)
  require('../../src/common/events/handlers').registerEventHandlers()
  const { escrowService } = require('../../src/modules/open-settlement/escrow.service')
  const { feeObligationService } = require('../../src/modules/open-settlement/fee-obligation.service')
  const { reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')

  for (const provider of [
    require('../../src/modules/open-settlement/lightning-hodl.provider').lightningHodlProvider,
    require('../../src/modules/open-settlement/safe-guard-evm.provider').safeGuardEvmProvider,
  ]) {
    for (const method of ['finalizeRelease', 'finalizeRefund']) {
      provider[method] = async (_escrow: unknown, unsigned: string) => {
        appendFileSync(path.join(syncDir, 'effects.log'), JSON.stringify({ role, pid: process.pid, method, unsigned }) + '\n')
        return { txId: process.env.FAKE_TX_ID }
      }
    }
  }

  if (role === 'finalize') {
    if (process.env.KILL_AT === 'after-effect') {
      feeObligationService.recordObligationForEscrowSettlement = async () => die('after-effect')
    } else if (process.env.KILL_AT === 'before-publish') {
      const realEmit = eventBus.emit.bind(eventBus)
      eventBus.emit = async (name: string, ...rest: unknown[]) => (name.startsWith('settlement.escrow.') ? die('before-publish') : realEmit(name, ...rest))
    } else {
      throw new Error(`unknown KILL_AT ${process.env.KILL_AT}`)
    }
    await escrowService.submitTransactionSignature(escrowId, process.env.SIGNER_ID, 'signed-bundle')
    stderr('KILL_POINT_NOT_REACHED')
    process.exit(2)
  }

  if (role === 'recover') {
    const toStatus = process.env.TO_STATUS
    if (toStatus !== 'COMPLETED' && toStatus !== 'REFUNDED') throw new Error(`TO_STATUS must be COMPLETED or REFUNDED, got ${toStatus}`)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      await reconcilePendingSettlements({ projectionGraceMs: 0 })
      const projected = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM event_projection_claims p JOIN escrow_events e ON p."subjectId" = e.id
        WHERE p."projectionKey" = 'transition.projected' AND e."escrowId" = ${escrowId} AND e."toStatus"::text = ${toStatus}`
      if (Number(projected[0].n) > 0) { process.stdout.write('CONVERGED\n'); process.exit(0) }
      await new Promise((r) => setTimeout(r, 200))
    }
    stderr('deadline reached before convergence')
    process.exit(3)
  }
  throw new Error(`unknown ROLE ${role}`)
}

main().catch((err) => { stderr(String(err?.stack ?? err)); process.exit(1) })
