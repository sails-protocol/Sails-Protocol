/**
 * Opt-in candidate for the Artillery HTTP comparator's 1 arrival/s, 2s window.
 * This is a rate-SHAPE candidate only, not throughput or latency parity proof:
 * the tiny schedule can drop arrivals, and Artillery measures only the two
 * in-engine Intent HTTP operations while k6 also measures four auth calls.
 * Run only on a disposable loopback backend with a fresh auth-rate-limit window.
 */
import { Counter } from 'k6/metrics'
import { BASE_URL, baseOptions } from '../k6.config.js'
import { generateTestUser } from '../utils/data-generator.js'
import { run } from './intent-creation.js'

if (!/^http:\\/\\/(?:localhost|127\\.0\\.0\\.1)(?::\\d+)?\\/?$/.test(BASE_URL)) {
  throw new Error('Intent rate candidate requires loopback HTTP target')
}
const authenticated = new Counter('sails_authenticated_arrivals')
const completed = new Counter('sails_completed_intent_pairs')
const createSamples = new Counter('sails_intent_create_samples')
const cancelSamples = new Counter('sails_intent_cancel_samples')
export const options = {
  ...baseOptions,
  scenarios: {
    intent_rate_candidate: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '1s',
      duration: '2s',
      preAllocatedVUs: 2,
      maxVUs: 2,
      gracefulStop: '10s',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    sails_intent_success: ['rate==1'],
    http_req_failed: ['rate==0'],
    dropped_iterations: ['count==0'],
  },
}
export default function () {
  const user = generateTestUser(BASE_URL, 'rate-candidate')
  if (!user?.sessionToken) throw new Error('Rate candidate authentication failed')
  authenticated.add(1)
  run(user, {
    type: 'TradeIntent',
    payload: { asset: 'BTC', side: 'BUY', maxValue: '100', currency: 'USD' },
  }, { onCreateDurationSample: () => createSamples.add(1), onCancelDurationSample: () => cancelSamples.add(1) })
  completed.add(1)
}
