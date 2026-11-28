// tests/integration/timestampAnchor.test.ts
//
// OpenTimestampsAnchor (RFC-008 D1, closed 2026-08-04).
//
// The default lane exercises the real OpenTimestampsAnchor code against a LOCAL stub of the calendar's wire format
// (POST <calendar>/digest, Content-Type application/vnd.opentimestamps.v1, 32-byte body, proof bytes in the response),
// so CI never depends on a public server. The one test that talks to the real public calendar is opt-in:
//   RUN_NETWORK_TESTS=1 npx jest tests/integration/timestampAnchor.test.ts

import { createHash } from 'crypto'
import { createServer, IncomingMessage, Server } from 'http'
import { AddressInfo } from 'net'
import { OpenTimestampsAnchor } from '../../src/modules/open-proof/timestamp-anchor'

const PROOF_BYTES = Buffer.alloc(137, 7) // the order of magnitude observed from the live calendar for one digest

describe('OpenTimestampsAnchor (RFC-008 D1, local calendar stub)', () => {
  let server: Server
  let calendarUrl: string
  let seen: { method?: string; url?: string; contentType?: string; body: Buffer } | undefined
  let nextStatus = 200

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        seen = { method: req.method, url: req.url, contentType: req.headers['content-type'], body: Buffer.concat(chunks) }
        res.statusCode = nextStatus
        res.end(nextStatus === 200 ? PROOF_BYTES : 'calendar error')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    calendarUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    seen = undefined
    nextStatus = 200
  })

  it('anchor() posts the 32-byte digest in the calendar wire format and returns the pending proof blob', async () => {
    const digestHex = createHash('sha256').update('sails-protocol-test').digest('hex')

    const proof = await new OpenTimestampsAnchor(calendarUrl).anchor(digestHex)

    expect(seen?.method).toBe('POST')
    expect(seen?.url).toBe('/digest')
    expect(seen?.contentType).toBe('application/vnd.opentimestamps.v1')
    expect(seen?.body.toString('hex')).toBe(digestHex)
    expect(proof.anchorType).toBe('opentimestamps')
    expect(proof.upgraded).toBe(false)
    expect(typeof proof.submittedAt).toBe('string')
    expect(Buffer.from(proof.anchorId, 'base64').equals(PROOF_BYTES)).toBe(true)
  })

  it('anchor() refuses to fabricate an anchor when the calendar answers with an error status', async () => {
    nextStatus = 503
    const digestHex = createHash('sha256').update('sails-protocol-test').digest('hex')

    await expect(new OpenTimestampsAnchor(calendarUrl).anchor(digestHex)).rejects.toThrow(/returned 503/)
  })

  it('anchor() rejects a malformed digest before ever making a network call', async () => {
    await expect(new OpenTimestampsAnchor(calendarUrl).anchor('not-a-real-digest')).rejects.toThrow(/32-byte SHA-256 digest/)
    expect(seen).toBeUndefined()
  })

  it('upgrade() throws a specific, honest error — verification is real, disclosed unbuilt scope', async () => {
    const anchor = new OpenTimestampsAnchor(calendarUrl)
    await expect(
      anchor.upgrade({ anchorType: 'opentimestamps', anchorId: 'x', submittedAt: new Date().toISOString(), upgraded: false })
    ).rejects.toThrow(/not implemented/)
  })
})

// Real round-trip against the public calendar: opt-in only (RUN_NETWORK_TESTS=1), never part of the default lane.
const describeNetwork = process.env.RUN_NETWORK_TESTS === '1' ? describe : describe.skip

describeNetwork('OpenTimestampsAnchor (RFC-008 D1, real public calendar server, opt-in)', () => {
  jest.setTimeout(20_000)

  it('anchor() submits a real digest and gets back a real, non-trivial proof blob', async () => {
    const digestHex = createHash('sha256').update(`sails-protocol-test-${Date.now()}`).digest('hex')

    const proof = await new OpenTimestampsAnchor().anchor(digestHex)

    expect(proof.anchorType).toBe('opentimestamps')
    expect(proof.upgraded).toBe(false)
    expect(Buffer.from(proof.anchorId, 'base64').length).toBeGreaterThan(50)
  })
})
