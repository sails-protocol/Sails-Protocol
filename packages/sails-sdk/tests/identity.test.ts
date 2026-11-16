/**
 * SailsIdentityModule — real Ed25519 cryptography (tweetnacl, no mocking
 * of the crypto itself), verified against the exact byte-encoding the
 * reference implementation's own auth.ts uses to check a signature —
 * reproduced inline here rather than imported, since this SDK package is
 * standalone and must not depend on the server's source tree. If this
 * test ever fails after a change to either file, that is a real,
 * user-facing incompatibility, not a false positive.
 */
import nacl from 'tweetnacl'
import { SailsTransport } from '../src/transport'
import { SailsIdentityModule, generateKeypair } from '../src/modules/identity'
import { bytesToHex } from '../src/encoding'

// Reproduces src/common/middleware/auth.ts's verifySignedChallenge() byte
// handling exactly (Buffer.from(challenge).toString('hex') re-encoded,
// i.e. verifying the UTF-8 bytes of the challenge string itself).
function serverVerify(challenge: string, signatureHex: string, publicKeyHex: string): boolean {
  const toBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))
  return nacl.sign.detached.verify(
    toBytes(Buffer.from(challenge).toString('hex')),
    toBytes(signatureHex),
    toBytes(publicKeyHex)
  )
}

// Issue #302 — reproduces src/common/middleware/auth.ts's
// verifyRegistrationProof()/registrationProofMessage() exactly (domain
// tag + challenge + displayName, UTF-8 bytes — a deliberately DIFFERENT
// construction from serverVerify() above, matching the server's own
// domain separation).
const REGISTRATION_PROOF_DOMAIN = 'sails-registration-proof-of-possession:v1'
function registrationServerVerify(challenge: string, displayName: string | undefined, signatureHex: string, publicKeyHex: string): boolean {
  const toBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))
  const message = Uint8Array.from(Buffer.from(`${REGISTRATION_PROOF_DOMAIN}:${challenge}:${displayName ?? ''}`, 'utf8'))
  return nacl.sign.detached.verify(message, toBytes(signatureHex), toBytes(publicKeyHex))
}

function fakeFetch(responses: Array<{ status: number; body: unknown }>): jest.Mock {
  let call = 0
  return jest.fn().mockImplementation(async () => {
    const { status, body } = responses[call++]
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  })
}

describe('SailsIdentityModule.authenticate — real signature verified against server logic', () => {
  it('produces a signature the real server verification accepts', async () => {
    const keypair = generateKeypair()
    const publicKeyHex = bytesToHex(keypair.publicKey)
    const challenge = 'deadbeef'.repeat(8) // 64 hex chars, same shape issueChallenge() produces

    const fetchImpl = fakeFetch([
      { status: 200, body: { success: true, data: { challenge, expiresIn: 120 } } },
      { status: 200, body: { success: true, data: { participantId: 'user-1', sessionToken: 'session-xyz' } } },
    ])
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })
    const identity = new SailsIdentityModule(transport)

    const result = await identity.authenticate(keypair)

    expect(result).toEqual({ participantId: 'user-1', sessionToken: 'session-xyz' })
    // the session token this call received is now set on the transport
    expect(transport.getSessionToken()).toBe('session-xyz')

    // the signature actually sent in the second call must satisfy the
    // real server's verification logic
    const [, secondCallInit] = fetchImpl.mock.calls[1]
    const sentBody = JSON.parse(secondCallInit.body)
    expect(sentBody.publicKey).toBe(publicKeyHex)
    expect(serverVerify(challenge, sentBody.signature, publicKeyHex)).toBe(true)
  })

  it('produces a signature the server rejects for a different public key (not a forgeable token)', async () => {
    const keypair = generateKeypair()
    const otherKeypair = generateKeypair()
    const challenge = 'cafebabe'.repeat(8)

    const fetchImpl = fakeFetch([
      { status: 200, body: { success: true, data: { challenge, expiresIn: 120 } } },
      { status: 200, body: { success: true, data: { participantId: 'user-1', sessionToken: 'session-xyz' } } },
    ])
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })
    const identity = new SailsIdentityModule(transport)

    await identity.authenticate(keypair)
    const [, secondCallInit] = fetchImpl.mock.calls[1]
    const sentBody = JSON.parse(secondCallInit.body)

    // signed with keypair's secret key, so it must NOT verify against a
    // different public key
    expect(serverVerify(challenge, sentBody.signature, bytesToHex(otherKeypair.publicKey))).toBe(false)
  })
})

