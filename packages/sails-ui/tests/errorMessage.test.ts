/**
 * `lib/errors.ts`'s errorMessage(): SDK 409 codes from trade admission map
 * to Portuguese copy by `code` string; anything else keeps its own message.
 * Run from the repo root like the other packages/sails-ui tests.
 */
import { errorMessage } from '../src/lib/errors'

class FakeSailsError extends Error {
  constructor(message: string, public readonly code: string) { super(message) }
}

describe('errorMessage', () => {
  it('maps INTENT_BOUND and AMBIGUOUS_INTENT by code', () => {
    expect(errorMessage(new FakeSailsError('Intent is bound', 'INTENT_BOUND'), 'x')).toMatch(/vinculada a um trade/)
    expect(errorMessage(new FakeSailsError('Ambiguous', 'AMBIGUOUS_INTENT'), 'x')).toMatch(/mais de um trade/)
  })

  it('maps ESCROW_CREATE_SELLER_ONLY (403 from settlement.create, CTO D7) to its own message', () => {
    expect(errorMessage(new FakeSailsError('Forbidden', 'ESCROW_CREATE_SELLER_ONLY'), 'x')).toBe('Só o vendedor pode criar o escrow desta negociação. Aguarde o vendedor.')
  })

  it('keeps the error message for unknown codes and plain errors', () => {
    expect(errorMessage(new FakeSailsError('Offer is not active', 'CONFLICT'), 'x')).toBe('Offer is not active')
    expect(errorMessage(new Error('boom'), 'x')).toBe('boom')
  })

  it('falls back for non-errors and empty messages', () => {
    expect(errorMessage('nope', 'Falha')).toBe('Falha')
    expect(errorMessage(null, 'Falha')).toBe('Falha')
    expect(errorMessage(new Error(''), 'Falha')).toBe('Falha')
  })
})
