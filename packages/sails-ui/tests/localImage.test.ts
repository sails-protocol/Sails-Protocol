import { readFileSync } from 'fs'
import { join } from 'path'
import { isLocalPreviewUrl } from '../src/lib/localImage'

describe('remote market images never load without a click (GK, 2026-11-22)', () => {
  it('accepts only local previews', () => {
    expect(isLocalPreviewUrl('blob:http://localhost/abc')).toBe(true)
    expect(isLocalPreviewUrl('data:image/png;base64,AAAA')).toBe(true)
    for (const url of ['https://media.example/banner.png', 'http://x/y.png', '//x/y.png', 'data:text/html,<b>', '', null, undefined]) {
      expect(isLocalPreviewUrl(url)).toBe(false)
    }
  })

  it('MarketBanner and MarketIcon gate their <img> on isLocalPreviewUrl', () => {
    for (const f of ['MarketBanner.tsx', 'MarketIcon.tsx']) {
      const src = readFileSync(join(__dirname, '../src/components/markets', f), 'utf8')
      expect(src).toMatch(/isLocalPreviewUrl\(/)
    }
  })
})
