/**
 * Opt-in loopback-only authenticated Intent arrival probe.
 * Mirrors Artillery comparator's fixture accounting: each arrival provisions
 * a fresh PoP-registered, challenge-authenticated identity before create/cancel.
 * Tiny rate by design. No production targets, auth bypass, or limit changes.
 * NOT throughput parity without identical runs, measurement and assertions.
 */
import { BASE_URL, baseOptions } from '../k6.config.js'
import { generateTestUser } from '../utils/data-generator.js'
import { run } from './intent-creation.js'

if (!/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?$/.test(BASE_URL)) {
  throw new Error('Intent arrival probe requires loopback HTTP target')
}
export const options = {
  ...baseOptions,
  scenarios: {
    intent_probe: {
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
  })
}
