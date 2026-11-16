/**
 * @satsails/p2p-trading-sdk — Sails OpenIdentity module
 *
 * Real Ed25519 challenge-response, matching `src/common/middleware/auth.ts`
 * byte-for-byte — verified by reading that file directly before writing
 * this one, not assumed from `API_REFERENCE.md`'s prose. The subtle part:
 * `auth.ts`'s `verifySignedChallenge()` does not sign the raw 32 random
 * bytes the server generated — it re-encodes the challenge (already a hex
 * *string*) through `Buffer.from(storedChallenge).toString('hex')` before
 * verifying, which is UTF-8-encoding the literal hex *text* and hex-encoding
 * *that* — net effect, the actual signed message is the UTF-8 byte
 * representation of the challenge string itself, not the 32 bytes that
 * string represents. `sign()` below reproduces that exactly
 * (`utf8ToBytes(challenge)`), or authentication would fail against the
 * real server despite looking correct.
 *
 * Uses `tweetnacl` — pure JS, the same package `auth.ts` itself uses
 * server-side (not a different Ed25519 implementation that happens to be
 * compatible), and browser-safe (SDK_GUIDE.md section 6), unlike the
 * reference implementation's other crypto dependency (`sodium-native`,
 * a native Node addon used for P2P payload encryption — infrastructure,
 * not identity, and correctly not something this SDK needs).
 */
import nacl from 'tweetnacl'
import type { SailsTransport } from '../transport'
import type { Participant } from '../types'
import { bytesToHex, hexToBytes, utf8ToBytes } from '../encoding'

/**
 * Missão 11 Fase 9.3.5 — the shape `get()` actually returns. Deliberately
 * NOT `Participant` — that full row (including `reputationScore`/
 * `totalTrades`/`disputeCount`/`totalVolumeBtc`/`createdAt`/`updatedAt`)
 * is only ever returned to an AUTHENTICATED, self-referential caller
 * (`create()`/`createWithPublicKey()`, registering the caller's own
 * identity; `me()`, reading it back). `get(participantId)` is a public
 * lookup of ANY participant, so it returns only what another participant
 * needs to verify/connect: `id` (the participant id itself), `publicKey`
 * (their real cryptographic identity), `peerId` (P2P transport identity),
 * `displayName`, and `verified`. Reputation facts have their own
 * canonical, already-public home — `reputation.get(participantId)` — not
 * duplicated here. See
 * `src/modules/open-identity/identity.service.ts`'s
 * `PublicParticipantIdentity` (the server-side source of this shape).
 */
export interface PublicParticipant {
  id: string
  publicKey: string
  displayName: string | null
  peerId: string | null
  verified: boolean
}

export interface Ed25519Keypair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export interface AuthenticateResult {
  participantId: string
  sessionToken: string
}

export function generateKeypair(): Ed25519Keypair {
  return nacl.sign.keyPair()
}

function sign(challenge: string, secretKey: Uint8Array): string {
  const signature = nacl.sign.detached(utf8ToBytes(challenge), secretKey)
  return bytesToHex(signature)
}

// Issue #302 — registration proof-of-possession. Deliberately a
// SEPARATE construction from sign() above, matching
// `src/common/middleware/auth.ts`'s own domain separation
// (`REGISTRATION_PROOF_DOMAIN`/`registrationProofMessage()`) byte for
// byte: the registration signed message is never the bare challenge
// text the way an AUTHENTICATION signature is — it is always prefixed
// with this literal domain tag and binds the caller's chosen
// `displayName` (empty string when omitted), so a signature produced
// for one domain can never verify against the other's construction.
const REGISTRATION_PROOF_DOMAIN = 'sails-registration-proof-of-possession:v1'

function signRegistrationProof(challenge: string, displayName: string | undefined, secretKey: Uint8Array): string {
  const message = utf8ToBytes(`${REGISTRATION_PROOF_DOMAIN}:${challenge}:${displayName ?? ''}`)
  return bytesToHex(nacl.sign.detached(message, secretKey))
}

