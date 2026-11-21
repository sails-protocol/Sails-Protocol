/**
 * Server clock estimate for deadline displays (C12). The backend decides every deadline with its own clock
 * under lock; a countdown is only a display, but it should not drift with a wrong device clock. There is no
 * `serverTime` field yet, so the offset comes from the HTTP `Date` header of the latest response
 * (lib/sailsClient.ts records it through the SDK's `fetchImpl` option). Cross-origin, the browser exposes
 * `Date` only when the nó Sails sends `Access-Control-Expose-Headers: Date`; without it the offset stays 0
 * and the device clock is used. Pure and import-free, so Node tests can run it.
 */

/** An offset larger than this is treated as a broken header or proxy, never applied. */
export const MAX_SERVER_OFFSET_MS = 12 * 60 * 60 * 1000

/**
 * Offset (server minus device, in ms) from a `Date` header read at `receivedAt`, or null when the header is
 * missing, unparseable or absurd. The header has 1 s resolution, so the midpoint of that second is used.
 */
export function offsetFromDateHeader(header: string | null | undefined, receivedAt: number): number | null {
  if (!header) return null
  const server = Date.parse(header)
  if (Number.isNaN(server) || !Number.isFinite(receivedAt)) return null
  const offset = server + 500 - receivedAt
  return Math.abs(offset) > MAX_SERVER_OFFSET_MS ? null : offset
}

let offsetMs = 0

/** Keeps the latest valid offset; an invalid header leaves the previous one. */
export function recordServerDate(header: string | null | undefined, receivedAt: number = Date.now()): void {
  const o = offsetFromDateHeader(header, receivedAt)
  if (o !== null) offsetMs = o
}

/** Device time corrected by the latest known server offset (0 until a valid header arrives). */
export function serverNow(): number {
  return Date.now() + offsetMs
}
