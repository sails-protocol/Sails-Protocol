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

  it('CTO roadmap items stay out of Day 0 (simulated only in the demo)', () => {
    for (const id of ['marketGroupChat', 'marketVerification', 'managedNode', 'spacePurchase'] as const) expect(WIRE_META[id].status).toBe('outOfDay0')
  })

  it('in the demo a simulated wire never shows an unexplained "Em breve"; real mode always does', () => {
    for (const id of IDS) {
      expect(plannedBadge(id, false)).toBe('soon')
      if (WIRE_META[id].simulatedInDemo) expect(plannedBadge(id, true)).toBe('simulated')
    }
  })
})
