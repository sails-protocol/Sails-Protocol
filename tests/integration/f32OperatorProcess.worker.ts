// tests/integration/f32OperatorProcess.worker.ts
//
// F32 characterization: one "operator" OS process. It commits a dispute ruling through the production entry point
// (resolveDispute), prints READY, then stays alive doing nothing until the test SIGKILLs it. It shares nothing with the
// test process but the PostgreSQL database. The explorer is the same deterministic stub, handed over as JSON (CHAIN).
import { chainFromJson, explorer } from './pendingRoundLifecycleHarness'

async function main(): Promise<void> {
  global.fetch = explorer(chainFromJson(process.env.CHAIN ?? '{}'))
  const { getDisputeService } = require('../../src/modules/open-settlement/dispute.service')
  const bps = process.env.BUYER_BPS ? Number(process.env.BUYER_BPS) : undefined
  await getDisputeService().resolveDispute(
    process.env.DISPUTE_ID, process.env.ARBITER_ID, process.env.OUTCOME, undefined, undefined, bps, process.env.SIGNATURE, process.env.ISSUED_AT,
  )
  process.stdout.write('\nREADY\n')
  setInterval(() => undefined, 1000) // the operator stays "up" until it is killed
}

main().catch((err: Error) => {
  process.stdout.write('\n' + JSON.stringify({ ok: false, error: err.message }) + '\n')
  process.exit(1)
})
