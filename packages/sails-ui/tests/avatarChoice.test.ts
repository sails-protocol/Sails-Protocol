import { AVATAR_CHOICE_STORAGE_PREFIX, AVATAR_VARIANTS, readAvatarChoice, saveAvatarChoice, seedFor } from '../src/lib/avatarChoice'

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v },
  }
}
const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
const KEY = '02abc'

describe('avatar choice', () => {
  it('variant 0 is the key itself (today’s avatar)', () => {
    expect(seedFor(KEY, 0)).toBe(KEY)
  })
  it('other variants have stable, distinct seeds', () => {
    const seeds = Array.from({ length: AVATAR_VARIANTS }, (_, n) => seedFor(KEY, n))
    expect(seeds[3]).toBe(`${KEY}:3`)
    expect(seedFor(KEY, 3)).toBe(seeds[3])
    expect(new Set(seeds).size).toBe(AVATAR_VARIANTS)
  })
  it('reads back a saved choice per public key', () => {
    const store = memoryStore()
    expect(saveAvatarChoice(store, KEY, { style: 'grade', variant: 5 })).toBe(true)
    expect(Object.keys(store.data)).toEqual([AVATAR_CHOICE_STORAGE_PREFIX + KEY])
    expect(readAvatarChoice(store, KEY)).toEqual({ style: 'grade', variant: 5 })
    expect(readAvatarChoice(store, '02other')).toBeNull()
  })
  it('ignores missing and invalid stored values', () => {
    expect(readAvatarChoice(memoryStore(), KEY)).toBeNull()
    expect(readAvatarChoice(undefined, KEY)).toBeNull()
    for (const bad of ['not json', '{"style":"robohash","variant":1}', '{"style":"vela","variant":8}', '{"style":"vela","variant":1.5}', 'null']) {
      expect(readAvatarChoice(memoryStore({ [AVATAR_CHOICE_STORAGE_PREFIX + KEY]: bad }), KEY)).toBeNull()
    }
  })
  it('survives storage that throws or is missing', () => {
    expect(readAvatarChoice(throwing, KEY)).toBeNull()
    expect(saveAvatarChoice(throwing, KEY, { style: 'mare', variant: 1 })).toBe(false)
    expect(saveAvatarChoice(undefined, KEY, { style: 'mare', variant: 1 })).toBe(false)
  })
})
