/**
 * Sails TestKit / k6 bounded authenticated WebSocket protocol check.
 * Correctness only: one real PoP identity, one one-time ticket, one PING,
 * and an asserted application PONG on the same socket. No throughput claim.
 * Run against an isolated local backend; never print ticket-bearing URLs.
 */
import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../k6.config.js'
import { generateTestUser, authHeaders } from '../utils/data-generator.js'
import { assertApplicationPong } from './ws-pong-assertion.js'

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(BASE_URL)) {
  throw new Error('Bounded WS test requires loopback HTTP target')
}
const WS_BASE = BASE_URL.replace(/^http:/, 'ws:')

export const options = {
  scenarios: { bounded_chat_ws: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '30s' } },
  thresholds: { checks: ['rate==1'], ws_connecting: ['p(95)<15000'] },
}

export function setup() {
  const user = generateTestUser(BASE_URL, 'bounded-ws')
  if (!user || !user.sessionToken) throw new Error('Bounded WS identity authentication failed')
  return { sessionToken: user.sessionToken }
}

export default function (data) {
  // JSON Content-Type requires a valid JSON body; null can be rejected by Fastify.
  const ticketRes = http.post(`${BASE_URL}/v1/identity/ws-ticket`, '{}', {
    ...authHeaders(data), tags: { name: 'ws_ticket' },
  })
  if (!check(ticketRes, { 'ticket: HTTP 200': r => r.status === 200 })) {
    // Status class only: no response body, token, ticket or URL in CI output.
    const status = ticketRes.status
    throw new Error(`WS ticket request rejected (HTTP ${Number.isInteger(status) ? status : 'unknown'})`)
  }
  const ticket = ticketRes.json('data.ticket')
  if (typeof ticket !== 'string' || !ticket) throw new Error('Missing WS ticket')
  assertApplicationPong(`${WS_BASE}/v1/openp2p/chat?ticket=${encodeURIComponent(ticket)}`)

}

