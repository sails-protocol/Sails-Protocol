// tests/configLegacyProtocolFeeRate.test.ts
//
// CSC-E02 / #165 — PROTOCOL_FEE_RATE (legacy float config) is retired. It is
// unset/empty/zero-compatible, but a non-zero value is refused at config load
// instead of looking like a configured fee while nothing is charged.

import { assertLegacyProtocolFeeRateRetired } from '../src/config'

describe('assertLegacyProtocolFeeRateRetired (CSC-E02)', () => {
  it.each([undefined, '', '   ', '0', '0.0', '00', '0.000'])('accepts %j (fee not set / zero)', (raw) => {
    expect(() => assertLegacyProtocolFeeRateRetired(raw)).not.toThrow()
  })

  it.each(['0.004', '0.0005', '1', '0.40%', 'abc', '-0.1'])('refuses %j with a clear, non-silent error', (raw) => {
    expect(() => assertLegacyProtocolFeeRateRetired(raw)).toThrow(/PROTOCOL_FEE_RATE is retired/)
    expect(() => assertLegacyProtocolFeeRateRetired(raw)).toThrow(/FeePolicyVersion/)
  })

  it('the loaded config no longer exposes a float protocolFeeRate', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { config } = require('../src/config') as { config: { settlement: Record<string, unknown> } }
    expect(config.settlement).not.toHaveProperty('protocolFeeRate')
  })
})
