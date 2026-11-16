// tests/integration/identityTestHelpers.ts
//
// Issue #302 — canonical registration now requires proof of possession
// (a real Ed25519 signature over a real registration challenge — see
// src/modules/open-identity/identity.service.ts's register() and
// src/common/middleware/auth.ts's verifyRegistrationProof()). Every
// real-Postgres integration test in this directory that previously
// called `identityService.register({ publicKey: 'some-fake-string',
// displayName })` with an arbitrary, non-Ed25519 placeholder purely to
// get a `User.id` for driving the rest of its own flow (escrow, dispute,
// multisig, offer/intent, ...) can no longer do that — there is no
// private key behind a fake string, so no proof can be produced for it.
//
// This is the single shared helper every such call site now goes
// through: generates a real, throwaway Ed25519 keypair, performs the
// real challenge-request -> sign -> submit protocol against the real
// (unmocked) auth.ts + identityService, and returns the created
// Participant. Centralizing this avoids hand-duplicating the same
// crypto flow across nine call sites with a chance of silent drift.
import nacl from 'tweetnacl'

export async function registerTestParticipant(
  identityService: { register(input: { publicKey: string; signature: string; displayName?: string }): Promise<{ id: string; publicKey: string }> },
  displayName?: string
): Promise<{ id: string; publicKey: string }> {
  // Lazily required — common/middleware/auth.ts touches redis/config at
  // module scope, same discipline every caller of this helper already
  // applies to identityService/liquidityRouter/etc. in its own
  // beforeAll() (required only after the real-DB availability probe).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { issueRegistrationChallenge, registrationProofMessage } = require('../../src/common/middleware/auth')
  const keypair = nacl.sign.keyPair()
  const publicKey = Buffer.from(keypair.publicKey).toString('hex')
  const { challenge } = await issueRegistrationChallenge(publicKey)
  const signature = Buffer.from(
    nacl.sign.detached(registrationProofMessage(challenge, displayName), keypair.secretKey)
  ).toString('hex')
  return identityService.register({ publicKey, signature, displayName })
}

// Root cause of Jest failing to exit: registerTestParticipant() loads
// src/common/middleware/auth.ts, which imports the application's shared
// ioredis singleton (src/common/redis) — opened at import, never closed
// by any test. Every file that uses the helper must call this in afterAll.
export async function closeTestRedis(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { redis } = require('../../src/common/redis')
  if (redis.status !== 'end') await redis.quit().catch(() => redis.disconnect())
}

// jest.resetModules() (used by "simulated restart" tests) rebuilds the whole
// module graph, and with it a NEW ioredis singleton each time; the old ones
// could never be closed and kept Jest alive. Call this right before a
// resetModules(): every fresh graph then reuses the SAME Redis client, so
// one closeTestRedis() in afterAll closes it, and code still holding
// pre-reset service references keeps working.
export function preserveTestRedis(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const original = require('../../src/common/redis')
  jest.doMock('../../src/common/redis', () => original)
}
