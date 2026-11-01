/**
 * scripts/wdk-lane.ts — #235 R7G-F6B-P1 operator tooling for WDK treasury nonce lanes
 * (WDK_LANE_RESUME_AUTHORITY_V1). Offline operator CLI, same trust boundary as
 * scripts/publish-economic-policy.ts: running it requires shell + DATABASE_URL access; there is no HTTP
 * surface and no authenticated operator identity in this codebase, so --operator is a declared label,
 * recorded verbatim in the append-only lane audit.
 *
 * Usage:
 *   npm run wdk:lane -- status    --chain-id <id> --account <0x…>
 *   npm run wdk:lane -- pause     --chain-id <id> --account <0x…> --operator <label> [--detail <text>] --confirm
 *   npm run wdk:lane -- unpause   --chain-id <id> --account <0x…> --operator <label> --confirm
 *   npm run wdk:lane -- resume    --chain-id <id> --account <0x…> --operator <label> --confirm
 *   npm run wdk:lane -- reconcile [--escrow <id>]
 *   npm run wdk:lane -- outbound  --escrow <id>
 *
 * status is read-only. pause raises an OPERATOR_PAUSE; unpause removes only that, and only while no
 * economic halt is active. resume clears economic halts only on mechanical proof (wdk-lane-governance.ts)
 * and realigns the lane forward to the corroborated final nonce in the same transaction. reconcile runs the
 * LOCK reconciliation pass: the same signed bytes are rebroadcast and checked, nothing is ever signed; with
 * --escrow it drives that escrow's signed outbound obligation (#235 R7G-F6C) instead - the same bytes, a leg
 * signed only if it was only prepared, never a second transaction for a signed leg. outbound is read-only: the
 * obligation's legs, their gas funding and the escrow account's lane.
 * There is deliberately no force option, no nonce setter and no command that writes a terminal state, changes a
 * recipient or an amount, or re-signs.
 */
import { config } from '../src/config'
import { laneStatus, pauseLane, resumeLane, unpauseLane } from '../src/modules/open-settlement/wdk-lane-governance'
import { reconcileWdkLocks, type LockReconcileReport } from '../src/modules/open-settlement/wdk-lock-authority'
import { reconcileWdkOutboundEscrow } from '../src/modules/open-settlement/escrow-settlement-reconciliation.service'
import { prisma } from '../src/common/database'

const COMMANDS = ['status', 'pause', 'unpause', 'resume', 'reconcile', 'outbound'] as const
const FLAGS: Record<(typeof COMMANDS)[number], readonly string[]> = {
  status: ['chain-id', 'account'],
  pause: ['chain-id', 'account', 'operator', 'detail', 'confirm'],
  unpause: ['chain-id', 'account', 'operator', 'confirm'],
  resume: ['chain-id', 'account', 'operator', 'confirm'],
  reconcile: ['escrow'],
  outbound: ['escrow'],
}

