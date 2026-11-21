import type { Message } from '../../types'
import { formatTime } from '../../lib/format'
import { RISK_PATTERN_LABEL } from '../../lib/socialEngineering'
import { InfoTooltip } from '../ui/InfoTooltip'
import { t } from '../../i18n'
import { AlertTriangle, Receipt, Lock } from 'lucide-react'

export function ChatMessage({ message, isMine }: { message: Message; isMine: boolean }) {
  if (message.type === 'SYSTEM') {
    return (
      // State changes this client observed (Trade.tsx), never counterparty text. No time: when it was observed is not when it happened.
      <div role="status" className="self-center max-w-full text-center text-xs text-brand-text-secondary bg-brand-elevated border border-brand-border-subtle rounded-md px-3 py-1.5 my-1">
        <span className="font-semibold">{t('trade.chat.systemPrefix')} · </span>
        {message.content}
      </div>
    )
  }

  if (message.type === 'RISK_WARNING') {
    return (
      <div className="self-stretch flex items-start gap-2 text-xs bg-brand-danger-bg text-brand-text rounded-lg px-3.5 py-2.5 my-1">
        <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-danger" />
        <div className="flex-1">
          <div className="flex items-center gap-1.5 font-semibold text-brand-danger-fg">
            {message.riskPattern ? RISK_PATTERN_LABEL[message.riskPattern] : t('trade.chat.riskFallback')}
            <InfoTooltip text={t('trade.chat.riskHelp')} />
          </div>
          <p className="text-brand-text-secondary mt-0.5">{message.content}</p>
        </div>
      </div>
    )
  }

  const isProof = message.type === 'PAYMENT_PROOF'
  const isMedia = message.type === 'IMAGE' || message.type === 'VIDEO'
  const isEncrypted = message.type === 'ENCRYPTED_TEXT'

  return (
    <div className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}>
      {!isMine && message.sender && (
        <span className="text-xs text-brand-text-muted mb-0.5 ml-1">{message.sender.displayName}</span>
      )}
      <div
        className={`max-w-[75%] rounded-xl px-3.5 py-2 text-sm ${
          message.decryptionFailed
            ? 'bg-brand-elevated border border-dashed border-brand-border text-brand-text-muted italic'
            : isProof
              ? 'bg-brand-info-bg border border-brand-info-border text-brand-text'
              // Own bubbles are solid blue (DECISIONS.md, 2026-11-21): orange is reserved for actions.
              : isMine
                ? 'bg-brand-info-solid text-brand-on-info rounded-br-sm'
                : 'bg-brand-elevated text-brand-text rounded-bl-sm'
        } ${isMedia ? 'p-1.5' : ''}`}
      >
        {/* A proof is a party's claim, not a verified payment (CTO 437): info tone, never success. */}
        {isProof && (
          <div className="text-xs font-semibold text-brand-info-fg mb-1 flex items-center gap-1">
            <Receipt className="size-icon-xs" /> {t('trade.chat.proof')}
          </div>
        )}
        {message.type === 'IMAGE' && message.mediaUrl && (
          <img src={message.mediaUrl} alt={message.mediaFileName ?? t('trade.chat.imageAlt')} className="max-w-[240px] max-h-[240px] rounded-lg object-cover" />
        )}
        {message.type === 'VIDEO' && message.mediaUrl && (
          <video src={message.mediaUrl} controls className="max-w-[240px] max-h-[240px] rounded-lg" />
        )}
        {!isMedia && (
          <span className="inline-flex items-start gap-1">
            {isEncrypted && !message.decryptionFailed && <Lock className="size-icon-xs mt-0.5 shrink-0 opacity-70" />}
            <span>{message.content}</span>
          </span>
        )}
        {isMedia && message.content && (
          <div className={`text-xs px-1.5 pt-1 ${isMine ? 'text-brand-on-info/80' : 'text-brand-text-muted'}`}>{message.content}</div>
        )}
      </div>
      <span className="text-xs text-brand-text-muted mt-0.5">{formatTime(message.createdAt)}</span>
    </div>
  )
}
