import { AVATAR_STYLE_STORAGE_KEY, readAvatarStyle, saveAvatarStyle } from '../src/lib/avatarStyle'

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v },
  }
}
const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }

describe('avatar style preference', () => {
  it('defaults to vela when nothing is stored or there is no storage', () => {
    expect(readAvatarStyle(memoryStore())).toBe('vela')
    expect(readAvatarStyle(undefined)).toBe('vela')
  })
  it('reads a persisted valid value', () => {
    const store = memoryStore()
    expect(saveAvatarStyle(store, 'grade')).toBe(true)
    expect(store.data[AVATAR_STYLE_STORAGE_KEY]).toBe('grade')
    expect(readAvatarStyle(store)).toBe('grade')
  })
  it('ignores an invalid stored value', () => {
    expect(readAvatarStyle(memoryStore({ [AVATAR_STYLE_STORAGE_KEY]: 'robohash' }))).toBe('vela')
  })
  it('survives storage that throws', () => {
    expect(readAvatarStyle(throwing)).toBe('vela')
    expect(saveAvatarStyle(throwing, 'mare')).toBe(false)
  })
})
