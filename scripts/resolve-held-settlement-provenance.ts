/**
 * scripts/resolve-held-settlement-provenance.ts — lists settlements whose reputation outcomes are held for
 * missing provenance, and records a human decision on one. Same trust boundary and no-HTTP-surface reasoning
 * as scripts/publish-economic-policy.ts: shell + DATABASE_URL access to the target environment.
 *
 * With no arguments it only lists. A decision needs --apply, and never classifies anything by itself: the
 * operator states the decision and the evidence, which are published durably before any effect is applied.
 * Re-running the same decision after a crash finishes the work; a different decision is refused.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/resolve-held-settlement-provenance.ts
 *   npx ts-node --transpile-only scripts/resolve-held-settlement-provenance.ts --effect <id> \
 *     --decision DISPUTED|COOPERATIVE --decided-by <name> --evidence <text> --apply
 */
import { prisma } from '../src/common/database'
import { listHeldSettlementProvenance } from '../src/common/events/event-projection'
import { resolveHeldSettlementProvenance } from '../src/common/events/settlement-provenance'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main(): Promise<void> {
  const effectId = arg('effect')
  if (!effectId) {
    console.log(JSON.stringify(await listHeldSettlementProvenance(), null, 2))
    return
  }

  const decision = arg('decision')
  const decidedBy = arg('decided-by') ?? ''
  const evidence = arg('evidence') ?? ''
  if (decision !== 'DISPUTED' && decision !== 'COOPERATIVE') throw new Error('--decision must be DISPUTED or COOPERATIVE')
  if (!process.argv.includes('--apply')) {
    console.log(`Dry run: ${effectId} would be decided ${decision}. Nothing was written. Add --apply to record it.`)
    return
  }
  await resolveHeldSettlementProvenance({ effectId, decision, decidedBy, evidence })
  console.log(`Recorded: ${effectId} decided ${decision} by ${decidedBy}.`)
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect().finally(() => process.exit()))
