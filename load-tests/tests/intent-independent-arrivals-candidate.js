/**
 * Opt-in experimental Intent candidate with two independently offset
 * one-shot scenarios at 0s and 1s. Run ONLY on a disposable loopback
 * backend with fresh auth-rate-limit capacity. NOT Artillery parity:
 * auth adds requests, and entry times are not scheduled arrival timestamps.
 * This file is not wired into CI until a separately isolated real-backend
 * validation step is reviewed.
 */
import { Counter, Trend } from 'k6/metrics'
import exec from 'k6/execution'
import { BASE_URL, baseOptions } from '../k6.config.js'
import { generateTestUser } from '../utils/data-generator.js'
import { run } from './intent-creation.js'

if (!/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?$/.test(BASE_URL)) {
  throw new Error('Intent rate candidate requires loopback HTTP target')
}
const observedSetupEpochMs = new Trend('sails_observed_setup_start_epoch_ms')
const observedSetupSamples = new Counter('sails_observed_setup_timestamp_samples')
const authenticated = new Counter('sails_authenticated_arrivals')
const completed = new Counter('sails_completed_intent_pairs')
const createSamples = new Counter('sails_intent_create_samples')
const cancelSamples = new Counter('sails_intent_cancel_samples')
const extraScheduledArrivals = new Counter('sails_extra_scheduled_arrivals')
export const options = {
  ...baseOptions,
  scenarios: {
    first: {
      executor: 'per-vu-iterations', vus: 1, iterations: 1,
      startTime: '0s', maxDuration: '30s', exec: 'intentArrival',
    },
    second: {
      executor: 'per-vu-iterations', vus: 1, iterations: 1,
      startTime: '1s', maxDuration: '30s', exec: 'intentArrival',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    sails_intent_success: ['rate==1'],
    // Reject any run with a different observed count. The tiny rate window
    // does NOT guarantee two arrivals; failed runs are non-comparable.
    sails_authenticated_arrivals: ['count==2'],
    sails_completed_intent_pairs: ['count==2'],
    sails_intent_create_samples: ['count==2'],
    sails_intent_cancel_samples: ['count==2'],
    // Scope the HTTP operation count to the two measured Intent endpoints.
    // Auth requests remain separately counted in global http_reqs and must
    // never be compared against Artillery's in-engine four-request total.
    'http_reqs{name:intent_create}': ['count==2'],
    'http_reqs{name:intent_cancel}': ['count==2'],
    // A boundary arrival is a real scheduling mismatch, not an auth failure.
    sails_extra_scheduled_arrivals: ['count==0'],
    http_req_failed: ['rate==0'],
    dropped_iterations: ['count==0'],
  },
}
export function intentArrival() {
  // Emit a zero sample on every invocation so the zero-excess threshold
  // remains evaluable even when no boundary arrival occurs.
  extraScheduledArrivals.add(0)
  // Observed k6 iteration entry, not the executor's scheduled arrival timestamp.
  // Include boundary extras so a rejected third arrival cannot disappear from timing evidence.
  observedSetupEpochMs.add(Date.now())
  observedSetupSamples.add(1)
  // Preserve strict fail-closed accounting. An unexpected third iteration
  // must not consume four additional auth requests or mutate intents.
  // __ITER is per-VU, so two VUs can both report iteration 0.
  // The scenario-wide iteration index is the only valid bound here.
  if (exec.scenario.iterationInTest >= 1) {
    // Record the extra scheduled iteration without performing any auth or Intent I/O.
    // The strict threshold above keeps this candidate RED and non-comparable.
    extraScheduledArrivals.add(1)
    return
  }
  const user = generateTestUser(BASE_URL, 'rate-candidate')
  if (!user?.sessionToken) throw new Error('Rate candidate authentication failed')
  authenticated.add(1)
  run(user, {
    type: 'TradeIntent',
    payload: { asset: 'BTC', side: 'BUY', maxValue: '100', currency: 'USD' },
  }, { onCreateDurationSample: () => createSamples.add(1), onCancelDurationSample: () => cancelSamples.add(1) })
  completed.add(1)
}
