/**
 * Diagnostic alternative: exactly two closed-model iterations, no HTTP I/O.
 * This avoids duration-boundary over-scheduling but is NOT an open arrival-rate
 * executor and cannot establish Artillery arrival-model parity.
 * Never promote it to the Intent candidate without an explicit parity review.
 * On 2026-10-23, two CI candidate jobs recorded 24/24 successful isolated
 * trials, with exactly two iterations, no extras or drops, and observed entry
 * spans of 1000-1001ms. This zero-I/O result cannot be extrapolated to
 * latency-bearing Intent operations or an open arrival-rate schedule.
 */
import { Counter, Trend } from 'k6/metrics'
import exec from 'k6/execution'
import { sleep } from 'k6'

const entries = new Counter('sails_fixed_entries')
const extras = new Counter('sails_fixed_extras')
const timestamps = new Trend('sails_fixed_entry_epoch_ms')

export const options = {
  scenarios: {
    fixed_two: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 2,
      maxDuration: '10s',
    },
  },
  thresholds: {
    sails_fixed_entries: ['count==2'],
    sails_fixed_extras: ['count==0'],
    dropped_iterations: ['count==0'],
  },
}

export default function () {
  const iteration = exec.scenario.iterationInTest
  // With one VU, this produces an observed ~1s gap in the zero-I/O probe.
  // Real work would add to the gap: closed-model scheduling is not parity.
  timestamps.add(Date.now())
  entries.add(1)
  extras.add(iteration >= 2 ? 1 : 0)
  if (iteration === 0) sleep(1)
}
