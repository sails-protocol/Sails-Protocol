/**
 * Sails identity avatar: a deterministic SVG generated locally from a seed
 * (the user's public key). Same seed -> same avatar everywhere; no photo,
 * no network, no third-party art. Original designs, owned by the project.
 *
 * Styles: 'vela' (sails, the brand motif), 'mare' (tide bands), 'grade'
 * (mirrored 5x5 grid). Pure string output so it works in React, SSR and tests.
 */

export type IdentityAvatarStyle = 'vela' | 'mare' | 'grade'

// Brand-derived palette (orange/amber/blue/sky/teal/violet) on graphite backgrounds.
const FG = ['#F97316', '#FBBF24', '#3B82F6', '#60A5FA', '#2DD4BF', '#A78BFA']
const BG = ['#1C2028', '#252A33', '#1E293B', '#2A2420', '#1F2A2E', '#262338']

/** FNV-1a 32-bit hash. */
function hash(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Small deterministic PRNG (mulberry32) seeded from the hash. */
function rng(seed: string): () => number {
  let a = hash(seed)
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(r: () => number, list: T[]): T => list[Math.floor(r() * list.length)]

function twoColors(r: () => number): [string, string] {
  const a = Math.floor(r() * FG.length)
  const b = (a + 1 + Math.floor(r() * (FG.length - 1))) % FG.length
  return [FG[a], FG[b]]
}

function vela(r: () => number): string {
  const [main, jib] = twoColors(r)
  const mast = 30 + Math.round(r() * 8) // mast x position
  const top = 12 + Math.round(r() * 6)
  const boom = 44 + Math.round(r() * 4)
  const reach = 14 + Math.round(r() * 8) // main sail width
  const jibReach = 9 + Math.round(r() * 7)
  const waveY = 50 + Math.round(r() * 3)
  return (
    `<path d="M${mast} ${top} L${mast} ${boom} L${mast + reach} ${boom} Z" fill="${main}"/>` +
    `<path d="M${mast - 2} ${top + 6} L${mast - 2} ${boom} L${mast - 2 - jibReach} ${boom} Z" fill="${jib}" opacity="0.9"/>` +
    `<path d="M0 ${waveY} Q16 ${waveY - 4} 32 ${waveY} T64 ${waveY} V64 H0 Z" fill="${jib}" opacity="0.35"/>`
  )
}

function mare(r: () => number): string {
  const [a, b] = twoColors(r)
  const c = pick(r, FG)
  const band = (y: number, amp: number, color: string, op: number) =>
    `<path d="M0 ${y} Q16 ${y - amp} 32 ${y} T64 ${y} V64 H0 Z" fill="${color}" opacity="${op}"/>`
  const y1 = 22 + Math.round(r() * 8)
  return band(y1, 6 + r() * 6, a, 0.95) + band(y1 + 12, 4 + r() * 6, b, 0.9) + band(y1 + 24, 3 + r() * 4, c, 0.85)
}

function grade(r: () => number): string {
  const [on, accent] = twoColors(r)
  let cells = ''
  const size = 8
  const gap = 1.5
  const offset = (64 - (5 * size + 4 * gap)) / 2
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (r() < 0.5) continue
      const color = r() < 0.2 ? accent : on
      for (const cx of x === 2 ? [2] : [x, 4 - x]) {
        const px = offset + cx * (size + gap)
        const py = offset + y * (size + gap)
        cells += `<rect x="${px}" y="${py}" width="${size}" height="${size}" rx="2" fill="${color}"/>`
      }
    }
  }
  return cells
}

/** Returns a standalone SVG string (decorative: callers give the accessible name). */
export function identityAvatarSvg(seed: string, style: IdentityAvatarStyle = 'vela'): string {
  const r = rng(`${style}:${seed}`)
  const bg = pick(r, BG)
  const body = style === 'vela' ? vela(r) : style === 'mare' ? mare(r) : grade(r)
  const clip = `ia-${hash(style + seed).toString(36)}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false">` +
    `<defs><clipPath id="${clip}"><circle cx="32" cy="32" r="32"/></clipPath></defs>` +
    `<g clip-path="url(#${clip})"><rect width="64" height="64" fill="${bg}"/>${body}</g></svg>`
  )
}
