/**
 * Real Intent create/cancel — POST /v1/intents then DELETE
 * /v1/intents/:id (src/core/intent.routes.ts — was /api/v1/intents,
 * renamed PRODUCTION_READINESS_FIXES.md P0 item 1, closed 2026-08-08;
 * file itself moved from src/routes/intentRoutes.ts 2026-08-10),
 * same round trip load-tests/artillery/intent-api.yml already proved out
 * with Artillery. `setup()`
 * registers one real, PoP-authenticated identity once per run (not once
 * per iteration/VU) — every iteration reuses that same session, since
 * this test is about Intent API throughput, not auth throughput (see
 * reconciliation.js/trade-lifecycle.js for flows where a fresh identity
 * per iteration is the actual point).
 *
 * Standalone default (`k6 run tests/intent-creation.js`): a constant
 * 100 req/s (one create+cancel round trip counted as 2 requests) for
 * 30s, matching the brief's "100 req/s de criação de intents". A
 * scenario file (scenarios/*.js) that imports this module's `run()`
 * function instead gets to drive it under a different VU/arrival-rate
 * shape without duplicating the create/cancel logic.
 */
import { check } from 'k6'
import http from 'k6/http'
import { BASE_URL, baseOptions } from '../k6.config.js'
import { generateTestUser, generateTestIntent, authHeaders } from '../utils/data-generator.js'
import { intentCreateDuration, intentCancelDuration, intentSuccessRate, recordFlow } from '../utils/metrics.js'
import { standard } from '../utils/thresholds.js'

export function setup() {
  const user = generateTestUser(BASE_URL, 'intent')
  if (!user) throw new Error('setup: could not authenticate the shared test identity')
  return { user }
}

/** One real create+cancel round trip — exported so scenarios/*.js can drive this same flow under a different load shape. */
export function run(user, intentOverride) {
  const intent = intentOverride || generateTestIntent()
  const createRes = http.post(`${BASE_URL}/v1/intents`, JSON.stringify(intent), {
    ...authHeaders(user),
    tags: { name: 'intent_create' },
  })
  const created = check(createRes, { 'create: 201': (r) => r.status === 201 })
  recordFlow({ successRate: intentSuccessRate, duration: intentCreateDuration, durationMs: createRes.timings.duration, ok: created, response: createRes })
  if (!created) throw new Error('Intent create failed (status redacted)')

  const intentId = createRes.json('data.id')
  const hasIntentId = check(createRes, { 'create: nonempty intent id': () => typeof intentId === 'string' && intentId.length > 0 })
  if (!hasIntentId) throw new Error('Intent create returned invalid identifier')
  // '{}', not null — Fastify's JSON body parser 400s on an empty body
  // when Content-Type: application/json is set (authHeaders() always
  // sets it), found running this against the real server.
  const cancelRes = http.del(`${BASE_URL}/v1/intents/${intentId}`, '{}', {
    ...authHeaders(user),
    tags: { name: 'intent_cancel' },
  })
  const cancelled = check(cancelRes, { 'cancel: 200': (r) => r.status === 200 })
  recordFlow({ successRate: intentSuccessRate, duration: intentCancelDuration, durationMs: cancelRes.timings.duration, ok: cancelled, response: cancelRes })
  if (!cancelled) throw new Error('Intent cancellation failed (status redacted)')
}

export const options = {
  ...baseOptions,
  scenarios: {
    intent_creation: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: standard,
}

export default function (data) {
  run(data.user)
}