// Never echo a raw connection string — it may carry a real password.
function redactedTarget(): string {
  try {
    const u = new URL(config.database.url)
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`
  } catch {
    return '<DATABASE_URL could not be parsed>'
  }
}

function fail(message: string): never {
  console.error(`REFUSED: ${message}`)
  process.exit(1)
}

export function parseLaneArgs(argv: string[]) {
  const [command, ...rest] = argv
  if (!COMMANDS.includes(command as (typeof COMMANDS)[number])) fail(`command must be one of ${COMMANDS.join(', ')} (got ${JSON.stringify(command)})`)
  const cmd = command as (typeof COMMANDS)[number]
  const args: Record<string, string | true> = {}
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (!token.startsWith('--')) fail(`unexpected argument ${JSON.stringify(token)}`)
    const key = token.slice(2)
    if (!FLAGS[cmd].includes(key)) fail(`--${key} is not an option of ${cmd} (options: ${FLAGS[cmd].map((f) => `--${f}`).join(' ') || 'none'})`)
    if (key in args) fail(`--${key} given twice`)
    const next = rest[i + 1]
    if (key === 'confirm') args[key] = true
    else if (next === undefined || next.startsWith('--')) fail(`--${key} needs a value`)
    else { args[key] = next; i++ }
  }
  const chainId = args['chain-id']
  if (cmd === 'outbound' && typeof args.escrow !== 'string') fail('--escrow <id> is required')
  if (args.escrow !== undefined && !/^[0-9a-f-]{36}$/i.test(String(args.escrow))) fail(`--escrow must be an escrow id (got ${JSON.stringify(args.escrow)})`)
  const laneScoped = cmd !== 'reconcile' && cmd !== 'outbound'
  if (laneScoped && (typeof chainId !== 'string' || !/^[1-9][0-9]{0,9}$/.test(chainId))) fail('--chain-id <positive integer> is required')
  if (laneScoped && typeof args.account !== 'string') fail('--account <0x address> is required')
  if (cmd === 'pause' || cmd === 'unpause' || cmd === 'resume') {
    if (typeof args.operator !== 'string' || args.operator.trim() === '') fail('--operator <label> is required: every lane action is audited')
    if (args.confirm !== true) fail(`${cmd} changes whether the treasury lane may sign; re-run with --confirm to proceed`)
  }
  return {
    command: cmd,
    chainId: typeof chainId === 'string' ? Number(chainId) : undefined,
    account: args.account as string | undefined,
    operator: args.operator as string | undefined,
    detail: typeof args.detail === 'string' ? args.detail : '',
    escrow: args.escrow as string | undefined,
  }
}

const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)

async function main(): Promise<void> {
  const a = parseLaneArgs(process.argv.slice(2))
  console.log(`Sails Protocol — WDK treasury lane ${a.command} (#235 R7G-F6B-P1); target database: ${redactedTarget()}`)
  switch (a.command) {
    case 'status':
      console.log(json(await laneStatus(a.chainId!, a.account!)))
      return
    case 'pause':
      console.log(json({ paused: await pauseLane(a.chainId!, a.account!, a.operator!, a.detail) }))
      break
    case 'unpause':
      await unpauseLane(a.chainId!, a.account!, a.operator!)
      console.log(json({ unpaused: true }))
      break
    case 'resume': {
      const result = await resumeLane(a.chainId!, a.account!, a.operator!)
      console.log(json(result))
      if (!result.resumed) process.exitCode = 1
      break
    }
    case 'reconcile': {
      if (a.escrow) {
        console.log(json(await reconcileWdkOutboundEscrow(a.escrow)))
        return
      }
      const report: LockReconcileReport = { requiresManualReview: [], failed: [], locksAdvanced: [] }
      await reconcileWdkLocks(report)
      console.log(json(report))
      return
    }
    case 'outbound': {
      const escrow = await prisma.escrow.findUnique({ where: { id: a.escrow }, select: { id: true, type: true, status: true, txReleaseId: true, multisigAddr: true } })
      if (!escrow) fail(`no escrow ${a.escrow}`)
      const attempts = await prisma.wdkTransferAttempt.findMany({
        where: { escrowId: a.escrow, authority: 'SIGNED_RAW_V1', operationType: { not: 'LOCK' } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, operationType: true, status: true, fromAddress: true, destination: true, amount: true, valueWei: true, fundsAttemptId: true,
          nonce: true, txHash: true, signedAtBlock: true, receiptBlockNumber: true, finalizedAt: true, primarySource: true, corroboratingSource: true, updatedAt: true,
        },
      })
      const lane = escrow!.multisigAddr && escrow!.type === 'WDK_USDT_EVM' && config.wdk.chainId ? await laneStatus(config.wdk.chainId, escrow!.multisigAddr).catch(() => null) : null
      console.log(json({ escrow, attempts, escrowAccountLane: lane }))
      return
    }
  }
  console.log(json(await laneStatus(a.chainId!, a.account!)))
}

if (require.main === module) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
      console.error('FAILED:', err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
