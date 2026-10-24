/**
 * Test-only disposable WebSocket fixture: accepts a connection but responds
 * to application PING with a non-PONG message, then closes. Loopback only.
 * No authentication, no real protocol service, no production use.
 */
const { WebSocketServer } = require('ws')
const server = new WebSocketServer({ host: '127.0.0.1', port: 39871 })
server.on('connection', socket => {
  socket.on('message', () => {
    socket.send(JSON.stringify({ type: 'NOT_PONG', payload: {} }))
    socket.close()
  })
})
server.on('error', () => { process.exitCode = 1 })
process.on('SIGTERM', () => server.close())
