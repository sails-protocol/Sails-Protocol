/**
 * Opt-in candidate for Artillery's 1 arrival/s, 2s HTTP comparator.\n * k6 deliberately uses a 1999ms window, so temporal parity is NOT established.
 * This is a rate-SHAPE candidate only, not throughput or latency parity proof:
 * the tiny schedule can drop a boundary arrival, and Artillery measures only the two
 * in-engine Intent HTTP operations while k6 also measures eight auth calls (12 HTTP requests total).
 * Run only on a disposable loopback backend with a fresh auth-rate-limit window.
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
    intent_rate_candidate: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '1s',
      duration: '1999ms',
      // A 1999ms window avoids an intentional 2s boundary tick, but it does
      // not guarantee exactly two scheduled iterations: a third has occurred
      // in CI. This is a rate-shape experiment, not scheduler equivalence.
      // Never infer a fixed arrival count from duration alone.
      // An extra iteration is still possible; if observed, reject it\n      // before authentication and fail the candidate.
      // This bounds side effects, but cannot make a 3-arrival schedule equal 2.
      preAllocatedVUs: 2,
      maxVUs: 2,
      gracefulStop: '10s',
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
export default function () {
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
  if (exec.scenario.iterationInTest >= 2) {
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
