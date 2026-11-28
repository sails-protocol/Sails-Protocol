import { ASIDE_DEFAULT, ASIDE_MAX, ASIDE_MIN, ASIDE_WIDTH_STORAGE_KEY, asideMax, clampAside, readAsideWidth, saveAsideWidth } from '../src/lib/tradeAsideWidth'

const memoryStore = (data: Record<string, string> = {}) => ({ getItem: (k: string) => (k in data ? data[k] : null), setItem: (k: string, v: string) => { data[k] = v } })
const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }

describe('trade aside width (desktop divider)', () => {
  it('keeps the stage column at least 520 px and the aside within 320-640', () => {
    expect(asideMax(1146)).toBe(610) // 1440 viewport with side menu
    expect(asideMax(2000)).toBe(ASIDE_MAX)
    expect(asideMax(650)).toBe(ASIDE_MIN) // narrow grid: never below the minimum
    expect(clampAside(900, 1146)).toBe(610)
    expect(clampAside(100, 1146)).toBe(ASIDE_MIN)
    expect(clampAside(NaN, 1146)).toBe(ASIDE_DEFAULT)
  })
  it('reads only valid stored widths and survives blocked storage', () => {
    const store = memoryStore()
    expect(readAsideWidth(store)).toBe(ASIDE_DEFAULT)
    expect(saveAsideWidth(store, 480.4)).toBe(true)
    expect(store.getItem(ASIDE_WIDTH_STORAGE_KEY)).toBe('480')
    expect(readAsideWidth(store)).toBe(480)
    expect(readAsideWidth(memoryStore({ [ASIDE_WIDTH_STORAGE_KEY]: '9999' }))).toBe(ASIDE_DEFAULT)
    expect(readAsideWidth(throwing)).toBe(ASIDE_DEFAULT)
    expect(saveAsideWidth(throwing, 400)).toBe(false)
  })
})
