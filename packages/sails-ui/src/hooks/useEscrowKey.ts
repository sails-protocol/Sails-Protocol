/**
 * Client-held escrow key (MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM) — the
 * buyer/seller half of the non-custodial upgrade to those escrow types
 * (`src/modules/open-settlement/multisig.provider.ts`,
 * `lightning-hodl.provider.ts`, `safe-guard-evm.provider.ts`). Same
 * disclosed demo-shortcut pattern `AuthContext.tsx` already uses for the
 * Ed25519 identity key: the private key is generated and held in this
 * browser's own localStorage, never sent anywhere — only the public key
 * ever leaves, via `sailsClient.settlement.submitKey()`. A real wallet
 * integration would keep this in the wallet's own secure storage instead.
 *
 * Encrypted at rest since 2026-08-11, same fix and same reasoning as
 * AuthContext.tsx's identity key (real gap flagged live: plain-hex in
 * localStorage) — reuses the SAME derived key from AuthContext (passed
 * in below) rather than asking for the passphrase a second time. This is
 * arguably the more important of the two keys to have encrypted: unlike
 * the identity key, this one directly signs fund release/refund
 * transactions.
 *
 * One key is reused across every such escrow this browser profile
 * participates in, rather than a fresh key per trade (HodlHodl's own
 * real design derives one per contract) — kept simple here since this
 * is a reference implementation, not production custody; a real wallet
 * integration could derive per-trade keys instead without changing
 * anything on the server side (it only ever sees a pubkey).
 */
import { generateEscrowKeypair, verifyAndSignEscrowPsbt } from '@satsails/p2p-trading-sdk'
import type { Escrow, EscrowPendingTransaction } from '@satsails/p2p-trading-sdk'
import { sailsClient } from '../lib/sailsClient'
import { encryptBytes, decryptBytes } from '../lib/keyEncryption'
import { WrongPassphraseError } from '../context/AuthContext'
import { buildMultisigSigningIntent, assertMultisigSigningAllowed } from '../lib/multisigSigningIntent'
import { t } from '../i18n'

const ESCROW_KEY_STORAGE_KEY = 'sails_ui_escrow_keypair'

interface StoredEscrowKeypair {
  privateKeyHex: string
  publicKeyHex: string
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  return bytes
}

// Public key is stored alongside the encrypted private key, in plain
// text — it's not secret (it's the same value submitKey() sends to the
// server), so there's no reason to make the caller decrypt just to read
// it back.
interface StoredEscrowEnvelope {
  encryptedPrivateKey: string // keyEncryption.ts's packed `iv:ciphertext` format
  publicKeyHex: string
}

async function loadOrCreateEscrowKeypair(encryptionKey: CryptoKey): Promise<StoredEscrowKeypair> {
  const raw = localStorage.getItem(ESCROW_KEY_STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<StoredEscrowEnvelope>
      if (parsed?.encryptedPrivateKey && parsed?.publicKeyHex) {
        const result = await decryptBytes(encryptionKey, parsed.encryptedPrivateKey)
        if (result.ok) return { privateKeyHex: bytesToHex(result.bytes), publicKeyHex: parsed.publicKeyHex }
        if (result.reason === 'wrong-passphrase') {
          // Real fund-safety guard: this key signs escrow release/refund
          // transactions. Silently regenerating here would orphan
          // whatever escrow this browser already submitted the OLD
          // public key for — surface the failure instead of masking it.
          // Same WrongPassphraseError AuthContext.tsx throws for the
          // identity key, so every caller (Trade.tsx) can catch both
          // with one `instanceof` check instead of string-matching.
          throw new WrongPassphraseError(t('auth.errors.escrowWrongPassphrase'))
        }
        // reason === 'corrupt' (pre-encryption legacy entry or a
        // corrupted one) — falls through and regenerates below, same as
        // the pre-2026-08-11 behavior for a JSON.parse failure.
      }
    } catch (err) {
      if (err instanceof WrongPassphraseError) throw err
      // JSON.parse failure or missing fields — fall through and regenerate.
    }
  }
  const kp = generateEscrowKeypair()
  const envelope: StoredEscrowEnvelope = {
    encryptedPrivateKey: await encryptBytes(encryptionKey, kp.privateKey),
    publicKeyHex: kp.publicKeyHex,
  }
  try {
    localStorage.setItem(ESCROW_KEY_STORAGE_KEY, JSON.stringify(envelope))
  } catch {
    // Same fund-safety class as the wrong-passphrase branch above: if this
    // key isn't actually persisted, the next call here (from either
    // caller below) would silently generate a DIFFERENT keypair — either
    // submitting a pubkey that doesn't match one already on file for this
    // escrow, or signing with a key that doesn't match what was
    // submitted. Must fail loudly, not let an unpersisted key be used as
    // if it were durable.
    throw new Error(t('auth.errors.escrowSaveFailed'))
  }
  return { privateKeyHex: bytesToHex(kp.privateKey), publicKeyHex: kp.publicKeyHex }
}

