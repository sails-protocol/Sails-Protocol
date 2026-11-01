// #307 — SDK `connectRelay()` READY handshake against a real TCP server.
//
// The server here is scripted on purpose: the real relay never sends a
// malformed or duplicate READY, never stalls forever, and closes on its own
// terms, so the only way to prove the SDK's handling of those cases is a peer
// that does misbehave. Everything is real network I/O (Node http + `ws`), the
// SDK's real transport and fetch. The honest-server path (real ticket, Redis,
// relay route) is proven in tests/integration/relaySdkRealE2E.test.ts.

import http from 'http'
import WebSocket, { WebSocketServer } from 'ws'
import { SailsClient } from '../packages/sails-sdk/src/client'
import { SailsTransportError } from '../packages/sails-sdk/src/errors'

type Script = (ws: WebSocket) => void
const READY = JSON.stringify({ type: 'READY' })

describe('SDK connectRelay() READY handshake (real TCP, scripted server)', () => {
  let server: http.Server
  let wss: WebSocketServer
  let base: string
  let script: Script = () => undefined
  const serverSockets: WebSocket[] = []
  const clients: WebSocket[] = []

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/identity/ws-ticket') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: { ticket: 't', expiresIn: 30 } }))
        return
      }
      res.writeHead(404).end()
    })
    wss = new WebSocketServer({ server, path: '/ws/relay' })
    wss.on('connection', ws => {
      serverSockets.push(ws)
      script(ws)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  })

  afterEach(() => {
    for (const ws of [...clients.splice(0), ...serverSockets.splice(0)]) ws.terminate()
  })

  afterAll(async () => {
    await new Promise(resolve => wss.close(resolve))
    await new Promise(resolve => server.close(resolve))
  })

  const sdk = () => {
    const client = new SailsClient({
      baseUrl: base,
      webSocketImpl: class extends WebSocket {
        constructor(url: string) {
          super(url)
          clients.push(this)
        }
      } as unknown as typeof globalThis.WebSocket,
    })
    client.setSessionToken('session')
    return client
  }

  const handshakeListeners = (ws: WebSocket) =>
    ['message', 'close', 'error'].map(e => ws.listenerCount(e)).reduce((a, b) => a + b, 0)

  const closed = (ws: WebSocket) => new Promise<void>(resolve => {
    if (ws.readyState === WebSocket.CLOSED) return resolve()
    ws.once('close', () => resolve())
  })

  it('resolves on READY, removes its listeners and lets the caller send at once', async () => {
    const received: string[] = []
    script = ws => {
      ws.on('message', data => received.push(data.toString()))
      ws.send(READY)
    }
    const ws = await sdk().peers.connectRelay() as unknown as WebSocket
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(handshakeListeners(ws)).toBe(0)
    ws.send('first-app-frame')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(received).toEqual(['first-app-frame'])
  })

  it('never hands READY to the caller, but delivers every later frame, even a duplicate READY', async () => {
    script = ws => {
      ws.send(READY)
      setTimeout(() => {
        ws.send(READY)
        ws.send('app-data')
      }, 50)
    }
    const ws = await sdk().peers.connectRelay() as unknown as WebSocket
    const seen: string[] = []
    ws.on('message', data => seen.push(data.toString()))
    await new Promise(resolve => setTimeout(resolve, 200))
    // The handshake consumes exactly one frame; what follows is application
    // data the SDK must not swallow or reinterpret.
    expect(seen).toEqual([READY, 'app-data'])
  })

  it('clears its timer on success: the socket survives past timeoutMs', async () => {
    script = ws => ws.send(READY)
    const ws = await sdk().peers.connectRelay({ timeoutMs: 100 }) as unknown as WebSocket
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })

  it('rejects and closes the socket when READY never arrives', async () => {
    script = () => undefined
    await expect(sdk().peers.connectRelay({ timeoutMs: 150 })).rejects.toThrow(
      new SailsTransportError('Relay READY not received within 150ms'),
    )
    const ws = clients[0]
    await closed(ws)
    expect(handshakeListeners(ws)).toBe(0)
  })

  it('rejects with the server reason on ERROR before READY', async () => {
    script = ws => {
      ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'already-used ticket' } }))
      ws.close()
    }
    await expect(sdk().peers.connectRelay()).rejects.toThrow('Relay rejected the connection: already-used ticket')
    expect(handshakeListeners(clients[0])).toBe(0)
  })

  it('rejects when the server closes before READY, reporting code and reason', async () => {
    script = ws => ws.close(1008, 'Relay ticket required')
    await expect(sdk().peers.connectRelay()).rejects.toThrow('Relay closed before READY (1008 Relay ticket required)')
  })

  it.each([
    ['extra field', JSON.stringify({ type: 'READY', participantId: 'x' })],
    ['different type', JSON.stringify({ type: 'READY_' })],
    ['not JSON', 'READY'],
    ['application data first', 'hello'],
  ])('rejects a malformed first frame (%s) and closes the socket', async (_name, frame) => {
    script = ws => ws.send(frame)
    await expect(sdk().peers.connectRelay()).rejects.toThrow('Relay sent an unexpected first frame instead of READY')
    await closed(clients[0])
  })

  it('rejects a binary first frame', async () => {
    script = ws => ws.send(Buffer.from(READY))
    await expect(sdk().peers.connectRelay()).rejects.toThrow('unexpected first frame')
  })

  it('aborts mid-handshake through the caller signal, closing the socket', async () => {
    script = () => undefined
    const controller = new AbortController()
    const pending = sdk().peers.connectRelay({ signal: controller.signal })
    await new Promise<void>(resolve => wss.once('connection', () => resolve()))
    controller.abort()
    await expect(pending).rejects.toThrow('Relay connection aborted')
    await closed(clients[0])
    expect(clients[0].listenerCount('message') + clients[0].listenerCount('close')).toBe(0)
  })

  it('aborting a socket that is still CONNECTING raises no unhandled error', async () => {
    // Regression: closing a CONNECTING `ws` socket emits `error`; with no
    // listener left, Node throws it as unhandled and can crash the caller.
    script = () => undefined
    const controller = new AbortController()
    const pending = sdk().peers.connectRelay({ signal: controller.signal })
    await new Promise<void>(resolve => {
      const poll = () => (clients[0]?.readyState === WebSocket.CONNECTING ? resolve() : setTimeout(poll, 1))
      poll()
    })
    controller.abort()
    await expect(pending).rejects.toThrow('Relay connection aborted')
    await closed(clients[0])
  })

  it('does not open a socket for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(sdk().peers.connectRelay({ signal: controller.signal })).rejects.toThrow('Relay connection aborted')
    expect(clients).toHaveLength(0)
  })
})
