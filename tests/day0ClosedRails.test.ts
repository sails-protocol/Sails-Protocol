/**
 * Despacho 064 (CTO), Gatekeeper H1/H3: the Day-0 closed-rail rule is one source of truth that does not depend on
 * NODE_ENV, config or any environment variable, and there is no way to reopen it without a code change.
 * The entry points themselves are covered on real PostgreSQL by tests/integration/day0ClosedRails.test.ts.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const MODULE = join(__dirname, '../src/common/day0-closed-rails.ts')

describe('Day-0 closed rails (Despacho 064)', () => {
  it('the module reads no environment: no `process`, no config import (no flag to reopen)', () => {
    const src = readFileSync(MODULE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(src).not.toMatch(/\bprocess\b/)
    expect(src).not.toMatch(/from ['"][./]*config['"]|require\(['"][./]*config['"]\)/)
    expect(src).not.toMatch(/from ['"][^'"]*\/config['"]/)
  })

  it.each(['production', 'development', 'test', undefined, 'prod'])('NODE_ENV=%s: LN_BTC and LIGHTNING_HODL are refused with 409 RAIL_CLOSED; other rails are open', (nodeEnv) => {
    const saved = process.env.NODE_ENV
    try {
      if (nodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = nodeEnv
      jest.isolateModules(() => {
        const { assertRailOpen } = require('../src/common/day0-closed-rails')
        const code = (fn: () => void) => { try { fn(); return undefined } catch (e) { return { code: (e as any).code, status: (e as any).statusCode } } }
        expect(code(() => assertRailOpen({ asset: 'LN_BTC' }))).toEqual({ code: 'RAIL_CLOSED', status: 409 })
        expect(code(() => assertRailOpen({ escrowType: 'LIGHTNING_HODL' }))).toEqual({ code: 'RAIL_CLOSED', status: 409 })
        expect(code(() => assertRailOpen({ asset: 'SPARK', escrowType: 'LIGHTNING_HODL' }))).toEqual({ code: 'RAIL_CLOSED', status: 409 })
        for (const asset of ['BTC', 'USDT_ERC20', 'LIQUID_BTC', 'SPARK']) expect(code(() => assertRailOpen({ asset }))).toBeUndefined()
        for (const escrowType of ['MULTISIG', 'MOCK', 'SAFE_GUARD_EVM', 'WDK_USDT_EVM']) expect(code(() => assertRailOpen({ escrowType }))).toBeUndefined()
        expect(code(() => assertRailOpen({}))).toBeUndefined()
      })
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = saved
    }
  })

  it('the error names the rail and carries it in details', () => {
    const { RailClosedError } = require('../src/common/day0-closed-rails')
    const e = new RailClosedError({ escrowType: 'LIGHTNING_HODL' })
    expect(e.message).toMatch(/LIGHTNING_HODL/)
    expect(e.details).toEqual([{ escrowType: 'LIGHTNING_HODL' }])
  })
})
