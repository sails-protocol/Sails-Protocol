/**
 * Real Sails chat is a WebSocket protocol (chat.routes.ts's
 * `GET /v1/openp2p/chat`, real events: JOIN_TRADE/SEND_MESSAGE/USER_ONLINE/
 * USER_OFFLINE/...) that relays through the OpenP2P/Pears path. This
 * component itself is presentational only — Trade.tsx owns the real
 * `WebSocketChannel` (`@satsails/p2p-trading-sdk`'s `openp2p.chat()`) and passes down
 * `messages`/`counterpartyOnline` already derived from it; nothing here
 * is mocked as of 2026-08-02 (this header used to say otherwise — stale,
 * fixed — see Trade.tsx's own `channel.onEvent()` wiring for presence and
 * `channel.onMessage()` for messages).
 *
 * Image/video attach was removed (Lote B): it created a local
 * `URL.createObjectURL(file)` blob that never left this browser tab, so
 * the counterparty never saw it. What a real "send image/video via Pears" would need, concretely:
 * (1) `Message.msgType` on the real backend is already a free String
 * (prisma/schema.prisma) so `IMAGE`/`VIDEO` need no migration; (2) an
 * actual upload/storage step first — `Message.content` is Postgres text,
 * not a place for a raw binary blob, and chat.routes.ts's SEND_MESSAGE
 * schema (`content: z.string()`) has no size ceiling suited to a video;
 * (3) the WS->Pears relay in that same route only ever forwards a plain
 * text `content` inside a `MESSAGE_EXCHANGED` event — carrying a media
 * reference through `PearNode.sendToPeer()` is structurally possible
 * (its payload is arbitrary JSON, sealed with libsodium in
 * `payload-crypto.ts`) but no one has wired that event shape yet. None
 * of that exists today, so this is UI-only, not a claim any of it works
 * end-to-end.
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { Message } from '../../types'
import { ChatMessage } from './ChatMessage'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { InfoTooltip } from '../ui/InfoTooltip'
import { Lock, LockOpen } from 'lucide-react'

interface Props {
  messages: Message[]
  currentUserId?: string
  onSend: (content: string) => void
  // Opt-in end-to-end encryption (@satsails/p2p-trading-sdk's encryptChatMessage/
  // decryptChatMessage) — see Trade.tsx's own comment for the full wiring.
  encryptionEnabled: boolean
  onToggleEncryption: (enabled: boolean) => void
  // False while the counterparty's public key / this user's own keypair
  // hasn't loaded yet — the toggle is disabled rather than silently
  // failing to encrypt if flipped on too early.
  encryptionAvailable: boolean
  // Real presence (2026-08-02) — see Trade.tsx's own comment on
  // counterpartyOnline. null = no USER_ONLINE/USER_OFFLINE frame observed
  // yet this session, not a guess either way.
  counterpartyName?: string
  counterpartyOnline?: boolean | null
}

export function ChatWindow({
  messages, currentUserId, onSend,
  encryptionEnabled, onToggleEncryption, encryptionAvailable,
  counterpartyName, counterpartyOnline,
}: Props) {
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const switchId = useId()
  // Real bug found live: onSend/handleSend below are fully synchronous
  // (Trade.tsx's own handleSend just does a WebSocket .send(), no await),
  // so a plain `if (!input.trim())` guard doesn't help against holding or
  // mashing Enter — key-repeat can fire multiple keydown events faster
  // than React re-renders and clears `input`, sending the same message
  // several times. A ref-based lock is synchronous and doesn't depend on
  // render timing, unlike a second piece of state would.
  const sendingRef = useRef(false)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  const handleSend = () => {
    if (!input.trim() || sendingRef.current) return
    sendingRef.current = true
    onSend(input.trim())
    setInput('')
    queueMicrotask(() => { sendingRef.current = false })
  }

  return (
    <Card className="flex flex-col h-[520px] overflow-hidden">
      <div className="px-4 py-2 border-b border-brand-border">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-brand-text">Chat P2P</span>
          <span
            className={`text-xs flex items-center gap-1 shrink-0 ${
              counterpartyOnline === null ? 'text-brand-text-muted' : counterpartyOnline ? 'text-green-500' : 'text-brand-text-muted'
            }`}
            title={
              counterpartyOnline === null
                ? 'Ainda não observamos esta pessoa entrar na sala de chat'
                : counterpartyOnline
                  ? `${counterpartyName ?? 'A contraparte'} está no chat agora`
                  : `${counterpartyName ?? 'A contraparte'} não está no chat agora`
            }
          >
            <span className={`w-1.5 h-1.5 rounded-full ${counterpartyOnline ? 'bg-green-500' : 'bg-brand-text-muted/50'}`} />
            <span>
              {counterpartyOnline === null ? 'Presença desconhecida' : counterpartyOnline ? `${counterpartyName ?? 'Contraparte'} online` : `${counterpartyName ?? 'Contraparte'} offline`}
            </span>
          </span>
        </div>
        {/* The label states what is true now; the switch is the action. */}
        <div className="flex items-center gap-1.5 text-xs text-brand-text-secondary">
          {encryptionEnabled ? <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <LockOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
          <span>{encryptionEnabled ? 'Criptografado' : 'Não criptografado'}</span>
          <InfoTooltip text="Cifra as próximas mensagens de ponta a ponta (só você e a contraparte conseguem ler). Mensagens antigas continuam em texto simples." />
          <label htmlFor={switchId} className="flex min-h-11 cursor-pointer items-center gap-1.5 pl-1">
            <span className={encryptionEnabled ? 'sr-only' : ''}>Ativar</span>
            <Switch
              id={switchId}
              checked={encryptionEnabled}
              onCheckedChange={onToggleEncryption}
              disabled={!encryptionAvailable}
              aria-label="Criptografia de ponta a ponta no chat"
            />
          </label>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
        {messages.length === 0 && (
          <p className="m-auto text-sm text-brand-text-secondary">Nenhuma mensagem ainda.</p>
        )}
        {messages.map((m) => (
          <ChatMessage key={m.id} message={m} isMine={m.senderId === currentUserId} />
        ))}
        <div ref={endRef} />
      </div>

      <div className="border-t border-brand-border p-3 flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder={encryptionEnabled ? 'Mensagem criptografada...' : 'Digite uma mensagem...'}
          aria-label="Mensagem"
          className="flex-1 min-h-11"
        />
        <Button onClick={handleSend} className="min-h-11 px-4 text-sm">
          Enviar
        </Button>
      </div>
    </Card>
  )
}
