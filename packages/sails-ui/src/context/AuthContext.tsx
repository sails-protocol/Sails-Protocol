/**
 * Real session state — @satsails/p2p-trading-sdk's `identity.create()`/`authenticate()`
 * (real Ed25519 challenge-response, packages/sails-sdk/src/modules/
 * identity.ts), replacing the previous localStorage-mocked CURRENT_USER.
 *
 * Demo-only shortcut, disclosed rather than hidden: this reference UI
 * generates and stores the Ed25519 secret key in the browser's own
 * localStorage so "Conectar Carteira" has something to sign with without
 * a real external wallet extension. A real wallet integration keeps that
 * key in the wallet's own secure storage/hardware and never lets a page
 * touch it — see CRYPTOGRAPHIC_MODEL.md. This is a demonstration of the
 * protocol's real auth flow, not a template for production key custody.
 *
 * Encrypted at rest since 2026-08-11 (real gap flagged live: the secret
 * key sat in localStorage as plain hex, readable by anything that can
 * run JS on this origin — an XSS, a malicious extension, anyone with
 * browser-profile access). `login()` now takes the user's own passphrase,
 * used to derive a non-extractable AES-256-GCM key (lib/keyEncryption.ts)
 * that encrypts the stored keypair. This does NOT close the "active XSS
 * during an unlocked session" case — a script running while the key is
 * decrypted in memory can still read it, same as any browser-based
 * signer. What it closes is passive exposure: reading localStorage alone
 * is no longer enough. A real fix (external wallet) is still the only
 * complete answer — see the paragraph above.
 *
 * To demo two counterparties trading with each other, use two separate
 * browser sessions (e.g. a normal window + an incognito window) — this
 * key/session storage is per-origin, shared across tabs in the same
 * browser profile, same as any localStorage-backed session.
 *
 * `isOperator`/`toggleRole` removed 2026-08-04 — a self-assigned,
 * localStorage-toggled "operator" role had no real backend counterpart
 * (Sails' authorization model has no platform-operator/admin tier at
 * all, by design: every real read stays scoped to the calling
 * participant or a genuine assigned role like `Dispute.arbiterId`). It
 * gated a nav link to `pages/admin/Dashboard.tsx`/`ManageOffers.tsx`,
 * both deleted the same day for the same reason — see
 * feedback_no_platform_operator_visibility (memory) for the full
 * non-custodial reasoning.
 */
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { generateKeypair, LocalKeypairWalletAdapter, type Ed25519Keypair, type WalletAdapter, type SailsAuthError } from '@satsails/p2p-trading-sdk'
import type { User } from '../types'
import { sailsClient } from '../lib/sailsClient'
import { deriveKeyFromPassphrase, encryptBytes, decryptBytes } from '../lib/keyEncryption'
import { WrongPassphraseError } from '../lib/errors'
import { createSessionEpochGate } from '../lib/sessionEpochGate'

const KEYPAIR_STORAGE_KEY = 'sails_ui_keypair_secret_hex'

/** Lets Login.tsx show "crie uma senha" vs "digite sua senha" without needing to authenticate first. */
export function hasStoredIdentity(): boolean {
  return localStorage.getItem(KEYPAIR_STORAGE_KEY) !== null
}

// Reused by useEscrowKey.ts for the same failure against the escrow key
// (same passphrase, different stored secret) — one error type so every
// caller can catch it with a single `instanceof` check regardless of
// which key failed to decrypt.
//
// PRE-M3-REALITY-GATE-1-R1 (2026-09-13) — moved to `lib/errors.ts` (a
// leaf module with zero imports) so `lib/escrowErrorClassification.ts`'s
// pure classification functions can `instanceof`-check it without
// dragging this file's own React/`sailsClient`/`keyEncryption` imports
// into a plain Jest test — see `lib/errors.ts`'s own header comment for
// the full reasoning. Re-exported here unchanged so every existing
// caller (Login.tsx, Trade.tsx, useEscrowKey.ts) keeps importing it from
// `context/AuthContext` exactly as before — no call site changed. Also
// used directly below (`loadStoredKeypair()`), hence the regular import
// above rather than only a re-export.
export { WrongPassphraseError }

function toUser(participant: {
  id: string; publicKey: string; displayName: string | null; peerId: string | null
  reputationScore: number; totalTrades: number; disputeCount: number
  totalVolumeBtc: string; verified: boolean; createdAt: string
}): User {
  return {
    id: participant.id,
    publicKey: participant.publicKey,
    displayName: participant.displayName,
    peerId: participant.peerId,
    reputationScore: participant.reputationScore,
    totalTrades: participant.totalTrades,
    disputeCount: participant.disputeCount,
    totalVolumeBtc: Number(participant.totalVolumeBtc), // RFC-009 decimal string -> UI number
    verified: participant.verified,
    createdAt: participant.createdAt,
  }
}