// Escrow types whose address/script depends on a client-submitted pubkey
// — see NON_CUSTODIAL_PROVIDERS in escrow.service.ts, the server-side
// source of truth this list mirrors. SAFE_GUARD_EVM added 2026-08-02
// (RFC-020) — its own getDepositAddress()/owners() need the same
// 33-byte compressed secp256k1 pubkey format MULTISIG already submits
// (safe-guard-evm.provider.ts's own SafeGuardEvmEscrowInput comment:
// "same as MULTISIG"), so no new key format is needed here.
const PUBKEY_SUBMISSION_ESCROW_TYPES = new Set(['MULTISIG', 'LIGHTNING_HODL', 'SAFE_GUARD_EVM'])

// `encryptionKey` — the same derived key AuthContext.tsx produces from
// the user's passphrase at login, reused here rather than prompting a
// second time (see this file's own header comment). Callers only reach
// this hook while authenticated (Trade.tsx), so a null encryptionKey
// here would mean a real auth-state bug elsewhere, not a normal path —
// both functions below throw immediately rather than silently no-op-ing.
export function useEscrowKey(encryptionKey: CryptoKey | null) {
  // Idempotent (the server upserts by role, see submitParticipantKey()) —
  // safe to call every time an escrow of the right type loads, no need to
  // track "already submitted" state client-side.
  const submitEscrowKeyIfNeeded = async (escrowType: string, escrowId: string) => {
    if (!PUBKEY_SUBMISSION_ESCROW_TYPES.has(escrowType)) return null
    if (!encryptionKey) throw new Error('No encryption key available — user is not authenticated')
    const { publicKeyHex } = await loadOrCreateEscrowKeypair(encryptionKey)
    return sailsClient.settlement.submitKey(escrowId, publicKeyHex)
  }

  // CTO 437 step 4 — the explicit, user-confirmed path (SigningRequestCard).
  // MULTISIG only: verifyAndSignEscrowPsbt() refuses to sign unless the PSBT
  // matches the intent built from public data. The caller passes the escrow
  // and round it just re-read and showed, so the signed round is exactly the
  // reviewed one. LIGHTNING_HODL/SAFE_GUARD_EVM have no verify-then-sign SDK
  // primitive yet, so this hook has no signing path for them at all (the
  // former speculative auto-sign, which raw-signed both, was removed).
  const signVerifiedMultisigPending = async (escrow: Escrow, pending: EscrowPendingTransaction) => {
    if (escrow.type !== 'MULTISIG') throw new Error('Only MULTISIG pending transactions can be signed from this interface')
    // Despacho 033 HOLD: refuse before the escrow key is decrypted.
    assertMultisigSigningAllowed(escrow)
    if (!encryptionKey) throw new Error('No encryption key available — user is not authenticated')
    const { privateKeyHex } = await loadOrCreateEscrowKeypair(encryptionKey)
    const expected = buildMultisigSigningIntent(escrow, pending)
    const signedPsbtBase64 = verifyAndSignEscrowPsbt(pending.unsignedPsbtBase64, expected, pending.requiredSigners, hexToBytes(privateKeyHex))
    // pending.id binds the signature to this exact round (server refuses a different live round).
    return sailsClient.settlement.submitTransactionSignature(escrow.id, signedPsbtBase64, pending.id)
  }

  return { submitEscrowKeyIfNeeded, signVerifiedMultisigPending }
}