describe('SailsIdentityModule.create', () => {
  // Issue #302 — create() now performs the real registration-challenge
  // round trip and signs it (registerChallenge() then a domain-separated
  // signature), not a bare { publicKey, displayName } POST. Two fetch
  // calls, in order: register-challenge, then participants.
  it('requests a registration challenge, signs it with the domain-separated construction, and registers a generated keypair when none is supplied', async () => {
    const challenge = 'deadbeef'.repeat(8)
    const fetchImpl = fakeFetch([
      { status: 200, body: { success: true, data: { challenge, expiresIn: 120 } } },
      { status: 201, body: { success: true, data: { id: 'user-1', publicKey: 'will-not-match-generated', displayName: 'Alice' } } },
    ])
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })
    const identity = new SailsIdentityModule(transport)

    const { participant, keypair } = await identity.create(undefined, 'Alice')

    expect(participant.id).toBe('user-1')
    expect(keypair.publicKey).toBeInstanceOf(Uint8Array)
    expect(keypair.secretKey).toBeInstanceOf(Uint8Array)

    const publicKeyHex = bytesToHex(keypair.publicKey)
    const [, challengeInit] = fetchImpl.mock.calls[0]
    expect(JSON.parse(challengeInit.body)).toEqual({ publicKey: publicKeyHex })

    const [, registerInit] = fetchImpl.mock.calls[1]
    const sentBody = JSON.parse(registerInit.body)
    expect(sentBody.publicKey).toBe(publicKeyHex)
    expect(sentBody.displayName).toBe('Alice')
    // the signature actually sent must satisfy the real server's
    // registration-proof verification logic, not just "some string."
    expect(registrationServerVerify(challenge, 'Alice', sentBody.signature, publicKeyHex)).toBe(true)
  })
})

// Issue #302 — createWithPublicKey() below has no way to produce a
// registration proof (no secretKey, no wallet). createWithWallet() is
// the wallet-backed equivalent, mirroring authenticateWithWallet()'s own
// established test rigor (real nacl-backed fake wallet, real signature
// verified against the real server construction).
describe('SailsIdentityModule.createWithWallet — real signature verified against server logic', () => {
  it('produces a registration proof the real server verification accepts, via wallet.signMessage() instead of a raw secretKey', async () => {
    const keypair = generateKeypair()
    const publicKeyHex = bytesToHex(keypair.publicKey)
    const wallet = {
      signMessage: async (message: Uint8Array) => nacl.sign.detached(message, keypair.secretKey),
    }
    const challenge = 'cafebabe'.repeat(8)

    const fetchImpl = fakeFetch([
      { status: 200, body: { success: true, data: { challenge, expiresIn: 120 } } },
      { status: 201, body: { success: true, data: { id: 'user-1', publicKey: publicKeyHex, displayName: 'Wallet User' } } },
    ])
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })
    const identity = new SailsIdentityModule(transport)

    const participant = await identity.createWithWallet(publicKeyHex, wallet, 'Wallet User')

    expect(participant.id).toBe('user-1')

    const [, registerInit] = fetchImpl.mock.calls[1]
    const sentBody = JSON.parse(registerInit.body)
    expect(sentBody.publicKey).toBe(publicKeyHex)
    expect(registrationServerVerify(challenge, 'Wallet User', sentBody.signature, publicKeyHex)).toBe(true)
  })

  it('never receives or needs a secretKey — the signing function is the only thing that ever sees one', async () => {
    const keypair = generateKeypair()
    const publicKeyHex = bytesToHex(keypair.publicKey)
    const signMessage = jest.fn(async (message: Uint8Array) => nacl.sign.detached(message, keypair.secretKey))
    const challenge = 'deadbeef'.repeat(8)

    const fetchImpl = fakeFetch([
      { status: 200, body: { success: true, data: { challenge, expiresIn: 120 } } },
      { status: 201, body: { success: true, data: { id: 'user-1', publicKey: publicKeyHex, displayName: null } } },
    ])
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })
    const identity = new SailsIdentityModule(transport)

    await identity.createWithWallet(publicKeyHex, { signMessage })

    expect(signMessage).toHaveBeenCalledTimes(1)
    // domain-separated construction, not the bare challenge text
    // authenticate()'s own sign() uses.
    expect(Buffer.from(signMessage.mock.calls[0][0]).toString('utf8')).toBe(`${REGISTRATION_PROOF_DOMAIN}:${challenge}:`)
  })
})

