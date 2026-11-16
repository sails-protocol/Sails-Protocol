/**
 * Ed25519 Auth Middleware — fixes RED_TEAM_REVIEW.md RT-002 and the #1
 * item in TODO.md §3. Before this file existed, every route accepted a
 * raw `userId` in the request body with zero proof the caller controlled
 * that identity's keypair. This is the actual fix, not just the flag.
 *
 * Flow (challenge-response, PROTOCOL_SPECIFICATION.md §1.1's IdentityProof):
 *   1. Client requests a challenge for their claimed publicKey
 *   2. Server issues a random nonce, stored in Redis with a short TTL
 *   3. Client signs the nonce with their Ed25519 secret key
 *   4. Client sends { publicKey, signature } on every subsequent request
 *   5. This middleware verifies the signature against a per-request nonce
 *      header — never trusts a bare userId again
 */
import nacl from 'tweetnacl'
import { randomBytes } from 'crypto'
import type { FastifyRequest } from 'fastify'
import { redis } from '../redis'
import { atomicCompareAndConsume } from '../redis/atomic-consume'
import { prisma } from '../database'
import { config } from '../../config'
import { AuthError } from '../errors'

/**
 * Typed request object for authenticated routes. Every route that uses
 * requireAuth can cast to this type to get type-safe access to participantId
 * without resorting to `(request as any).participantId`.
 */
export interface AuthenticatedRequest extends FastifyRequest {
  participantId: string
}

const CHALLENGE_PREFIX = 'auth:challenge:'
const SESSION_PREFIX = 'auth:session:'
const WS_TICKET_PREFIX = 'auth:ws-ticket:'
// Issue #302 — deliberately a SEPARATE Redis key namespace from
// CHALLENGE_PREFIX above: a registration challenge and an
// authentication challenge for the same public key must never be able
// to collide, be confused for one another, or have one flow's issuance
// overwrite the other's in-flight value.
const REGISTER_CHALLENGE_PREFIX = 'identity:register-challenge:'
// Issue #302 — domain separation (required by the mission's own §8):
// the registration proof's signed message is NEVER the bare challenge
// text the way AUTH's own construction is (see verifySignedChallenge()
// below, unchanged) — it is always prefixed with this literal domain
// tag. A signature produced for one domain can never verify
// successfully against the other domain's construction, even in the
// (already implausible — each is independently 32 random bytes)
// scenario where the same raw challenge value were ever issued in both
// namespaces at once.
const REGISTRATION_PROOF_DOMAIN = 'sails-registration-proof-of-possession:v1'

function toBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'))
}

/**
 * Step 1-2: issue a challenge. Called by POST /v1/identity/challenge.
 */
export async function issueChallenge(publicKeyHex: string): Promise<{ challenge: string; expiresIn: number }> {
  const challenge = randomBytes(32).toString('hex')
  await redis.set(
    `${CHALLENGE_PREFIX}${publicKeyHex}`,
    challenge,
    'EX',
    config.auth.challengeTtlSeconds
  )
  return { challenge, expiresIn: config.auth.challengeTtlSeconds }
}

/**
 * Step 4-5 core logic: verify a signature against the previously-issued
 * challenge for this publicKey.
 *
 * Issue #301 — one-time use is enforced by an ATOMIC compare-and-consume
 * (`atomicCompareAndConsume()`), not a separate `GET` + `DEL`. The plain
 * `redis.get()` below is only an OBSERVATION used to verify the
 * signature against — it is never itself the consuming operation, and
 * crucially it runs BEFORE any deletion, so an invalid signature never
 * reaches (and therefore never burns) the stored challenge. Only after
 * the signature verifies does this atomically claim the EXACT observed
 * challenge value: two concurrent replays of the same captured
 * (challenge, signature) pair both observe the same challenge and both
 * verify successfully, but the atomic claim has exactly one winner —
 * the loser's claim finds the value already gone (or, if a fresh
 * replacement challenge was issued in between, finds a DIFFERENT
 * current value) and fails closed, never deleting anything.
 */
