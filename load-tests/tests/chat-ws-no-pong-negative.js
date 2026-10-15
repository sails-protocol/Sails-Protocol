/**
 * Deliberately negative test: connect to a disposable loopback WS server
 * that upgrades but never emits application PONG. k6 MUST exit nonzero.
 * Never run against production or interpret failure as load performance.
 */
import { assertApplicationPong } from './ws-pong-assertion.js'
export const options = {
  scenarios: { no_pong_negative: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '10s' } },
  thresholds: { checks: ['rate==1'] },
}
export default function () {
  assertApplicationPong('ws://127.0.0.1:39871')
}
