// #307 B.3. Separate from ./index (the client itself) so that code mapping
// errors — app.ts's error handler — does not depend on the client module,
// which many test suites replace wholesale.

const UNAVAILABLE_REPLY = /^(BUSY|LOADING|MASTERDOWN|TRYAGAIN)\b/

/**
 * True for failures that mean "Redis could not answer now" — a command
 * timeout, a closed connection, exhausted reconnect retries, or a server
 * reply that it is temporarily unable to serve — as opposed to a bug.
 * Callers map these to 503; none of them proves the command did not run.
 */
export function isRedisUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'MaxRetriesPerRequestError') return true
  if (error.message === 'Command timed out' || error.message === 'Connection is closed.') return true
  return error.name === 'ReplyError' && UNAVAILABLE_REPLY.test(error.message)
}
