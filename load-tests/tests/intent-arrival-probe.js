/**
 * Opt-in, disposable-loopback-only Intent arrival-rate probe.
 * NOT a parity benchmark: Artillery currently provisions auth per arrival,
 * while this k6 probe provisions one shared signed identity in setup().
 * Never run against production or use this probe to justify Artillery removal.
 *
 * Conservative ceiling: two iterations per second for five seconds, one
 * create+cancel per iteration. No bypass of auth/API rate limits.
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
      rate: 2,
      timeUnit: '1s',
      duration: '5s',
      preAllocatedVUs: 2,
      maxVUs: 4,
      gracefulStop: '5s',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    sails_intent_success: ['rate==1'],
    dropped_iterations: ['count==0'],
    sails_rate_limited_429: ['count==0'],
  },
}
export function setup() {
  const user = generateTestUser(BASE_URL, 'arrival-probe')
  if (!user?.sessionToken) throw new Error('Arrival probe authentication failed')
  return { user }
}
export default function (data) {
  run(data.user)
}