// PRODUCTION_READINESS_REVIEW.md's High-severity finding #3 (client key
// custody), closed on the SDK side 2026-08-02 — createWithPublicKey()/
// authenticateWithWallet() let a caller register/sign in without ever
// constructing (or this module ever touching) a raw Ed25519Keypair.
describe('SailsIdentityModule.createWithPublicKey', () => {
  it('registers with just a public key hex — no keypair object, no secretKey anywhere', async () => {
    const fetchImpl = fakeFetch([
      { status: 201, body: { success: true, data: { id: 'user-1', publicKey: 'abc123', displayName: 'Wallet User' } } },
    ])
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })
    const identity = new SailsIdentityModule(transport)

    const participant = await identity.createWithPublicKey('abc123', 'Wallet User')

    expect(participant.id).toBe('user-1')
    const [, init] = fetchImpl.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ publicKey: 'abc123', displayName: 'Wallet User' })
  })
})

describe('SailsIdentityModule.authenticateWithWallet — real signature verified against server logic', () => {
  it('produces a signature the real server verification accepts, via wallet.signMessage() instead of a raw secretKey', async () => {
    // A minimal, real nacl-backed fake wallet — proves the byte encoding
    // authenticateWithWallet() feeds to signMessage() (utf8ToBytes(challenge))
    // is exactly what a real wallet needs to produce a server-verifiable
    // signature, the same rigor the raw authenticate() tests above apply.
    const keypair = generateKeypair()
    const publicKeyHex = bytesToHex(keypair.publicKey)
    const wallet = {
      signMessage: async (message: Uint8Array) => nacl.sign.detached(message, keypair.secretKey),
    }
    const challenge = 'deadbeef'.repeat(8)

    const fetchImpl = fakeFetch([
      { status: 200, body: { success: true, data: { challenge, expiresIn: 120 } } },
      { status: 200, body: { success: true, data: { participantId: 'user-1', sessionToken: 'session-xyz' } } },
    ])
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })
    const identity = new SailsIdentityModule(transport)

    const result = await identity.authenticateWithWallet(publicKeyHex, wallet)

    expect(result).toEqual({ participantId: 'user-1', sessionToken: 'session-xyz' })
    expect(transport.getSessionToken()).toBe('session-xyz')

    const [, secondCallInit] = fetchImpl.mock.calls[1]
    const sentBody = JSON.parse(secondCallInit.body)
    expect(sentBody.publicKey).toBe(publicKeyHex)
    expect(serverVerify(challenge, sentBody.signature, publicKeyHex)).toBe(true)
  })

  it('never receives or needs a secretKey — the signing function is the only thing that ever sees one', async () => {
    const keypair = generateKeypair()
    const publicKeyHex = bytesToHex(keypair.publicKey)
    const signMessage = jest.fn(async (message: Uint8Array) => nacl.sign.detached(message, keypair.secretKey))
    const challenge = 'cafebabe'.repeat(8)

    const fetchImpl = fakeFetch([
      { status: 200, body: { success: true, data: { challenge, expiresIn: 120 } } },
      { status: 200, body: { success: true, data: { participantId: 'user-1', sessionToken: 'session-xyz' } } },
    ])
    const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })
    const identity = new SailsIdentityModule(transport)

    await identity.authenticateWithWallet(publicKeyHex, { signMessage })

    expect(signMessage).toHaveBeenCalledTimes(1)
    // the exact same UTF-8 encoding authenticate()'s own sign() uses —
    // not the raw hex-decoded challenge bytes.
    expect(Buffer.from(signMessage.mock.calls[0][0]).toString('utf8')).toBe(challenge)
  })
})
