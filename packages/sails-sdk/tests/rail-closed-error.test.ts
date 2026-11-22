/**
 * Despacho 064: the server refuses LN_BTC / LIGHTNING_HODL with HTTP 409 and error code RAIL_CLOSED. The SDK surfaces it
 * as a SailsError carrying that exact code and status (no new SDK type; an unknown code is passed through as-is).
 */
import { errorFromResponseBody, SailsError } from '../src/errors'

describe('RAIL_CLOSED is propagated by the SDK (Despacho 064)', () => {
  it('becomes a SailsError with code RAIL_CLOSED, status 409 and the rail in details', () => {
    const err = errorFromResponseBody(
      { success: false, error: 'RAIL_CLOSED', message: 'Rail closed for Day 0: LN_BTC (Despacho 064). It is not available in any environment.', details: [{ asset: 'LN_BTC' }] } as any,
      409,
    )
    expect(err).toBeInstanceOf(SailsError)
    expect(err.code).toBe('RAIL_CLOSED')
    expect(err.statusCode).toBe(409)
    expect(err.details).toEqual([{ asset: 'LN_BTC' }])
    expect(err.message).toMatch(/LN_BTC/)
  })
})
