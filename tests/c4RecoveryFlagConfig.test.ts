// tests/c4RecoveryFlagConfig.test.ts
//
// CTO 344 - SAILS_C4_RECOVERY_ENABLED gates the C4 recovery in the settlement reconciler tick. It is off by default and validated
// strictly at config load: only 'true' or 'false' (exact) are accepted; anything else throws instead of reading as on or off.
describe('SAILS_C4_RECOVERY_ENABLED (config)', () => {
  const ORIGINAL_ENV = process.env
  beforeEach(() => { jest.resetModules(); process.env = { ...ORIGINAL_ENV } })
  afterAll(() => { process.env = ORIGINAL_ENV })

  const load = (value: string | undefined) => {
    if (value === undefined) delete process.env.SAILS_C4_RECOVERY_ENABLED
    else process.env.SAILS_C4_RECOVERY_ENABLED = value
    return () => require('../src/config').config.features.c4Recovery as boolean
  }

  it('is OFF when unset', () => { expect(load(undefined)()).toBe(false) })
  it("is ON only for 'true' and OFF for 'false'", () => {
    expect(load('true')()).toBe(true)
    jest.resetModules()
    expect(load('false')()).toBe(false)
  })
  it.each(['1', '0', 'yes', 'on', 'True', 'TRUE', ' true', 'true ', ''])('refuses to boot on %j (never silently on or off)', (value) => {
    expect(load(value)).toThrow(/SAILS_C4_RECOVERY_ENABLED must be 'true' or 'false'/)
  })
})
