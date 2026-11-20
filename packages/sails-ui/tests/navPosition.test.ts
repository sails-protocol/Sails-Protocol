import { NAV_POSITION_STORAGE_KEY, readNavPosition, saveNavPosition } from '../src/lib/navPosition'

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v },
  }
}
const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }

describe('desktop menu position preference', () => {
  it('defaults to the side menu when nothing is stored or there is no storage', () => {
    expect(readNavPosition(memoryStore())).toBe('side')
    expect(readNavPosition(undefined)).toBe('side')
  })
  it('reads a persisted valid value under its own key', () => {
    const store = memoryStore()
    expect(saveNavPosition(store, 'top')).toBe(true)
    expect(store.data[NAV_POSITION_STORAGE_KEY]).toBe('top')
    expect(readNavPosition(store)).toBe('top')
  })
  it('ignores an invalid stored value', () => {
    expect(readNavPosition(memoryStore({ [NAV_POSITION_STORAGE_KEY]: 'bottom' }))).toBe('side')
  })
  it('survives storage that throws', () => {
    expect(readNavPosition(throwing)).toBe('side')
    expect(saveNavPosition(throwing, 'top')).toBe(false)
  })
})
