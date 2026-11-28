/**
 * Passphrase-based encryption at rest for the private keys this
 * reference UI stores in localStorage (AuthContext.tsx's Ed25519 identity
 * key, useEscrowKey.ts's secp256k1 escrow key) — real gap flagged live
 * (2026-08-11): those keys used to sit in localStorage as plain hex, an
 * XSS reads them straight out. This does not remove the underlying class
 * of risk (an active XSS running while a session is unlocked can still
 * exfiltrate a decrypted key from memory) — the actual fix for that is a
 * real external wallet, out of scope for this reference UI (see this
 * file's own callers' header comments). What this closes is passive
 * exposure: a malicious browser extension, another script, or anyone
 * with read access to the browser profile can no longer just read the
 * key straight out of localStorage — they'd also need the user's
 * passphrase.
 *
 * PBKDF2-SHA256 (210,000 iterations — OWASP's 2023 minimum recommendation)
 * derives a non-extractable AES-256-GCM key from the passphrase; the salt
 * is random per-browser-profile (stored alongside, salts are not secret)
 * so two users' identical passphrases don't derive the same key. AES-GCM
 * is authenticated — decrypting with the wrong passphrase throws
 * reliably rather than silently producing garbage, which is what lets
 * callers distinguish "wrong passphrase" from "corrupt/legacy data" below.
 */
import { t } from '../i18n'

const PBKDF2_ITERATIONS = 210_000
const SALT_STORAGE_KEY = 'sails_ui_kdf_salt'

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  return bytes
}

function getOrCreateSalt(): Uint8Array {
  const stored = localStorage.getItem(SALT_STORAGE_KEY)
  const parsed = stored ? hexToBytes(stored) : null
  if (parsed) return parsed
  const salt = crypto.getRandomValues(new Uint8Array(16))
  // Real bug found live: an unguarded setItem here (quota exceeded, or
  // Safari private browsing) generated a salt that was never persisted —
  // the next derivation would silently generate a DIFFERENT salt, so even
  // the correct passphrase would never again produce the same key. Must
  // fail loudly here, not swallow: there's no "corrupt/legacy" fallback
  // for a salt, unlike decryptBytes()'s own callers.
  try {
    localStorage.setItem(SALT_STORAGE_KEY, bytesToHex(salt))
  } catch {
    throw new Error(t('auth.errors.saveDataFailed'))
  }
  return salt
}

/** Non-extractable — the raw key material never becomes readable JS bytes, only usable via SubtleCrypto calls. */
export async function deriveKeyFromPassphrase(passphrase: string): Promise<CryptoKey> {
  const salt = getOrCreateSalt()
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/** Packed as `<iv-hex>:<ciphertext-hex>` — a fresh random IV every call, required for AES-GCM. */
export async function encryptBytes(key: CryptoKey, data: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data as BufferSource)
  return `${bytesToHex(iv)}:${bytesToHex(new Uint8Array(ciphertext))}`
}

export type DecryptResult =
  | { ok: true; bytes: Uint8Array }
  // Malformed packed string — pre-encryption legacy data (plain hex, no
  // ':' separator) or a corrupted entry. Safe to treat as "no key stored".
  | { ok: false; reason: 'corrupt' }
  // Well-formed but the AES-GCM auth tag didn't verify — the passphrase
  // is wrong. Must NOT be treated as "no key stored": silently
  // regenerating here would orphan whatever this key controls (an escrow
  // signing key controls real funds; even the identity key would strand
  // the existing on-chain reputation under the old, now-inaccessible key).
  | { ok: false; reason: 'wrong-passphrase' }

export async function decryptBytes(key: CryptoKey, packed: string): Promise<DecryptResult> {
  const [ivHex, ctHex] = packed.split(':')
  const iv = ivHex ? hexToBytes(ivHex) : null
  const ct = ctHex ? hexToBytes(ctHex) : null
  if (!iv || !ct || iv.length !== 12) return { ok: false, reason: 'corrupt' }
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource)
    return { ok: true, bytes: new Uint8Array(plaintext) }
  } catch {
    return { ok: false, reason: 'wrong-passphrase' }
  }
}
