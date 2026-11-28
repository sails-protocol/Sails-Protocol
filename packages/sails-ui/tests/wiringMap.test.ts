import { LOOSE_WIRES, type LooseWireId } from '../src/lib/looseWires'
import { WIRE_META, WIRE_STATUS_LABEL, plannedBadge, wireCounts } from '../src/lib/wiringMap'

const IDS = Object.keys(LOOSE_WIRES) as LooseWireId[]

describe('wiring map', () => {
  it('has exactly one entry per loose wire, each with where, owner and a contract', () => {
    expect(Object.keys(WIRE_META).sort()).toEqual([...IDS].sort())
    for (const id of IDS) {
      expect(WIRE_META[id].where.length).toBeGreaterThan(5)
      expect(WIRE_META[id].owner.length).toBeGreaterThan(1)
      expect(LOOSE_WIRES[id].contract.length).toBeGreaterThan(20)
    }
  })

  it('counts add up and use the PO labels', () => {
    const c = wireCounts()
    expect(c.wired + c.simulated + c.outOfDay0 + c.notice).toBe(IDS.length)
    expect(WIRE_STATUS_LABEL).toMatchObject({ wired: 'Ligado ao backend', simulated: 'Simulado na demonstração', outOfDay0: 'Fora do Day 0 (decisão do CTO)' })
  })

  it('real secrets and money outside the app are never simulated', () => {
    for (const id of ['satsailsWallet', 'walletConnect', 'defaultReceiveAddress', 'keyBackup'] as const) {
      expect(WIRE_META[id].status).toBe('notice')
      expect(WIRE_META[id].simulatedInDemo).toBe(false)
    }
  })

  it('CTO 33 Day 0 items are simulated in the demo; the space purchase stays out of Day 0', () => {
    for (const id of ['marketGroupChat', 'marketDirectMessage', 'marketVerification', 'managedNode'] as const) expect(WIRE_META[id].status).toBe('simulated')
    expect(WIRE_META.spacePurchase.status).toBe('outOfDay0')
  })

  it('in the demo a simulated wire never shows an unexplained "Em breve"; real mode always does', () => {
    for (const id of IDS) {
      expect(plannedBadge(id, false)).toBe('soon')
      if (WIRE_META[id].simulatedInDemo) expect(plannedBadge(id, true)).toBe('simulated')
    }
  })
})

describe('demo simulation guard: planned spots route through the wiring map', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('path') as typeof import('path')
  const code = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8')
  it('WirePlanned and WireNote pick "Simulado" through plannedBadge', () => {
    expect(code('pages/markets/shared.tsx')).toMatch(/plannedBadge\(id, isDemoMode\(\)\)/)
    expect(code('pages/markets/shared.tsx')).toMatch(/plannedBadge\(id, demo\)/)
  })
  it('Settings planned rows render the demo simulation (or the honest notice) before "Em breve"', () => {
    expect(code('pages/Settings.tsx')).toMatch(/isDemoMode\(\) \? <SimulatedSettingRow id=\{id\}/)
    expect(code('components/settings/SimulatedSettings.tsx')).toMatch(/meta\.status === 'notice'/)
  })
})
