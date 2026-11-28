/**
 * Pure transforms between the real SDK's chat shapes and this UI's own
 * `Message` type — extracted out of Trade.tsx (2026-08-11, codebase-
 * quality pass ahead of dev handoff) since none of these touch React
 * state; they don't need to live inside the page component at all.
 */
import type { Message as SdkMessage, ChatMessageEvent, Ed25519Keypair, EncryptedChatMessage } from '@satsails/p2p-trading-sdk'
import { decryptChatMessage } from '@satsails/p2p-trading-sdk'
import type { Message, MessageType, User } from '../types'
import { t } from '../i18n'

// ENCRYPTED_TEXT's `content` holds JSON.stringify(EncryptedChatMessage) on
// the wire (types.ts's own comment on MessageType) — opportunistically
// decrypted here so every read path (REST history + live WS) shows the
// same plaintext. Falls back to a user-facing placeholder + `decryptionFailed`
// rather than throwing, since a missing keypair/counterparty key (still
// loading) or a genuinely corrupted message must not crash the whole page.
export function decryptIncoming(
  content: string,
  msgType: string | null | undefined,
  myKeypair: Ed25519Keypair | null,
  counterpartyPublicKeyHex: string | undefined
): { content: string; type: MessageType; decryptionFailed?: boolean } {
  if (msgType !== 'ENCRYPTED_TEXT') {
    return { content, type: (msgType as MessageType) ?? 'TEXT' }
  }
  if (!myKeypair || !counterpartyPublicKeyHex) {
    return { content: t('escrow.chat.loadingKeys'), type: 'ENCRYPTED_TEXT', decryptionFailed: true }
  }
  try {
    const encrypted: EncryptedChatMessage = JSON.parse(content)
    const plain = decryptChatMessage(encrypted, counterpartyPublicKeyHex, myKeypair)
    return { content: plain, type: 'ENCRYPTED_TEXT' }
  } catch {
    return { content: t('escrow.chat.decryptFailed'), type: 'ENCRYPTED_TEXT', decryptionFailed: true }
  }
}

export function toUiMessage(
  m: SdkMessage, buyer: User, seller: User,
  myKeypair: Ed25519Keypair | null, counterpartyPublicKeyHex: string | undefined
): Message {
  const sender = m.senderId === buyer.id ? buyer : m.senderId === seller.id ? seller : null
  return {
    id: m.id, senderId: m.senderId, sender,
    ...decryptIncoming(m.content, m.msgType, myKeypair, counterpartyPublicKeyHex),
    createdAt: m.createdAt,
  }
}

// The live WS NEW_MESSAGE frame's real shape (ChatMessageEvent, fixed
// the same day in @satsails/p2p-trading-sdk's openp2p.ts — see that file's own comment)
// genuinely differs from getMessages()'s REST history shape (SdkMessage
// above): messageId/timestamp, not id/createdAt.
export function toUiMessageFromEvent(
  m: ChatMessageEvent, buyer: User, seller: User,
  myKeypair: Ed25519Keypair | null, counterpartyPublicKeyHex: string | undefined
): Message {
  const sender = m.senderId === buyer.id ? buyer : m.senderId === seller.id ? seller : null
  return {
    id: m.messageId, senderId: m.senderId, sender,
    ...decryptIncoming(m.content, m.msgType, myKeypair, counterpartyPublicKeyHex),
    createdAt: m.timestamp,
  }
}
