import { IMAGE_MAX_BYTES, IMAGE_SPECS, formatPx, imageDimensionCheck, imageFileError } from '../src/lib/imageCheck'

describe('market image check (local only)', () => {
  it('recommended and minimum sizes per kind', () => {
    expect(IMAGE_SPECS.icon.recommended).toEqual([512, 512])
    expect(IMAGE_SPECS.banner.recommended).toEqual([1500, 500])
    expect(IMAGE_SPECS.banner.minimum).toEqual([1200, 400])
    expect(IMAGE_SPECS.cover.recommended).toEqual([900, 1200])
  })

  it('refuses wrong types (SVG only for the icon) and files over 5 MB', () => {
    expect(imageFileError('icon', { type: 'image/svg+xml', size: 10 })).toBeNull()
    expect(imageFileError('banner', { type: 'image/svg+xml', size: 10 })).toBe('wrongType')
    expect(imageFileError('banner', { type: 'image/gif', size: 10 })).toBe('wrongType')
    expect(imageFileError('banner', { type: 'image/webp', size: IMAGE_MAX_BYTES })).toBeNull()
    expect(imageFileError('banner', { type: 'image/jpeg', size: IMAGE_MAX_BYTES + 1 })).toBe('tooBig')
  })

  it('warns on small or differently shaped images, within a 5 % tolerance', () => {
    expect(imageDimensionCheck('banner', 1500, 500)).toBe('ok')
    expect(imageDimensionCheck('banner', 1500, 520)).toBe('ok')
    expect(imageDimensionCheck('banner', 1500, 600)).toBe('ratio')
    expect(imageDimensionCheck('banner', 900, 300)).toBe('small')
    expect(imageDimensionCheck('icon', 512, 400)).toBe('ratio')
    expect(imageDimensionCheck('icon', 100, 100)).toBe('small')
    expect(imageDimensionCheck('icon', 10, 10, true)).toBe('ok')
    expect(imageDimensionCheck('cover', 900, 1200)).toBe('ok')
    expect(imageDimensionCheck('banner', 0, 0)).toBe('ok')
  })

  it('formats pixel sizes in the locale with non-breaking spaces', () => {
    expect(formatPx([1500, 500], 'pt-BR')).toBe('1.500 × 500 px')
    expect(formatPx([1500, 500], 'en')).toBe('1,500 × 500 px')
  })
})
