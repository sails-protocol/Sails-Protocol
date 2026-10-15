/**
 * Sails TestKit / k6 bounded authenticated WebSocket protocol check.
 * Correctness only: one real PoP identity, one one-time ticket, one PING,
 * and an asserted application PONG on the same socket. No throughput claim.
 * Run against an isolated local backend; never print ticket-bearing URLs.
 */
import http from 'k6/http'
import ws from 'k6/ws'
import { check } from 'k6'
import { BASE_URL } from '../k6.config.js'
import { generateTestUser, authHeaders } from '../utils/data-generator.js'

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
  const ticketRes = http.post(`${BASE_URL}/v1/identity/ws-ticket`, null, {
    ...authHeaders(data), tags: { name: 'ws_ticket' },
  })
  if (!check(ticketRes, { 'ticket: HTTP 200': r => r.status === 200 })) throw new Error('WS ticket request rejected')
  const ticket = ticketRes.json('data.ticket')
  if (typeof ticket !== 'string' || !ticket) throw new Error('Missing WS ticket')
  assertApplicationPong(`${WS_BASE}/v1/openp2p/chat?ticket=${encodeURIComponent(ticket)}`)

}

/** Exported for an isolated deliberately non-PONG WebSocket fixture. */
export function assertApplicationPong(url) {
  let pong = false
  let appError = false
  let opened = false
  const result = ws.connect(url, {
    tags: { name: 'authenticated_chat_ws' },
  }, socket => {
    socket.on('open', () => {
      opened = true
      socket.send(JSON.stringify({ type: 'PING', payload: {} }))
    })
    socket.on('message', raw => {
      let message
      try { message = JSON.parse(raw) } catch { appError = true; socket.close(); return }
      if (message?.type === 'PONG') { pong = true; socket.close() }
      else if (message?.type === 'ERROR') { appError = true; socket.close() }
    })
    socket.setTimeout(() => { socket.close() }, 15000)
  })
  check({ opened, pong, appError, status: result && result.status }, {
    'WS upgrade: 101': v => v.status === 101,
    'WS opened': v => v.opened,
    'application PONG received': v => v.pong,
    'no application error': v => !v.appError,
  })
  if (!opened || !pong || appError || !result || result.status !== 101) {
    throw new Error('Authenticated WS PONG protocol check failed (details redacted)')
  }
}