export async function verifySignedChallenge(
  publicKeyHex: string,
  signatureHex: string
): Promise<{ verified: boolean; participantId?: string; sessionToken?: string; reason?: string }> {
  const challengeKey = `${CHALLENGE_PREFIX}${publicKeyHex}`
  const storedChallenge = await redis.get(challengeKey)
  if (!storedChallenge) {
    return { verified: false, reason: 'No challenge issued, or it expired — request a new one' }
  }

  let sigValid = false
  try {
    sigValid = nacl.sign.detached.verify(
      toBytes(Buffer.from(storedChallenge).toString('hex')),
      toBytes(signatureHex),
      toBytes(publicKeyHex)
    )
  } catch {
    return { verified: false, reason: 'Malformed signature or public key encoding' }
  }

  if (!sigValid) {
    return { verified: false, reason: 'Signature does not match challenge for this public key' }
  }

  // Atomic claim of the EXACT challenge this signature was verified
  // against — see this function's own header comment above for why
  // this must be compare-and-consume, not a blind delete. `false` means
  // this call lost the race (a concurrent request already consumed it)
  // or the challenge was replaced by a newer one since it was observed
  // — either way, fail closed: no session is minted.
  const claimed = await atomicCompareAndConsume(challengeKey, storedChallenge)
  if (!claimed) {
    return { verified: false, reason: 'Challenge already consumed or replaced — request a new one' }
  }

  const user = await prisma.user.findUnique({ where: { publicKey: publicKeyHex } })
  if (!user) {
    return { verified: false, reason: 'No participant registered for this public key — call /v1/identity/participants first' }
  }

  // Issue a short-lived session token bound to this participantId — every
  // subsequent request in this window is authenticated via the session,
  // not by re-signing every call.
  const sessionToken = randomBytes(32).toString('hex')
  await redis.set(
    `${SESSION_PREFIX}${sessionToken}`,
    user.id,
    'EX',
    config.auth.sessionTtlSeconds
  )

  // Bug fix (found while wiring identity.routes.ts): this function
  // generated and stored sessionToken above but never returned it, so a
  // caller had no way to learn the bearer token requireAuth() expects on
  // every subsequent request — the challenge-response flow was unusable
  // end-to-end despite verifying correctly.
  return { verified: true, participantId: user.id, sessionToken }
}

/**
 * Issue #302 — registration-challenge issuance. Deliberately
 * unauthenticated (the participant does not exist yet — there is
 * nothing to authenticate against), and deliberately a SEPARATE
 * function/namespace from issueChallenge() above rather than a
 * `purpose` flag on the same one: the two are different SECURITY
 * DOMAINS (see REGISTRATION_PROOF_DOMAIN's own comment), and keeping
 * them as textually distinct functions makes that impossible to blur
 * by accident at a future call site.
 */
export async function issueRegistrationChallenge(publicKeyHex: string): Promise<{ challenge: string; expiresIn: number }> {
  const challenge = randomBytes(32).toString('hex')
  await redis.set(
    `${REGISTER_CHALLENGE_PREFIX}${publicKeyHex}`,
    challenge,
    'EX',
    config.auth.challengeTtlSeconds
  )
  return { challenge, expiresIn: config.auth.challengeTtlSeconds }
}

// Issue #302 §7 (metadata binding) — the registration signed message
// binds the OBSERVED challenge AND the caller's chosen `displayName`
// (empty string when omitted, so the message shape is always
// well-defined and unambiguous — this function never needs to be
// "parsed back apart," only reconstructed server-side from known
// inputs and compared byte-for-byte against what the signature covers,
// so embedded `:` characters in displayName create no parsing
// ambiguity). Chosen deliberately, not left implicit: binding
// displayName means an on-path party who does not hold the private key
// (a proxy, a confused relay, a MITM between signing and submission)
// cannot alter the displayName a legitimate registrant actually signed
// without invalidating the signature. It does NOT, by itself, decide
// the outcome of two DIFFERENT key-holders' concurrent registration
// attempts with different displayNames for the same challenge — that
// race is decided entirely by which caller's atomicCompareAndConsume()
// call wins the shared, single-observed challenge (see
// verifyRegistrationProof() below); a caller whose own (displayName,
// signature) pair is fully self-consistent still loses if another
// caller's atomic claim on the challenge lands first.
// Exported (not module-private) — the exact byte construction is a
// single source of truth reused by real callers that need to PRODUCE a
// valid registration signature (the SDK's own identity module, this
// repo's own demo/rehearsal scripts, and this mission's own test
// suite) as well as by verifyRegistrationProof() below, which needs to
// RECONSTRUCT and compare against it. Duplicating this string
// construction at each call site would risk silent drift between
// "what a real signer signs" and "what the server verifies."
export function registrationProofMessage(challenge: string, displayName?: string): Uint8Array {
  return new Uint8Array(Buffer.from(`${REGISTRATION_PROOF_DOMAIN}:${challenge}:${displayName ?? ''}`, 'utf8'))
}

