/** WCAG 2.x contrast ratio of two sRGB colors given as [r, g, b] (0-255). */
export type Rgb = [number, number, number]

const channel = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** `fg` at `alpha` over an opaque `bg` (how a /10 tint actually renders). */
export function blend(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))) as Rgb
}

/** "R G B" triplet (this repo's CSS variable format) to Rgb, or null. */
export function parseTriplet(v: string): Rgb | null {
  const m = v.trim().match(/^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
