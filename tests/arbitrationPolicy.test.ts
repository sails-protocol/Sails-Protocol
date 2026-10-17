import {
  arbitrationCapabilityFor,
  parseArbitrationMode,
  assertArbitrationPolicyCompatible,
  assertMarketArbitrationCollateralProductionEligible,
  resolveArbitrationModeForImplementation,
} from '../src/modules/open-settlement/arbitration-policy'
import { createArbitrationProviderResolver } from '../src/modules/open-settlement/arbitration-provider-resolver'

describe('ADR-003 rail-scoped arbitration policy', () => {
  it('accepts only the closed arbitration-mode vocabulary at the configuration boundary', () => {
    expect(parseArbitrationMode(undefined)).toBe('trusted-list')
    expect(parseArbitrationMode('trusted-list')).toBe('trusted-list')
    expect(parseArbitrationMode('market')).toBe('market')
    expect(() => parseArbitrationMode('some-future-mode')).toThrow(/Expected trusted-list\|market/)
  })

  it('declares MULTISIG fixed and MOCK dynamically reassignable', () => {
    expect(arbitrationCapabilityFor('MULTISIG')).toBe('FIXED_ARBITER_COMMITMENT')
    expect(arbitrationCapabilityFor('MOCK')).toBe('DYNAMIC_REASSIGNABLE')
  })

  it('fails closed for an implementation whose arbitration capability is unknown', () => {
    expect(arbitrationCapabilityFor('WDK_USDT_EVM')).toBe('UNKNOWN')
    expect(() => assertArbitrationPolicyCompatible('WDK_USDT_EVM', 'market')).toThrow(/UNKNOWN/)
  })

  it('rejects market policy for MULTISIG', () => {
    expect(() => assertArbitrationPolicyCompatible('MULTISIG', 'market')).toThrow(
      /FIXED_ARBITER_COMMITMENT/
    )
  })

  it('allows market policy for MOCK', () => {
    expect(() => assertArbitrationPolicyCompatible('MOCK', 'market')).not.toThrow()
  })

  it('resolves an explicit implementation override ahead of the deployment default', () => {
    expect(resolveArbitrationModeForImplementation('MOCK', 'trusted-list', { MOCK: 'market' })).toBe('market')
    expect(resolveArbitrationModeForImplementation('MULTISIG', 'trusted-list', { MOCK: 'market' })).toBe('trusted-list')
  })

  it('supports a mixed deployment without requiring trusted arbiters for the MOCK market rail', () => {
    const resolver = createArbitrationProviderResolver(
      'trusted-list',
      { MOCK: 'market' },
      [],
    )
    expect(resolver('MOCK').name).toBe('market-arbitration')
  })

  it('still requires trusted arbiters when a rail effectively selects trusted-list', () => {
    const resolver = createArbitrationProviderResolver(
      'trusted-list',
      { MOCK: 'market' },
      [],
    )
    expect(() => resolver('MULTISIG')).toThrow(/No trusted arbitrators configured/)
  })
})

// Issue #255 - MarketArbitrationProvider.monetaryCollateral is caller-declared bookkeeping with no
// external funding/escrow verification (see arbitration-policy.ts's own comment on this function for
// the full trace). ARBITRATION_MODE=market must refuse to boot in production; every other combination
// (non-production, or trusted-list mode) must be completely unaffected.
describe('Issue #255 - market arbitration collateral is not economically backed - production eligibility', () => {
  it('refuses to boot when market mode is selected in production', () => {
    expect(() => assertMarketArbitrationCollateralProductionEligible('market', true)).toThrow(
      /Not economically backed, not production-eligible/
    )
  })

  it('allows market mode outside production (dev/test/sandbox use)', () => {
    expect(() => assertMarketArbitrationCollateralProductionEligible('market', false)).not.toThrow()
  })

  it('allows trusted-list mode in production - unaffected, no self-declared collateral involved', () => {
    expect(() => assertMarketArbitrationCollateralProductionEligible('trusted-list', true)).not.toThrow()
  })

  it('allows trusted-list mode outside production', () => {
    expect(() => assertMarketArbitrationCollateralProductionEligible('trusted-list', false)).not.toThrow()
  })
})
