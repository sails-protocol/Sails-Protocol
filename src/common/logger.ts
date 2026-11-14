/**
 * Shared pino logger for code that runs outside a Fastify request
 * lifecycle (background services, event handlers, connection setup) —
 * PRODUCTION_READINESS_FIXES.md P0 item 8, closed 2026-08-08.
 *
 * `app.log` (Fastify's own per-request pino instance) is the right
 * logger inside a route handler, but pear.service.ts/event-store.ts/
 * handlers.ts/database/redis connection setup all run before or outside
 * any request — they never had a real logger to reach for, so they
 * fell back to bare `console.*`, with no level filtering, no structured
 * fields, and no way to redact anything. One base instance here (same
 * level/config `app.ts` builds its own Fastify logger from) with a
 * `.child({ module })` per call site, rather than five independent
 * ad-hoc `pino()` instances with their own hardcoded settings.
 */
import pino from 'pino'
import { config } from '../config'

// Missão 11 Fase 8.1 LB-09 — app.ts's own Fastify request logger has had
// a `redact` config since PRODUCTION_READINESS_FIXES.md P1 item 9
// (req.headers.authorization/cookie); this shared instance — used by
// every background service/event handler/connection-setup file that
// runs outside a request lifecycle — never had one. A real, evidenced
// latent risk (Fase 8.0 audit): nothing currently logs a raw secret
// value here, but a future call site logging a caught Postgres/Redis
// connection error (whose own .message sometimes echoes the DSN,
// credentials included, on an auth failure) would print it unredacted.
//
// Two-part fix, chosen deliberately over one blanket rule:
// 1. `redact.paths` — standard pino field-name redaction, for any call
//    site that logs a credential-shaped field directly (by any of these
//    names, at any single nesting level pino's `*` wildcard reaches).
//    Covers the structured-field case (e.g. `log.info({ token })`).
// 2. A custom `err` serializer — the case redact.paths CAN'T reach: a
//    real Error whose own `.message`/`.stack` happens to CONTAIN a
//    connection-string-shaped substring (`user:pass@host`), not a
//    separate field. Blanket-redacting `err.message` would gut every
//    legitimate error's diagnostic value (this codebase logs real
//    caught errors constantly, per every `.catch((err) => log.error(...))`
//    site already in this repo) — scrubbing only the credential-shaped
//    substring, in place, keeps the rest of the message intact. This is
//    additive to pino's own default error serializer (still gets
//    type/message/stack), not a replacement of it.
// The user may be empty (`redis://:password@host`), and a DSN can carry the secret as a query parameter instead.
const CONNECTION_STRING_CREDENTIALS_PATTERN = /:\/\/[^:@/\s]*:[^@/\s]+@/g
const QUERY_CREDENTIALS_PATTERN = /([?&](?:password|pass|pwd|secret|token|access_token|api_?key|auth)=)[^&#\s]+/gi

function scrubConnectionStringCredentials(value: string): string {
  return value
    .replace(CONNECTION_STRING_CREDENTIALS_PATTERN, '://[REDACTED]@')
    .replace(QUERY_CREDENTIALS_PATTERN, '$1[REDACTED]')
}

/** pino's error serializer with credentials scrubbed from message and stack. Shared by every logger, the
 *  Fastify request logger included: a dependency error's message can echo the DSN it failed to reach. */
export function serializeError(err: unknown): ReturnType<typeof pino.stdSerializers.err> {
  const base = pino.stdSerializers.err(err as Error)
  if (typeof base.message === 'string') base.message = scrubConnectionStringCredentials(base.message)
  if (typeof base.stack === 'string') base.stack = scrubConnectionStringCredentials(base.stack)
  return base
}

// Exported separately (not inlined into the `pino()` call below) so
// tests/logger.test.ts can construct its own pino instance from these
// EXACT options against a synchronous, directly-readable destination —
// proving the real redaction config works without fighting the
// production instance's own async stdout write timing (pino writes via
// sonic-boom by default, not a plain synchronous `stream.write()`).
export const loggerOptions: pino.LoggerOptions = {
  level: config.app?.logLevel ?? 'info',
  transport:
    config.app?.env === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  redact: {
    paths: [
      'token', '*.token',
      'password', '*.password',
      'authorization', '*.authorization',
      'secret', '*.secret',
      'databaseUrl', '*.databaseUrl',
      'redisUrl', '*.redisUrl',
      'seed', '*.seed',
      'privateKey', '*.privateKey',
      'mnemonic', '*.mnemonic',
      'wif', '*.wif',
      'xprv', '*.xprv',
    ],
    censor: '[REDACTED]',
  },
  serializers: { err: serializeError },
}

// `config.app?.` — several existing test files mock '../config' with a
// partial shape covering only the fields their own module under test
// reads. Those mocks predate this file and never had a reason to include
// `app`, since nothing they imported used to read it. Falling back here
// keeps this shared, low-level module from hard-crashing at import time
// over a test double's shape rather than a real production config gap.
export const logger = pino(loggerOptions)

export function childLogger(module: string): pino.Logger {
  return logger.child({ module })
}
