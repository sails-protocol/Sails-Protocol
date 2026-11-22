/**
 * Market images, checked locally on pick (PO, 2026-11-22). Nothing is uploaded: the File is read only to show a
 * preview and to compare its size with the recommendation. Errors (wrong type, over 5 MB) refuse the file; a smaller
 * or differently shaped image is only a warning (it may look blurred, or its edges will be cropped). Pure.
 */
export type ImageKind = 'icon' | 'banner' | 'cover'

export interface ImageSpec {
  /** Width / height. */
  ratio: number
  ratioLabel: string
  recommended: readonly [number, number]
  minimum: readonly [number, number]
  types: readonly string[]
}

const PHOTO = ['image/png', 'image/jpeg', 'image/webp'] as const
export const IMAGE_SPECS: Readonly<Record<ImageKind, ImageSpec>> = {
  // SVG only for the square icon (a logo); photos for banner and cover.
  icon: { ratio: 1, ratioLabel: '1:1', recommended: [512, 512], minimum: [256, 256], types: [...PHOTO, 'image/svg+xml'] },
  banner: { ratio: 3, ratioLabel: '3:1', recommended: [1500, 500], minimum: [1200, 400], types: PHOTO },
  cover: { ratio: 3 / 4, ratioLabel: '3:4', recommended: [900, 1200], minimum: [600, 800], types: PHOTO },
}

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** Ratio tolerance before warning that the edges will be cropped. */
export const RATIO_TOLERANCE = 0.05

/** File-level errors: the file is refused. */
export function imageFileError(kind: ImageKind, file: { type: string; size: number }): 'wrongType' | 'tooBig' | null {
  if (!IMAGE_SPECS[kind].types.includes(file.type)) return 'wrongType'
  return file.size > IMAGE_MAX_BYTES ? 'tooBig' : null
}

/**
 * Dimensions → ok | small | ratio. A vector icon (SVG) has no real pixel size, so only its shape is checked.
 * "small" wins when both apply: a blurred image is the bigger surprise.
 */
export function imageDimensionCheck(kind: ImageKind, width: number, height: number, vector = false): 'ok' | 'small' | 'ratio' {
  if (!(width > 0 && height > 0)) return 'ok'
  const spec = IMAGE_SPECS[kind]
  if (!vector && (width < spec.minimum[0] || height < spec.minimum[1])) return 'small'
  return Math.abs(width / height / spec.ratio - 1) > RATIO_TOLERANCE ? 'ratio' : 'ok'
}

/** "1.500 × 500 px" in the interface language, with non-breaking spaces so it never wraps. */
export function formatPx([w, h]: readonly [number, number], locale: string): string {
  return `${w.toLocaleString(locale)} × ${h.toLocaleString(locale)} px`
}