// Returns `null` for "nothing stored yet" (first-time user) as well as
// `null` for "stored data is malformed" (pre-encryption legacy entry from
// before 2026-08-11, or a corrupted one) — both are safe to treat as
// "generate a fresh keypair". A wrong-passphrase decrypt failure is NOT
// folded in here — it throws WrongPassphraseError instead, since silently
// generating a fresh identity there would strand the real one.
async function loadStoredKeypair(encryptionKey: CryptoKey): Promise<Ed25519Keypair | null> {
  const packed = localStorage.getItem(KEYPAIR_STORAGE_KEY)
  if (!packed) return null
  const result = await decryptBytes(encryptionKey, packed)
  if (!result.ok && result.reason === 'corrupt') return null
  if (!result.ok) throw new WrongPassphraseError()
  const secretKey = result.bytes
  // Ed25519 secret keys (tweetnacl's sign keypair) encode the public key
  // in their last 32 bytes — no separate storage needed to reconstruct it.
  const publicKey = secretKey.slice(32)
  return { secretKey, publicKey }
}

async function storeKeypair(encryptionKey: CryptoKey, kp: Ed25519Keypair) {
  const packed = await encryptBytes(encryptionKey, kp.secretKey)
  // Real bug found live: this runs right after identity.create() already
  // registered a real Participant server-side (login()'s own call order,
  // just above this function's only call site) — an unguarded setItem
  // throwing here (quota exceeded, Safari private browsing) orphaned that
  // identity permanently: the keypair only ever existed in this function's
  // local scope, so a retry just generates and registers a brand new one,
  // leaving the first stranded with no way back in. Must fail loudly with
  // an actionable message, not the generic "Falha ao conectar" a bare
  // rethrow would surface.
  try {
    localStorage.setItem(KEYPAIR_STORAGE_KEY, packed)
  } catch {
    throw new Error('Não foi possível salvar sua chave neste navegador (modo privado ou armazenamento cheio) — tente em uma janela normal ou libere espaço.')
  }
}

