/**
 * Isolated k6 scheduler diagnostic. No network, auth, or Intent I/O.
 * Explicitly opt in: k6 run load-tests/tests/arrival-scheduler-probe.js
 * Alternate diagnostics: k6 run -e SAILS_SCHEDULER_PROBE_DURATION=1900ms load-tests/tests/arrival-scheduler-probe.js
 * and 1500ms; neither is claimed equivalent to Artillery's 2s window.
 * The 2s control tests the exact comparator duration; it is expected to
 * expose the third boundary arrival and is diagnostic only.
 * The 1999ms constant-arrival-rate window is experimental. On 2026-10-23,
 * isolated CI trials observed four third arrivals across 24 attempts at 1999ms;
 * 1900ms and 1500ms each had 0/24 failures in that same run. These are
 * observations, not a parity or reliability guarantee. Never infer parity.
 */
import { Counter, Trend } from 'k6/metrics'
import exec from 'k6/execution'

const entries = new Counter('sails_probe_entries')
const extras = new Counter('sails_probe_extra_entries')
const timestamps = new Trend('sails_probe_entry_epoch_ms')
const timestampSamples = new Counter('sails_probe_timestamp_samples')

const probeDuration = __ENV.SAILS_SCHEDULER_PROBE_DURATION || '1999ms'
if (!['1999ms', '1900ms', '1500ms', '2s'].includes(probeDuration)) {
  throw new Error('Unsupported scheduler probe duration')
}

export const options = {
  scenarios: {
    isolated_scheduler: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '1s',
      duration: probeDuration,
      preAllocatedVUs: 2,
      maxVUs: 2,
      gracefulStop: '10s',
    },
  },
  thresholds: {
    sails_probe_entries: ['count==2'],
    sails_probe_extra_entries: ['count==0'],
    sails_probe_timestamp_samples: ['count==2'],
    dropped_iterations: ['count==0'],
  },
}

export default function () {
  entries.add(1)
  timestamps.add(Date.now())
  timestampSamples.add(1)
  // Scenario-wide index, not per-VU __ITER.
  extras.add(exec.scenario.iterationInTest >= 2 ? 1 : 0)
}