export class SailsIdentityModule {
  constructor(private readonly transport: SailsTransport) {}

  /**
   * Registers a new Participant for `keypair` (generates one if omitted —
   * SDK_GUIDE.md section 6: "sane defaults for everything else"). Returns
   * both the registered Participant and the keypair used, since a caller
   * who didn't supply one needs it back to ever authenticate again — the
   * SDK never silently generates and discards key material.
   *
   * Issue #302 — registration now requires proof of possession server-
   * side: this method's own EXTERNAL signature is unchanged (still just
   * `keypair?`/`displayName?` in, `{participant, keypair}` out — no
   * caller of `create()` needs to change anything), but internally it
   * now requests a registration challenge and signs it before
   * submitting, matching `src/common/middleware/auth.ts`'s
   * `verifyRegistrationProof()` byte for byte (see
   * `signRegistrationProof()`'s own header comment above).
   */
  async create(keypair?: Ed25519Keypair, displayName?: string): Promise<{ participant: Participant; keypair: Ed25519Keypair }> {
    const kp = keypair ?? generateKeypair()
    const publicKey = bytesToHex(kp.publicKey)
    const { challenge } = await this.registerChallenge(publicKey)
    const signature = signRegistrationProof(challenge, displayName, kp.secretKey)
    const participant = await this.transport.post<Participant>('/v1/identity/participants', { publicKey, signature, displayName })
    return { participant, keypair: kp }
  }

  /**
   * Issue #302 — registration-challenge issuance for the public key
   * being registered. Deliberately unauthenticated (the participant
   * does not exist yet) and a separate call from `challenge()` below —
   * the two are different security domains server-side (see
   * `src/common/middleware/auth.ts`'s own `REGISTER_CHALLENGE_PREFIX`
   * comment).
   */
  async registerChallenge(publicKeyHex: string): Promise<{ challenge: string; expiresIn: number }> {
    return this.transport.post<{ challenge: string; expiresIn: number }>('/v1/identity/register-challenge', { publicKey: publicKeyHex })
  }

  /**
   * Issue #302 — `createWithPublicKey()` below can no longer register
   * on its own: registration now requires a signature, and that method
   * deliberately has no secret-key or wallet-signing capability at all
   * (its own doc comment's whole point). `createWithWallet()` is the
   * wallet-backed equivalent, mirroring `authenticateWithWallet()`'s
   * existing pattern exactly — delegates signing to
   * `wallet.signMessage()` rather than ever touching a secret key.
   */
  async createWithWallet(publicKeyHex: string, wallet: { signMessage(message: Uint8Array): Promise<Uint8Array> }, displayName?: string): Promise<Participant> {
    const { challenge } = await this.registerChallenge(publicKeyHex)
    const message = utf8ToBytes(`${REGISTRATION_PROOF_DOMAIN}:${challenge}:${displayName ?? ''}`)
    const signatureBytes = await wallet.signMessage(message)
    const signature = bytesToHex(signatureBytes)
    return this.transport.post<Participant>('/v1/identity/participants', { publicKey: publicKeyHex, signature, displayName })
  }

  /**
   * Wallet-backed equivalent of create() — registration only ever needs
   * the public key (see create()'s own body: `kp.secretKey` is never
   * touched), so a wallet-based caller shouldn't need to construct a fake
   * `Ed25519Keypair` with a secret half it doesn't have and never should
   * hand over, just to call this. Closes the same
   * PRODUCTION_READINESS_REVIEW.md finding #3 gap authenticateWithWallet()
   * below closes for the sign-in half of the flow.
   *
   * Issue #302 — registration now requires proof of possession, which
   * this method has no way to produce (no secret key, no wallet
   * parameter — see its own original doc comment above, still true).
   * It can therefore no longer complete registration on its own; the
   * server now rejects it with a clear 401 rather than creating an
   * unauthenticated row. Kept — not removed or silently repurposed,
   * per this SDK's own frozen-public-API discipline — but callers that
   * need to register a wallet-held key must use `createWithWallet()`
   * above instead. Deprecating/removing this method outright is a
   * follow-up decision this mission does not make unilaterally.
   * @deprecated Cannot satisfy Issue #302's proof-of-possession
   * requirement on its own — use `createWithWallet()` instead.
   */
  async createWithPublicKey(publicKeyHex: string, displayName?: string): Promise<Participant> {
    return this.transport.post<Participant>('/v1/identity/participants', { publicKey: publicKeyHex, displayName })
  }

