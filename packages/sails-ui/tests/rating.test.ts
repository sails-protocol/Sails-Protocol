import { isAlreadyRatedError, readRated, saveRated, validateRating } from '../src/lib/rating'

describe('rating input validation', () => {
  it('accepts integer scores 1 to 5 and trims the comment', () => {
    expect(validateRating(1, '')).toEqual({ ok: true, input: { score: 1 } })
    expect(validateRating(5, '  ótimo trade  ')).toEqual({ ok: true, input: { score: 5, comment: 'ótimo trade' } })
    expect(validateRating(3, '   ')).toEqual({ ok: true, input: { score: 3 } })
  })
  it('refuses a missing, fractional or out-of-range score', () => {
    for (const s of [null, 0, 6, 2.5, -1, Number.NaN]) expect(validateRating(s, 'x')).toEqual({ ok: false, error: 'score' })
  })
})

describe('already-rated answer and the tab memory', () => {
  it('recognises the server message for a repeat rating only', () => {
    expect(isAlreadyRatedError(new Error('demo-me has already rated trade t-1'))).toBe(true)
    expect(isAlreadyRatedError(new Error('ratedId must be the other party to trade t-1'))).toBe(false)
    expect(isAlreadyRatedError('already rated')).toBe(false)
  })
  it('remembers per trade and survives blocked storage', () => {
    const data: Record<string, string> = {}
    const store = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v } }
    expect(readRated(store, 't-1')).toBeNull()
    saveRated(store, 't-1', 'rated')
    expect(readRated(store, 't-1')).toBe('rated')
    expect(readRated(store, 't-2')).toBeNull()
    const throwing = { getItem: () => { throw new Error('x') }, setItem: () => { throw new Error('x') } }
    expect(readRated(throwing, 't-1')).toBeNull()
    expect(() => saveRated(throwing, 't-1', 'already')).not.toThrow()
  })
})
