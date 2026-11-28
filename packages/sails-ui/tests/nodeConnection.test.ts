import {
  getNodeConnectionStatus, recordNodeFailure, recordNodeResponse, resetNodeConnection, subscribeNodeConnection,
} from '../src/lib/nodeConnection'

// Same shape as the fetchImpl wrapper in src/lib/sailsClient.ts (which needs Vite's import.meta and the SDK).
async function tracked(fetchFn: () => Promise<{ status: number }>) {
  let response
  try {
    response = await fetchFn()
  } catch (error) {
    recordNodeFailure(error)
    throw error
  }
  recordNodeResponse()
  return response
}

describe('nodeConnection', () => {
  beforeEach(() => resetNodeConnection())

  it('starts unknown', () => {
    expect(getNodeConnectionStatus()).toBe('unknown')
  })

  it('any HTTP response is online, 4xx and 5xx included', async () => {
    for (const status of [200, 404, 401, 500, 503]) {
      resetNodeConnection()
      await tracked(async () => ({ status }))
      expect(getNodeConnectionStatus()).toBe('online')
    }
  })

  it('a rejected fetch is unreachable', async () => {
    await expect(tracked(async () => { throw new TypeError('Failed to fetch') })).rejects.toThrow('Failed to fetch')
    expect(getNodeConnectionStatus()).toBe('unreachable')
  })

  it('a timeout is unreachable', () => {
    recordNodeFailure(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }))
    expect(getNodeConnectionStatus()).toBe('unreachable')
  })

  it('an abort by the app changes nothing', () => {
    recordNodeResponse()
    recordNodeFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    expect(getNodeConnectionStatus()).toBe('online')
  })

  it('recovers to online after a later response', async () => {
    await tracked(async () => { throw new TypeError('Failed to fetch') }).catch(() => undefined)
    expect(getNodeConnectionStatus()).toBe('unreachable')
    await tracked(async () => ({ status: 500 }))
    expect(getNodeConnectionStatus()).toBe('online')
  })

  it('notifies only on change, and stops after unsubscribe', () => {
    const listener = jest.fn()
    const unsubscribe = subscribeNodeConnection(listener)
    recordNodeResponse()
    recordNodeResponse()
    expect(listener).toHaveBeenCalledTimes(1)
    recordNodeFailure(new TypeError('Failed to fetch'))
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    recordNodeResponse()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
