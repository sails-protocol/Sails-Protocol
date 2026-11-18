// CTO 429 experiment: tests/setup/closedExplorerDefault.ts (Jest setupFiles). Proves it only fills an ABSENT value,
// that the default reaches the config and child processes, and that it does not mask a real explorer failure: an
// unmocked read through the real provider code fails fast and loudly instead of waiting on (or succeeding against)
// the public explorer.
import { spawnSync } from 'child_process'
import { CLOSED_EXPLORER_DEFAULT } from './setup/closedExplorerDefault'

const SETUP = './setup/closedExplorerDefault'
const KEY = 'MULTISIG_EXPLORER_API_URL'

describe('Jest setup: closed explorer default (CTO 429)', () => {
  const original = process.env[KEY]
  afterEach(() => {
    if (original === undefined) delete process.env[KEY]
    else process.env[KEY] = original
    jest.resetModules()
  })

  it('fills the variable only when it is absent', () => {
    delete process.env[KEY]
    jest.isolateModules(() => { require(SETUP) })
    expect(process.env[KEY]).toBe(CLOSED_EXPLORER_DEFAULT)
  })

  it.each([
    ['an explicit test/workflow URL', 'https://explorer.example/api'],
    ['an explicit empty value', ''],
  ])('never overrides %s', (_label, value) => {
    process.env[KEY] = value
    jest.isolateModules(() => { require(SETUP) })
    expect(process.env[KEY]).toBe(value)
  })

  it('is what the config reads when nothing else sets it', () => {
    delete process.env[KEY]
    jest.isolateModules(() => {
      require(SETUP)
      expect(require('../src/config').config.multisig.explorerApiUrl).toBe(CLOSED_EXPLORER_DEFAULT)
    })
  })

  it('reaches a child process spawned with the test env, as every spawn site in tests/ does', () => {
    delete process.env[KEY]
    jest.isolateModules(() => { require(SETUP) })
    const child = spawnSync(process.execPath, ['-e', `process.stdout.write(process.env.${KEY} ?? 'UNSET')`], { env: process.env, encoding: 'utf8' })
    expect(child.stdout).toBe(CLOSED_EXPLORER_DEFAULT)
  })

  it('negative: an unmocked explorer read fails fast and visibly (refused), never a silent success or a long wait', async () => {
    delete process.env[KEY]
    await jest.isolateModulesAsync(async () => {
      require(SETUP)
      const { fetchOutpointSpendStatus } = require('../src/modules/open-settlement/multisig.provider')
      const started = Date.now()
      await expect(fetchOutpointSpendStatus('00'.repeat(32), 0)).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(5000) // the 8 s explorer timeout is never reached
    })
  })
})
