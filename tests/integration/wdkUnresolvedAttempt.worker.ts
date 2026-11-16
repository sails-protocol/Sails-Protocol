// tests/integration/wdkUnresolvedAttempt.worker.ts
//
// D7 (#341): one OS process of the Sails server, spawned by wdkUnresolvedAttemptGuard.test.ts. It shares nothing with
// the test but PostgreSQL.
//
// ROLE=settle   DisputeService.applyRuling(RELEASE) on a disputed WDK_USDT_EVM escrow; dies by SIGKILL at KILL_AT:
//                 in-transfer  inside the wallet's transfer(), i.e. after the attempt was pre-committed UNKNOWN
//                 after-hash   on the first receipt query, i.e. after the attempt was recorded SUBMITTED with its hash
//                 in-revert    transfer() fails, then the process dies inside the rollback decision (its
//                              findPotentiallySent() read, made in a transaction for the ruling's own operations)
//                 after-escrow-revert (D9) right after the transaction that reopened the escrow commits
//               RULING picks the ruling (default RELEASE); FAIL_BEFORE_ATTEMPT makes the provider fail before any attempt.
// ROLE=recover  a fresh process: runs the production reconciler, then tries the other disposition (REFUND) through
//               the ruling path and directly (RECOVER_ONLY skips that). RECEIPT=confirmed makes the wallet report the
//               hash mined.
//
// Test harness only, in this process only: the wallet is a fake (every transfer() is appended to SYNC_DIR/effects.log,
// so the test counts external effects across processes), and lockedAmount is handed to the provider as the decimal
// string it expects (see the test file's header). Kill points wrap production functions at runtime; nothing on disk.

import { appendFileSync, writeFileSync, writeSync } from 'fs'
import path from 'path'

const role = process.env.ROLE!
const syncDir = process.env.SYNC_DIR!
const stderr = (line: string) => writeSync(2, line + '\n')

function die(point: string): never {
  writeFileSync(path.join(syncDir, `${role}.killed.json`), JSON.stringify({ pid: process.pid, point, at: Date.now() }))
  stderr('SIGKILL_MARKER')
  process.kill(process.pid, 'SIGKILL')
  throw new Error('unreachable')
}

const killAt = role === 'settle' ? process.env.KILL_AT : undefined
const account = (address: string) => ({
  getAddress: async () => address,
  transfer: async (args: { recipient: string }) => {
    appendFileSync(path.join(syncDir, 'effects.log'), JSON.stringify({ role, pid: process.pid, recipient: args.recipient }) + '\n')
    if (killAt === 'in-transfer') die('in-transfer')
    if (killAt === 'in-revert') throw new Error('socket hang up: the response was lost')
    return { hash: process.env.FAKE_TX_HASH! }
  },
  getTransactionReceipt: async () => {
    if (killAt === 'after-hash') die('after-hash')
    return process.env.RECEIPT === 'confirmed' ? { status: 1 } : null
  },
})
const treasury = account('treasury-fake-evm-address')
const escrowAcct = account('escrow-fake-evm-address')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module')
const realLoad = Module._load
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === '@tetherto/wdk-wallet-evm') {
    return { __esModule: true, default: class { async getAccount(i: number) { return i === 0 ? treasury : escrowAcct } async getAccountByPath() { return escrowAcct } } }
  }
  return realLoad.call(this, request, ...rest)
}

