/**
 * Opt-in loopback-only authenticated Intent arrival probe.
 * Mirrors Artillery comparator's fixture accounting: each arrival provisions
 * a fresh PoP-registered, challenge-authenticated identity before create/cancel.
 * Tiny fixed-iteration accounting profile by design. No production targets, auth bypass, or limit changes.
 * NOT throughput parity without identical runs, measurement and assertions.
 */
import { Counter } from 'k6/metrics'
import { BASE_URL, baseOptions } from '../k6.config.js'
import { generateTestUser } from '../utils/data-generator.js'
import { run } from './intent-creation.js'

if (!/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?$/.test(BASE_URL)) {
  throw new Error('Intent arrival probe requires loopback HTTP target')
}
const completedIntentPairs = new Counter('sails_completed_intent_pairs')
// Independent per-operation observation counters are incremented by the
// shared Intent flow exactly when each latency Trend receives a sample.
const intentCreateSamples = new Counter('sails_intent_create_samples')
const intentCancelSamples = new Counter('sails_intent_cancel_samples')

export const options = {
  ...baseOptions,
  scenarios: {
    intent_probe: {
      // A fixed iteration count is deterministic for this tiny comparator.
      // This is an accounting probe, NOT proof of constant arrival-rate parity.
      executor: 'shared-iterations',
      vus: 1,
      iterations: 2,
      maxDuration: '30s',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    sails_intent_success: ['rate==1'],
    sails_completed_intent_pairs: ['count==2'],
    sails_intent_create_samples: ['count==2'],
    sails_intent_cancel_samples: ['count==2'],
    dropped_iterations: ['count==0'],
    http_req_failed: ['rate==0'],
  },
}
export default function () {
  // Match Artillery: authentication belongs to every arrival, not setup().
  const user = generateTestUser(BASE_URL, 'arrival-probe')
  if (!user?.sessionToken) throw new Error('Arrival probe authentication failed')
  run(user, {
    type: 'TradeIntent',
    payload: { asset: 'BTC', side: 'BUY', maxValue: '100', currency: 'USD' },
  }, { onCreateDurationSample: () => intentCreateSamples.add(1), onCancelDurationSample: () => intentCancelSamples.add(1) })
  // Increment only after both create and cancel complete successfully.
  completedIntentPairs.add(1)
}
