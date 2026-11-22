import { sectionFromSearch } from '../src/lib/settingsSection'

const IDS = ['wallet', 'aparencia', 'idioma', 'no-sails'] as const

describe('Configurações ?section deep link', () => {
  it('opens the section named in the URL', () => {
    expect(sectionFromSearch('?section=no-sails', IDS)).toEqual({ id: 'no-sails', fromUrl: true })
    expect(sectionFromSearch(new URLSearchParams('demo=1&section=idioma'), IDS)).toEqual({ id: 'idioma', fromUrl: true })
  })

  it('falls back to the first section (Wallet) when absent, empty or unknown', () => {
    for (const q of ['', '?demo=1', '?section=', '?section=Wallet', '?section=apps']) expect(sectionFromSearch(q, IDS)).toEqual({ id: 'wallet', fromUrl: false })
  })
})