async function main(): Promise<void> {
  const { prisma } = require('../../src/common/database')
  const { intentEngine } = require('../../src/core/intent-engine')
  const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
  intentEngine.registerHandler(OpenP2PTradeIntentHandler)
  require('../../src/common/events/handlers').registerEventHandlers()
  const { escrowService } = require('../../src/modules/open-settlement/escrow.service')
  const { DisputeService } = require('../../src/modules/open-settlement/dispute.service')
  const { marketArbitrationProvider } = require('../../src/modules/open-settlement/market-arbitration.provider')
  const { reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
  const { wdkSettlementProvider } = require('../../src/modules/open-settlement/wdk-settlement.provider')
  const { wdkTransferAttemptRepository } = require('../../src/modules/open-settlement/wdk-transfer-attempt-repository')
  for (const method of ['releaseFunds', 'refundFunds', 'splitFunds']) {
    const real = wdkSettlementProvider[method].bind(wdkSettlementProvider)
    wdkSettlementProvider[method] = async (escrow: { lockedAmount: unknown }, ...rest: unknown[]) => {
      if (process.env.FAIL_BEFORE_ATTEMPT && role === 'settle') throw new Error('wallet unavailable before any attempt was recorded')
      return real({ ...escrow, lockedAmount: String(escrow.lockedAmount) }, ...rest)
    }
  }

  const escrowId = process.env.ESCROW_ID!
  if (killAt === 'after-escrow-revert') {
    // D9: dies right after the transaction that reopened the escrow commits, before anything else runs.
    const realTransaction = prisma.$transaction.bind(prisma)
    const status = async () => (await prisma.escrow.findUnique({ where: { id: escrowId }, select: { status: true } }))?.status
    prisma.$transaction = async (...args: unknown[]) => {
      const before = await status()
      const out = await realTransaction(...args)
      if (before !== 'DISPUTED' && (await status()) === 'DISPUTED') die('after-escrow-revert')
      return out
    }
  }
  const dispute = await prisma.dispute.findUnique({ where: { id: process.env.DISPUTE_ID! } })
  const arbiter = process.env.ARBITER!
  const service = new DisputeService(marketArbitrationProvider)

  if (role === 'settle') {
    if (killAt === 'in-revert') {
      // The rollback decision's read: in a transaction, for this ruling's own operations.
      const real = wdkTransferAttemptRepository.findPotentiallySent.bind(wdkTransferAttemptRepository)
      const ruling = process.env.RULING ?? 'RELEASE'
      const own = JSON.stringify(ruling === 'SPLIT' ? ['SPLIT_BUYER', 'SPLIT_SELLER'] : [ruling])
      wdkTransferAttemptRepository.findPotentiallySent = (...args: unknown[]) => (args[2] && JSON.stringify(args[1]) === own ? die('in-revert') : real(...args))
    }
    await service.applyRuling(dispute, process.env.RULING ?? 'RELEASE', arbiter).catch((err: unknown) => stderr(`applyRuling rejected: ${String(err)}`))
    stderr('KILL_POINT_NOT_REACHED')
    process.exit(2)
  }

  if (role === 'recover') {
    const reports = []
    for (let i = 0; i < 3; i++) reports.push(await reconcilePendingSettlements({ projectionGraceMs: 0 }))
    if (process.env.RECOVER_ONLY) {
      process.stdout.write('D7_RESULT ' + JSON.stringify({ manualReview: reports.some((r) => r.requiresManualReview.some((m: { escrowId: string }) => m.escrowId === escrowId)) }) + '\n')
      await prisma.$disconnect()
      process.exit(0)
    }
    const refundByRuling = await service.applyRuling(dispute, 'REFUND', arbiter).then(() => 'ACCEPTED', (e: Error) => `REFUSED: ${e.message}`)
    const refundDirect = await escrowService.refundFunds(escrowId, arbiter, dispute.id).then(() => 'ACCEPTED', (e: Error) => `REFUSED: ${e.message}`)
    const manualReview = reports.some((r) => r.requiresManualReview.some((m: { escrowId: string }) => m.escrowId === escrowId))
    // Prefixed: with query logging enabled, Prisma writes to stdout too.
    process.stdout.write('D7_RESULT ' + JSON.stringify({ refundByRuling, refundDirect, manualReview }) + '\n')
    await prisma.$disconnect()
    process.exit(0)
  }
  throw new Error(`unknown ROLE ${role}`)
}

main().catch((err) => { stderr(String(err?.stack ?? err)); process.exit(1) })
