import { EMPTY_DRAFT, MARKET_NAME_MAX, PARTICIPANTS_MAX, addParticipant, canAdvance, canReach, createSteps, marketPreview, type MarketDraft } from '../src/lib/createMarket'

const draft = (over: Partial<MarketDraft>): MarketDraft => ({ ...EMPTY_DRAFT, ...over })

describe('Criar mercado steps', () => {
  it('public markets end at review; private markets add participants and invites', () => {
    expect(createSteps('public')).toEqual(['identity', 'visibility', 'participation', 'infrastructure', 'review'])
    expect(createSteps(null)).toEqual(createSteps('public'))
    expect(createSteps('private').slice(-1)).toEqual(['invites'])
  })

  it('infrastructure defaults to Rede Sails and never blocks', () => {
    expect(EMPTY_DRAFT.infrastructure).toBe('network')
    expect(canAdvance('infrastructure', EMPTY_DRAFT)).toBe(true)
  })

  it('needs a trimmed name within the limit', () => {
    expect(canAdvance('identity', draft({ name: '   ' }))).toBe(false)
    expect(canAdvance('identity', draft({ name: 'Loja' }))).toBe(true)
    expect(canAdvance('identity', draft({ name: 'x'.repeat(MARKET_NAME_MAX + 1) }))).toBe(false)
  })

  it('visibility and participation are separate choices; Personalizado is future', () => {
    expect(canAdvance('visibility', draft({ preset: 'vitrine' }))).toBe(false)
    expect(canAdvance('participation', draft({ visibility: 'public' }))).toBe(false)
    expect(canAdvance('participation', draft({ preset: 'personalizado' }))).toBe(false)
    expect(canAdvance('participation', draft({ preset: 'comunidade' }))).toBe(true)
  })

  it('no reaching a step past an incomplete one', () => {
    expect(canReach('review', draft({ name: 'Loja', visibility: 'public' }))).toBe(false)
    expect(canReach('review', draft({ name: 'Loja', visibility: 'public', preset: 'vitrine' }))).toBe(true)
    expect(canReach('invites', draft({ name: 'Loja', visibility: 'public', preset: 'vitrine' }))).toBe(false)
    expect(canReach('invites', draft({ name: 'Amigos', visibility: 'private', preset: 'comunidade' }))).toBe(true)
  })
})

describe('Prévia do mercado criado', () => {
  const pub = draft({ name: '  Loja Boreal ', description: ' ', visibility: 'public', preset: 'vitrine' })

  it('needs a complete draft', () => {
    expect(marketPreview(EMPTY_DRAFT)).toBeNull()
    expect(marketPreview(draft({ name: 'Loja', visibility: 'public' }))).toBeNull()
    expect(marketPreview(draft({ name: 'Loja', visibility: 'public', preset: 'personalizado' }))).toBeNull()
  })

  it('public: trimmed copy, no id, no offers, no invites screen, three dependencies', () => {
    expect(marketPreview(pub)).toEqual({
      name: 'Loja Boreal', description: null, visibility: 'public', preset: 'vitrine', infrastructure: 'network',
      marketId: null, offers: [], invites: null, dependsOn: ['createMarket', 'marketBranding', 'marketMembership'],
    })
  })

  it('private: one pending invite per participant and the invite dependency', () => {
    const p = marketPreview(draft({ name: 'Amigos', visibility: 'private', preset: 'comunidade', infrastructure: 'own', participants: ['alice', 'bob'] }))
    expect(p?.invites).toEqual([{ identifier: 'alice', state: 'pending' }, { identifier: 'bob', state: 'pending' }])
    expect(p?.dependsOn).toContain('marketInvite')
    expect(p?.infrastructure).toBe('own')
    expect(marketPreview(draft({ name: 'Amigos', visibility: 'private', preset: 'comunidade' }))?.invites).toEqual([])
  })

  it('adds each trimmed identifier once, up to the cap', () => {
    expect(addParticipant([], '  alice ')).toEqual(['alice'])
    const one = ['alice']
    expect(addParticipant(one, 'alice')).toBe(one)
    expect(addParticipant(one, '   ')).toBe(one)
    const full = Array.from({ length: PARTICIPANTS_MAX }, (_, i) => `p${i}`)
    expect(addParticipant(full, 'extra')).toBe(full)
  })
})
