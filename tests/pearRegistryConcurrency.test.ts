import { PearNode, PearNodeRegistry } from '../src/infrastructure/p2p/pear.service'

describe('PearNodeRegistry lifecycle serialization', () => {
  afterEach(() => jest.restoreAllMocks())

  it('serializes simultaneous starts for one user', async () => {
    let release!: () => void
    const first = new Promise<void>(resolve => { release = resolve })
    let count = 0
    const start = jest.spyOn(PearNode.prototype, 'start').mockImplementation(async () => {
      count++
      if (count === 1) await first
      return 'peer-id'
    })
    const registry = new PearNodeRegistry()
    const a = registry.start('user')
    const b = registry.start('user')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(start).toHaveBeenCalledTimes(1)
    release()
    expect(await Promise.all([a, b])).toEqual(['peer-id', 'peer-id'])
    expect(start).toHaveBeenCalledTimes(2)
    expect(registry.activeCount()).toBe(1)
  })

  it('waits for startup before stopping the same user', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const order: string[] = []
    jest.spyOn(PearNode.prototype, 'start').mockImplementation(async () => {
      order.push('start')
      await pending
      order.push('started')
      return 'peer-id'
    })
    jest.spyOn(PearNode.prototype, 'stop').mockImplementation(async () => {
      order.push('stop')
    })
    const registry = new PearNodeRegistry()
    const starting = registry.start('user')
    const stopping = registry.stop('user')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(order).toEqual(['start'])
    release()
    await Promise.all([starting, stopping])
    expect(order).toEqual(['start', 'started', 'stop'])
    expect(registry.activeCount()).toBe(0)
  })

  it('permits a retry after failed startup', async () => {
    const start = jest.spyOn(PearNode.prototype, 'start')
      .mockRejectedValueOnce(new Error('bootstrap failed'))
      .mockResolvedValueOnce('recovered')
    const registry = new PearNodeRegistry()
    await expect(registry.start('user')).rejects.toThrow('bootstrap failed')
    await expect(registry.start('user')).resolves.toBe('recovered')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('keeps lifecycle queues independent across users', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    jest.spyOn(PearNode.prototype, 'start').mockImplementation(async function (this: PearNode) {
      if (this.getStatus().userId === 'slow') await pending
      return 'peer-id'
    })
    const registry = new PearNodeRegistry()
    const slow = registry.start('slow')
    await expect(registry.start('fast')).resolves.toBe('peer-id')
    release()
    await expect(slow).resolves.toBe('peer-id')
  })
})
