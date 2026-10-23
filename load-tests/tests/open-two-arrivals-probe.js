/**
 * Zero-I/O diagnostic: two independent one-shot VUs offset by 1s.
 * Unlike shared-iterations, the second VU's start is not paced by work in
 * the first. This is an experimental schedule, NOT Artillery parity.
 * The fixed offset is an observed-start target, not a scheduled-time proof.
 * CI 2026-10-23: 32/32 trials across two candidate jobs passed, including
 * 16 trials with 250ms work on the first VU; observed spans 1000-1001ms
 * in both conditions. These are entry timestamps, not engine schedule times,
 * and do not establish HTTP, latency, or Artillery parity.
 */
import { Counter, Trend } from 'k6/metrics'
import { sleep } from 'k6'
import exec from 'k6/execution'

const entries = new Counter('sails_open_two_entries')
const extras = new Counter('sails_open_two_extras')
const timestamps = new Trend('sails_open_two_entry_epoch_ms')
const workMs = Number(__ENV.SAILS_OPEN_TWO_WORK_MS || '0')
if (![0, 250].includes(workMs)) throw new Error('Unsupported synthetic work duration')

export const options = {
  scenarios: {
    first: {
      executor: 'per-vu-iterations', vus: 1, iterations: 1,
      startTime: '0s', maxDuration: '10s', exec: 'arrival',
    },
    second: {
      executor: 'per-vu-iterations', vus: 1, iterations: 1,
      startTime: '1s', maxDuration: '10s', exec: 'arrival',
    },
  },
  thresholds: {
    sails_open_two_entries: ['count==2'],
    sails_open_two_extras: ['count==0'],
    dropped_iterations: ['count==0'],
  },
}

export function arrival() {
  entries.add(1)
  timestamps.add(Date.now())
  extras.add(exec.scenario.iterationInTest >= 1 ? 1 : 0)
  if (exec.scenario.name === 'first' && workMs) sleep(workMs / 1000)
}