  /**
   * Public lookup, no session required — any participant may look up
   * another's identity facts (publicKey/peerId/displayName/verified) to
   * verify a signature or establish a P2P connection.
   *
   * Missão 11 Fase 9.3.5 — narrowed from `Participant` to
   * `PublicParticipant`: the server no longer returns reputation stats
   * or bookkeeping fields here at all (a privacy-minimization fix, not
   * a client-side filter). Use `reputation.get(participantId)` for
   * reputation facts — that's their canonical source.
   */
  async get(participantId: string): Promise<PublicParticipant> {
    return this.transport.get<PublicParticipant>(`/v1/identity/participants/${participantId}`)
  }

  /** Requires an active session (see authenticate()). */
  async me(): Promise<Participant> {
    return this.transport.get<Participant>('/v1/identity/me', undefined, true)
  }

  async challenge(publicKeyHex: string): Promise<{ challenge: string; expiresIn: number }> {
    return this.transport.post<{ challenge: string; expiresIn: number }>('/v1/identity/challenge', { publicKey: publicKeyHex })
  }

  /**
   * The full challenge-response flow in one call: requests a challenge for
   * `keypair.publicKey`, signs it correctly, submits it, and stores the
   * returned session token on this client's transport so every subsequent
   * authenticated call just works — matching `SailsClient`'s "one typed
   * client" promise (SDK_GUIDE.md section 1) rather than making every
   * caller wire the three HTTP calls together by hand.
   */
  async authenticate(keypair: Ed25519Keypair): Promise<AuthenticateResult> {
    const publicKey = bytesToHex(keypair.publicKey)
    const { challenge } = await this.challenge(publicKey)
    const signature = sign(challenge, keypair.secretKey)
    const result = await this.transport.post<AuthenticateResult>('/v1/identity/authenticate', { publicKey, signature })
    this.transport.setSessionToken(result.sessionToken)
    return result
  }

  /**
   * Wallet-backed equivalent of authenticate() — PRODUCTION_READINESS_REVIEW.md's
   * High-severity finding #3 (client key custody), closed on the SDK side
   * 2026-08-02. Same exact challenge-response wire protocol and the same
   * exact byte encoding `sign()` above reproduces (`utf8ToBytes(challenge)`
   * — see this module's own header comment for why that specific encoding
   * matters), just delegated to `wallet.signMessage()` instead of computing
   * the signature here from a raw secretKey this method never receives or
   * holds. Takes a minimal structural type, not the full `WalletAdapter`
   * interface from `../wallet-adapter` — every other WalletAdapter
   * capability (balances, tx signing, broadcast) is irrelevant to signing
   * in.
   */
  async authenticateWithWallet(publicKeyHex: string, wallet: { signMessage(message: Uint8Array): Promise<Uint8Array> }): Promise<AuthenticateResult> {
    const { challenge } = await this.challenge(publicKeyHex)
    const signatureBytes = await wallet.signMessage(utf8ToBytes(challenge))
    const signature = bytesToHex(signatureBytes)
    const result = await this.transport.post<AuthenticateResult>('/v1/identity/authenticate', { publicKey: publicKeyHex, signature })
    this.transport.setSessionToken(result.sessionToken)
    return result
  }
}

// Re-exported for callers who want to manage key material themselves
// (e.g. a wallet's own secure-storage layer) without going through
// identity.create()'s convenience path.
export { hexToBytes }
