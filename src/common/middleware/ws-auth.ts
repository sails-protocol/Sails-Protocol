/**
 * Single-use WS ticket resolution for WebSocket upgrade routes — a
 * browser client can't set an Authorization header on a WS upgrade
 * request the way `requireAuth` (auth.ts) expects, so both
 * chat.routes.ts and relay.routes.ts authenticate via a query param
 * instead. Extracted here because both files had their own identical
 * copy of this function (found while adding relay.routes.ts, which
 * would have made it a third copy).
 *
 * Security review finding, 2026-08-15 (P1): this used to resolve a raw,
 * long-lived session token (`?token=`) straight against the same Redis
 * session store `requireAuth` uses — reusable, and dangerous to have
 * sitting in a URL that proxies/load-balancers/observability tooling
 * commonly log in full (pino's own request-log redact only masks named
 * object fields, never a substring inside req.url). Replaced with a
 * short-lived, single-use ticket (issueWsTicket() in auth.ts, minted by
 * an authenticated POST /v1/identity/ws-ticket call): resolving one
 * here immediately burns it, so even a ticket that does leak into a log
 * is worthless within seconds and can never be replayed a second time.
 *
 * Issue #301 — "immediately burns it" above used to be a separate
 * `GET` then `DEL`, which does not actually guarantee one-time
 * consumption under concurrency: two simultaneous WS upgrades racing
 * the same ticket could both complete the `GET` before either `DEL`
 * ran, both resolving the same participantId. Replaced with
 * `atomicConsume()` — a single Redis-server-side operation with exactly
 * one winner across any number of concurrent callers, real across every
 * process/instance sharing this Redis, not just within one.
 */
import { atomicConsume } from '../redis/atomic-consume'
import { redis } from '../redis'

const WS_TICKET_PREFIX = 'auth:ws-ticket:'
const SESSION_PREFIX = 'auth:session:'

export async function resolveParticipantFromTicket(ticket: string | undefined): Promise<string | null> {
  if (!ticket) return null
  const key = `${WS_TICKET_PREFIX}${ticket}`
  const raw = await atomicConsume(key)
  if (!raw) return null

  let record: { participantId?: unknown; sessionToken?: unknown }
  try {
    record = JSON.parse(raw) as { participantId?: unknown; sessionToken?: unknown }
  } catch {
    return null
  }
  if (typeof record.participantId !== 'string' || typeof record.sessionToken !== 'string' || record.participantId.length === 0 || record.sessionToken.length === 0) {
    return null
  }

  const sessionParticipantId = await redis.get(`${SESSION_PREFIX}${record.sessionToken}`)
  return sessionParticipantId === record.participantId ? record.participantId : null
}