/**
 * Issue #302 — verifies proof of possession of `publicKeyHex` for
 * registration, reusing #301's exact atomic compare-and-consume
 * primitive and the exact same ordering discipline
 * verifySignedChallenge() above already established: the plain
 * `redis.get()` below is only an OBSERVATION used to verify the
 * signature against, never itself the consuming operation, and it runs
 * BEFORE any deletion — an invalid signature never reaches (and
 * therefore never burns) the stored challenge. Only after the
 * signature verifies does this atomically claim the EXACT observed
 * challenge value, which is what gives this function the same three
 * properties verifySignedChallenge() has: (1) N concurrent replays of
 * the same captured (challenge, signature, displayName) all verify
 * successfully, but the atomic claim has exactly one winner; (2) an
 * invalid signature can never burn a legitimate holder's outstanding
 * challenge; (3) a stale caller holding an old, already-replaced
 * challenge value fails the comparison and can never delete a newer
 * one it never actually proved possession of.
 *
 * Deliberately returns ONLY a verified/reason result — no User lookup,
 * no session minting, no database write. Creating the canonical User
 * row (and enforcing the database-uniqueness backstop independently of
 * this Redis-level property) stays identity.service.ts's own
 * responsibility, exactly the same module-boundary split
 * verifySignedChallenge() vs. identityService.getParticipant() already
 * establishes.
 */
export async function verifyRegistrationProof(
  publicKeyHex: string,
  signatureHex: string,
  displayName?: string
): Promise<{ verified: boolean; reason?: string }> {
  const challengeKey = `${REGISTER_CHALLENGE_PREFIX}${publicKeyHex}`
  const storedChallenge = await redis.get(challengeKey)
  if (!storedChallenge) {
    return { verified: false, reason: 'No registration challenge issued, or it expired — request a new one' }
  }

  let sigValid = false
  try {
    sigValid = nacl.sign.detached.verify(
      registrationProofMessage(storedChallenge, displayName),
      toBytes(signatureHex),
      toBytes(publicKeyHex)
    )
  } catch {
    return { verified: false, reason: 'Malformed signature or public key encoding' }
  }

  if (!sigValid) {
    return { verified: false, reason: 'Signature does not match the registration challenge/metadata for this public key' }
  }

  const claimed = await atomicCompareAndConsume(challengeKey, storedChallenge)
  if (!claimed) {
    return { verified: false, reason: 'Registration challenge already consumed or replaced — request a new one' }
  }

  return { verified: true }
}

/**
 * Security review finding, 2026-08-15 (P1): chat.routes.ts/relay.routes.ts's
 * WS upgrade routes authenticated via `?token=<raw session token>` — a
 * browser WS handshake can't set an Authorization header the way
 * requireAuth expects, but a raw session token is long-lived (1h
 * default) and reusable, so putting it in a URL meant it could leak
 * into proxy/load-balancer/observability logs (pino's own request-log
 * redact only masks named object fields — 'token' — never a substring
 * embedded inside req.url). Called from a new authenticated HTTP
 * endpoint (POST /v1/identity/ws-ticket) — the caller already proved
 * who they are via the Bearer session token on that call; this mints a
 * short-lived, single-use value instead, so even a captured ticket is
 * worthless within `wsTicketTtlSeconds` and can never be replayed a
 * second time regardless. Resolution + one-time burn lives in
 * ws-auth.ts's resolveParticipantFromTicket().
 */
export async function issueWsTicket(participantId: string): Promise<{ ticket: string; expiresIn: number }> {
  const ticket = randomBytes(32).toString('hex')
  await redis.set(
    `${WS_TICKET_PREFIX}${ticket}`,
    participantId,
    'EX',
    config.auth.wsTicketTtlSeconds
  )
  return { ticket, expiresIn: config.auth.wsTicketTtlSeconds }
}

/**
 * Fastify preHandler — attaches request.participantId, or throws AuthError.
 * This is what every route restored from TODO.md must use — a route
 * that reads `req.body.userId` directly instead of `req.participantId`
 * set by this middleware is exactly the RT-002 vulnerability again.
 */
export async function requireAuth(req: FastifyRequest, _reply: any): Promise<void> {
  const token = req.headers['authorization']?.replace(/^Bearer\s+/i, '')
  if (!token) {
    throw new AuthError('Missing Authorization header')
  }

  const participantId = await redis.get(`${SESSION_PREFIX}${token}`)
  if (!participantId) {
    throw new AuthError('Session expired or invalid — re-authenticate via /v1/identity/challenge')
  }

  ;(req as AuthenticatedRequest).participantId = participantId
}
