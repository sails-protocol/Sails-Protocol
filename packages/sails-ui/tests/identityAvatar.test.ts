import { identityAvatarSvg } from '../src/lib/identityAvatar'

describe('identityAvatarSvg', () => {
  const key = '02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9'

  it('is deterministic per seed and style', () => {
    expect(identityAvatarSvg(key, 'vela')).toBe(identityAvatarSvg(key, 'vela'))
    expect(identityAvatarSvg(key, 'grade')).toBe(identityAvatarSvg(key, 'grade'))
  })

  it('differs across seeds and styles', () => {
    expect(identityAvatarSvg(key, 'vela')).not.toBe(identityAvatarSvg(key + '0', 'vela'))
    expect(identityAvatarSvg(key, 'vela')).not.toBe(identityAvatarSvg(key, 'mare'))
  })

  it('is decorative SVG with no external references', () => {
    const svg = identityAvatarSvg(key, 'mare')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('aria-hidden="true"')
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
  })
})
