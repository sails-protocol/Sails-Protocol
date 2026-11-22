import { blend, contrastRatio, parseTriplet } from '../src/lib/contrast'

describe('contrast', () => {
  it('matches known WCAG values', () => {
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 5)
    expect(contrastRatio([118, 118, 118], [255, 255, 255])).toBeCloseTo(4.54, 2)
    expect(contrastRatio([255, 255, 255], [118, 118, 118])).toBeCloseTo(4.54, 2)
  })
  it('blends a tint over a surface and parses triplets', () => {
    expect(blend([200, 0, 100], [0, 100, 0], 0.1)).toEqual([20, 90, 10])
    expect(parseTriplet(' 17 19 24 ')).toEqual([17, 19, 24])
    expect(parseTriplet('var(--x)')).toBeNull()
  })
})
