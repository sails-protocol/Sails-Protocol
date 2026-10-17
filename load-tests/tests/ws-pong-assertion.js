import ws from 'k6/ws'
import { check } from 'k6'

/** Protocol-only assertion shared by positive and negative bounded checks. */
export function assertApplicationPong(url) {
  let pong = false
  let appError = false
  let opened = false
  const result = ws.connect(url, {
    tags: { name: 'authenticated_chat_ws' },
  }, socket => {
    socket.on('open', () => {
      opened = true
      socket.send(JSON.stringify({ type: 'PING', payload: {} }))
    })
    socket.on('message', raw => {
      let message
      try { message = JSON.parse(raw) } catch { appError = true; socket.close(); return }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        appError = true; socket.close(); return
      }
      if (message.type === 'PONG') { pong = true; socket.close() }
      else if (message.type === 'ERROR') { appError = true; socket.close() }
    })
    socket.setTimeout(() => { socket.close() }, 15000)
  })
  check({ opened, pong, appError, status: result && result.status }, {
    'WS upgrade: 101': v => v.status === 101,
    'WS opened': v => v.opened,
    'application PONG received': v => v.pong,
    'no application error': v => !v.appError,
  })
  if (!opened || !pong || appError || !result || result.status !== 101) {
    throw new Error('Authenticated WS PONG protocol check failed (details redacted)')
  }
}