interface AuthContextType {
  user: User | null
  loading: boolean
  login: (passphrase: string) => Promise<void>
  logout: () => void
  // The same Ed25519Keypair already used for identity.authenticate() —
  // exposed here so a real caller (Trade.tsx's chat) can pass it into
  // @satsails/p2p-trading-sdk's encryptChatMessage()/decryptChatMessage() without this
  // module's own storage/loading details leaking outside AuthContext.
  keypair: Ed25519Keypair | null
  // Same derived key used to encrypt the identity keypair above, reused
  // by useEscrowKey.ts so the user isn't asked for their passphrase a
  // second time to unlock the (separate) escrow signing key.
  encryptionKey: CryptoKey | null
  // `keypair` above wrapped as a WalletAdapter-shaped signer (Missão 13
  // Fase 2, INV-12, 2026-08-29) — resolveDisputeWithWallet()/
  // attachEvidence() etc. expect this shape, and every one of them must
  // sign with this SAME already-registered identity key for server-side
  // verification to succeed (a fresh/unrelated keypair just gets a 403).
  // See LocalKeypairWalletAdapter's own header for why it only implements
  // signMessage — this is still the demo-only localStorage key disclosed
  // above, not a step toward real wallet custody.
  wallet: WalletAdapter | null
  // Mission 3 Slice 1/R2 (docs/PARTNER_WALLET_INTEGRATION_IDENTITY_CONTINUITY.md
  // §15) — closes P3-F08.1/F08.2. Set at most once per genuine session-
  // expiry EPISODE (never for an ordinary failed login attempt, and never
  // more than once for the SAME underlying expiry even when several
  // authenticated requests sharing that session independently 401 — see
  // `lib/sessionEpochGate.ts`'s own header for the concurrency mechanism
  // that guarantees this). `path` is where the user was when it
  // happened, consumed by SessionExpiryRedirect.tsx to send them back to
  // the SAME page via Login.tsx's existing `{state:{from}}` return-path
  // convention (OfferDetail.tsx already established this same pattern
  // for the INITIAL auth gate — this reuses it, not a new one). `episode`
  // is a real, locally-unique, strictly-increasing counter (never a
  // wall-clock timestamp — see `sessionEpochGate.ts`'s own header for why
  // `Date.now()` is imprecise for this) so the redirect effect can tell a
  // NEW expiry apart from one it already handled.
  sessionExpiry: { episode: number; path: string } | null
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null)
  const [keypair, setKeypair] = useState<Ed25519Keypair | null>(null)
  const [encryptionKey, setEncryptionKey] = useState<CryptoKey | null>(null)
  const [loading, setLoading] = useState(false)
  const [sessionExpiry, setSessionExpiry] = useState<{ episode: number; path: string } | null>(null)
  const wallet = useMemo(() => (keypair ? new LocalKeypairWalletAdapter(keypair) : null), [keypair])

  // Mission 3 R2 — the SOLE authoritative "is there an active session,
  // and which one" truth, created once and never recreated for the
  // lifetime of this provider. Deliberately NOT React state and NOT a
  // ref synced via useEffect (that was the original, defective
  // mechanism — see this file's own git history / the design doc's §7
  // for the exact race it had): `login()`/`logout()` call
  // `activate()`/`deactivate()` synchronously, in the same call, at the
  // exact point they change session state, and the handler below calls
  // `claimExpiry()` synchronously too — see `sessionEpochGate.ts`'s own
  // header for the full concurrency argument.
  const epochGateRef = useRef<ReturnType<typeof createSessionEpochGate> | null>(null)
  if (epochGateRef.current === null) epochGateRef.current = createSessionEpochGate()

  useEffect(() => {
    sailsClient.setOnSessionExpired((_err: SailsAuthError) => {
      // Multiple authenticated requests can legitimately share one
      // session token; if it expires, several of them can independently
      // reach this handler for the SAME underlying episode (the SDK's
      // own onSessionExpired fires once per QUALIFYING REQUEST, not once
      // globally — see SailsTransportOptions.onSessionExpired's own doc
      // comment). claimExpiry() is what converges all of those
      // observations onto AT MOST ONE reaction: only the first call
      // reaching this line for the current epoch gets a non-null result;
      // every other one (including a late call after an explicit
      // logout() already ran) gets null and no-ops below.
      const claimedEpoch = epochGateRef.current!.claimExpiry()
      if (claimedEpoch === null) return
      setUser(null)
      setKeypair(null)
      setEncryptionKey(null)
      sailsClient.setSessionToken(null)
      setSessionExpiry({ episode: claimedEpoch, path: window.location.pathname + window.location.search })
    })
    return () => sailsClient.setOnSessionExpired(undefined)
  }, [])

  const login = async (passphrase: string) => {
    setLoading(true)
    try {
      const derivedKey = await deriveKeyFromPassphrase(passphrase)
      let keypair = await loadStoredKeypair(derivedKey) // throws WrongPassphraseError on a real mismatch
      if (!keypair) {
        keypair = generateKeypair()
        // identity.create() registers a real Participant for this fresh
        // keypair — only needed once, before the first authenticate().
        await sailsClient.identity.create(keypair)
        await storeKeypair(derivedKey, keypair)
      }
      // Real challenge-response — requests a challenge, signs it, submits
      // it, and stores the returned session token on the client's
      // transport for every subsequent authenticated call.
      await sailsClient.identity.authenticate(keypair)
      const participant = await sailsClient.identity.me()
      // Issue #303 - production servers enforce Capability Authority
      // (ENFORCE_CAPABILITIES=true is mandatory), so a participant with no
      // canonical grants would be refused at intent creation and at every
      // release/refund/split. Idempotent (a no-op when live grants already
      // exist), so it runs on every login; self-issued consent, not
      // independent permission - see capabilities.ts.
      await sailsClient.capabilities.ensureCanonicalGrants(participant.id)
      // Mission 3 R2 — activate() BEFORE the React state setters below,
      // synchronously, in this same function (never deferred to an
      // effect): the epoch gate must already reflect "this session is
      // active" the instant a caller could possibly observe `user`
      // becoming non-null, since a request racing this same login could
      // otherwise reach the onSessionExpired handler in between.
      epochGateRef.current!.activate()
      setUser(toUser(participant))
      setKeypair(keypair)
      setEncryptionKey(derivedKey)
    } finally {
      setLoading(false)
    }
  }

  const logout = () => {
    // Mission 3 R2 — deactivate() synchronously, same reasoning as
    // activate() above: any request already in flight when logout()
    // runs (e.g. a background fetch that hasn't resolved yet) must have
    // its EVENTUAL 401 correctly treated as "no active session" rather
    // than manufacturing a new expiry episode for a session the user
    // just left on purpose.
    epochGateRef.current!.deactivate()
    setUser(null)
    setKeypair(null)
    setEncryptionKey(null)
    sailsClient.setSessionToken(null)
  }

  // No more silent re-authenticate-on-mount: a page refresh now requires
  // re-entering the passphrase, same as any real wallet/password manager
  // locking on reload — there is no way to re-derive the encryption key
  // without it. (Before encryption landed, this used to auto-restore the
  // session using the stored plaintext keypair; that's the exact passive
  // exposure this change closes, so it can't stay.)

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, keypair, encryptionKey, wallet, sessionExpiry }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
