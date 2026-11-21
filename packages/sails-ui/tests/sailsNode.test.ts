import { summarizeNetwork, type NodeView } from '../src/lib/sailsNode'

const n = (id: string, operator?: string, status?: NodeView['status']): NodeView => ({ id, name: id, operator, status })

describe('public network wording (issue #361: no overclaim)', () => {
  it('only the configured node, no status or operator: unknown', () => {
    expect(summarizeNetwork([{ id: 'current', name: 'Automático', current: true }])).toEqual({ known: 1, active: 0, operators: 0, wording: 'unknown' })
  })

  it('one active node of one operator: single', () => {
    expect(summarizeNetwork([n('a', 'Boreal', 'online')]).wording).toBe('single')
  })

  it('several nodes of the same operator are redundancy, not several operators', () => {
    expect(summarizeNetwork([n('a', 'Boreal', 'online'), n('b', ' Boreal ', 'degraded')])).toEqual({ known: 2, active: 2, operators: 1, wording: 'redundant' })
  })

  it('distinct declared operators among active nodes: multiOperator', () => {
    expect(summarizeNetwork([n('a', 'Boreal', 'online'), n('b', 'Kestrel', 'online')]).wording).toBe('multiOperator')
  })

  it('offline nodes and nodes without status do not count as active or as operators', () => {
    const s = summarizeNetwork([n('a', 'Boreal', 'online'), n('b', 'Kestrel', 'offline'), n('c', 'Mediare')])
    expect(s).toEqual({ known: 3, active: 1, operators: 1, wording: 'single' })
  })

  it('an active node without a declared operator makes the wording unknown', () => {
    expect(summarizeNetwork([n('a', 'Boreal', 'online'), n('b', undefined, 'online')]).wording).toBe('unknown')
  })
})
