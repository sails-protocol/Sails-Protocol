/**
 * F4 gate 3 (CTO Despacho 030): the production boot check for deployment_mode and the admin script. No database: the query is injected.
 * The database side (absence = production, runtime SELECT only, CHECK values) is proven in f4EscrowBindingTriggers / f4RuntimeGrants.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

jest.mock('../src/common/database', () => ({ prisma: { $queryRaw: jest.fn() } }))
jest.mock('../src/config', () => ({ config: { isProduction: false } }))

import { assertNoDeploymentModeInProduction } from '../src/common/database/deployment-mode'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setDeploymentMode, MODES } = require('../scripts/db/set-deployment-mode.js')

const rows = (r: unknown[]) => jest.fn(async () => r) as any

describe('assertNoDeploymentModeInProduction', () => {
  it('production + no row: starts (a production database has no deployment_mode row)', async () => {
    await expect(assertNoDeploymentModeInProduction(true, rows([]))).resolves.toBeUndefined()
  })

  it('production + the row (test OR development): REFUSES to start and says why', async () => {
    for (const mode of ['test', 'development']) {
      await expect(assertNoDeploymentModeInProduction(true, rows([{ mode, created_by: 'postgres' }]))).rejects.toThrow(/Refusing to start in production: deployment_mode has a row/)
    }
  })

  it('not production: never queries, whatever the row (development and test databases carry it)', async () => {
    const q = rows([{ mode: 'test', created_by: 'postgres' }])
    await expect(assertNoDeploymentModeInProduction(false, q)).resolves.toBeUndefined()
    expect(q).not.toHaveBeenCalled()
  })

  it('startServer wires the check right after the privilege assertion (a check nobody calls protects nothing)', () => {
    const app = readFileSync(join(__dirname, '..', 'src', 'app.ts'), 'utf8')
    expect(app).toMatch(/await assertRuntimeDatabasePrivileges\(\)\n[^\n]*\n\s*await assertNoDeploymentModeInProduction\(\)/)
  })
})

describe('scripts/db/set-deployment-mode.js', () => {
  it('only development and test exist: "production" and anything else is refused BEFORE touching the database', async () => {
    expect(MODES).toEqual(['development', 'test'])
    const client = { query: jest.fn() }
    for (const bad of ['production', 'prod', '', undefined]) await expect(setDeploymentMode(client, bad)).rejects.toThrow(/there is no 'production' value/)
    expect(client.query).not.toHaveBeenCalled()
  })

  it('a valid mode writes inside one transaction and replaces a different existing row', async () => {
    const calls: string[] = []
    const client = { query: jest.fn(async (sql: string) => { calls.push(sql); return {} }) }
    await setDeploymentMode(client, 'test')
    expect(calls[0]).toBe('BEGIN')
    expect(calls.some((c) => c.startsWith('DELETE FROM deployment_mode WHERE mode <>'))).toBe(true)
    expect(calls.some((c) => c.startsWith('INSERT INTO deployment_mode'))).toBe(true)
    expect(calls[calls.length - 1]).toBe('COMMIT')
  })
})
