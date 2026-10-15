/** One real authenticated create/cancel iteration, never a load benchmark. */
import { BASE_URL } from '../k6.config.js'
import { generateTestUser } from '../utils/data-generator.js'
import { run } from './intent-creation.js'

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(BASE_URL)) {
  throw new Error('Bounded Intent test requires loopback HTTP target')
}
export const options = {
  scenarios: { bounded_intent: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '30s' } },
  thresholds: { checks: ['rate==1'], sails_intent_success: ['rate==1'] },
}
export function setup() {
  const user = generateTestUser(BASE_URL, 'bounded-intent')
  if (!user || !user.sessionToken) throw new Error('Bounded Intent identity authentication failed')
  return { user }
}
export default function (data) { run(data.user) }
