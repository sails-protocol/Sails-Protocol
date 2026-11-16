// A separate OS process for the C4 restart proof: it loads the recovery module from scratch (no state from the test process),
// claims one chunk without attempting it (the clock expires right after the claim), prints the report and exits.
async function main() {
  const { reconcileMissingDispatch } = require('../../../src/modules/open-settlement/dispute-dispatch-recovery')
  const { prisma } = require('../../../src/common/database')
  let n = 0
  const report = await reconcileMissingDispatch({ maxCandidates: Number(process.env.C4_MAX), budgetMs: 60_000, now: () => (n++ < 2 ? 0 : 1e9) })
  process.stdout.write(`C4_CHILD ${JSON.stringify(report.budget)}\n`)
  await prisma.$disconnect()
}
main().then(() => process.exit(0), (err) => { process.stderr.write(`C4_CHILD_ERROR ${err instanceof Error ? err.stack : err}\n`); process.exit(1) })
