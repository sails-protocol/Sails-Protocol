/**
 * Layer C, demo only: the market's two conversations (PO, 2026-11-22), kept apart from the trade chat (the only real
 * one, tied to a trade and its escrow). Familiar group-messaging patterns:
 * - Chat do grupo: members post intentions, as free text or as a small intent card ("Publicar intenção": type,
 *   amount, payment method). Any message, card or member row offers "Conversar no privado".
 * - Conversas privadas: two members agree on terms. A fixed strip says the protection only exists inside the trade
 *   with escrow; a message that looks like paying outside the trade gets a soft warning (lib/offTradeRisk.ts); the
 *   main action "Propor negociação" opens the new-offer flow with the side prefilled from the card.
 * Payment details never appear here: they exist only inside the trade. Everything lives in memory and every send says
 * "Simulado: nada foi enviado ao nó Sails" (LOOSE_WIRES.marketGroupChat, marketDirectMessage, marketIntentPost).
 */
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { AlertTriangle, ArrowLeft, MessageCircle, MessagesSquare, ShieldAlert } from 'lucide-react'
import { Tabs, tabPanelProps } from '../../components/ui/tabs'
import { Input } from '../../components/ui/input'
import { Button, buttonVariants } from '../../components/ui/button'
import { IconButton } from '../../components/ui/icon-button'
import { Alert } from '../../components/ui/alert'
import { IdentityAvatar } from '../../components/ui/IdentityAvatar'
import { SimulatedBadge } from '../../components/ui/SimulatedBadge'
import { RadioCard, RadioGroup } from '../../components/ui/radio-group'
import { TRADES_ROUTES } from '../../components/layout/navMatch'
import { looksOffTrade } from '../../lib/offTradeRisk'
import { cn } from '../../lib/utils'
import { simulatedToast } from './shared'
import { t } from '../../i18n'

type IntentType = 'payBill' | 'buyUsdt' | 'buyBtc' | 'sellBtc'
interface Intent { type: IntentType; amount: string; method: string }
interface Msg { id: string; author: string; seed: string; text?: string; intent?: Intent; own?: boolean }
interface Peer { author: string; seed: string }
type Tab = 'group' | 'private'

const INTENT_TYPES: readonly IntentType[] = ['payBill', 'buyUsdt', 'buyBtc', 'sellBtc']
// The side of the person who answers: they sell what the poster wants to buy, and buy what the poster sells.
const ANSWER_SIDE: Record<IntentType, 'BUY' | 'SELL'> = { payBill: 'BUY', buyUsdt: 'SELL', buyBtc: 'SELL', sellBtc: 'BUY' }
const METHODS = ['Pix', 'TED', 'Boleto'] as const

// Fictional members (DECISIONS.md "Identidade") and intentions, pt-BR like the other demo fixtures.
const SEED_GROUP: readonly Msg[] = [
  { id: 'g1', author: 'Alice', seed: 'demo-member-alice', intent: { type: 'payBill', amount: 'US$ 40–60', method: 'Pix' } },
  { id: 'g2', author: 'Bob', seed: 'demo-member-bob', text: 'Eu vendo USDT. Me chama no privado que a gente combina.' },
  { id: 'g3', author: 'Erin', seed: 'demo-member-erin', intent: { type: 'buyBtc', amount: 'US$ 200', method: 'TED' } },
]
const ME = { author: 'Você', seed: 'demo-member-you' }

function IntentCard({ intent, onPrivate }: { intent: Intent; onPrivate?: () => void }) {
  return (
    <div className="mt-1 space-y-1 rounded-md bg-brand-surface px-3 py-2">
      <p className="text-body-sm font-medium text-brand-text">{t(`spaces.intent.type.${intent.type}`)}</p>
      <p className="text-caption text-brand-text-secondary">{intent.amount} · {intent.method}</p>
      {onPrivate && <Button type="button" size="sm" variant="secondary" onClick={onPrivate} className="touch:min-h-11"><MessageCircle aria-hidden="true" />{t('spaces.chat.privateShort')}</Button>}
    </div>
  )
}

function Bubble({ m, onPrivate }: { m: Msg; onPrivate?: (m: Msg) => void }) {
  return (
    <li className={cn('flex items-start gap-2', m.own && 'flex-row-reverse')}>
      <IdentityAvatar seed={m.seed} size={28} />
      <div className={cn('min-w-0 max-w-prose rounded-lg px-3 py-2', m.own ? 'bg-brand-info-solid text-brand-on-info' : 'bg-brand-elevated text-brand-text')}>
        <p className={cn('text-caption font-medium', m.own ? 'text-brand-on-info' : 'text-brand-text')}>{m.author}</p>
        {m.text && <p className="break-words text-body-sm">{m.text}</p>}
        {m.intent && <IntentCard intent={m.intent} onPrivate={onPrivate && !m.own ? () => onPrivate(m) : undefined} />}
      </div>
      {onPrivate && !m.own && !m.intent && (
        <IconButton label={t('spaces.chat.privateWith', { name: m.author })} size="sm" onClick={() => onPrivate(m)} className="mt-1 shrink-0">
          <MessageCircle aria-hidden="true" />
        </IconButton>
      )}
    </li>
  )
}

function Composer({ label, onSend, warn = false }: { label: string; onSend: (text: string) => void; warn?: boolean }) {
  const id = useId()
  const [text, setText] = useState('')
  const risky = warn && looksOffTrade(text)
  const submit = (e: FormEvent) => { e.preventDefault(); const v = text.trim(); if (!v) return; onSend(v); setText('') }
  return (
    <form onSubmit={submit} className="space-y-1">
      <div className="flex gap-2">
        <label htmlFor={id} className="sr-only">{label}</label>
        <Input id={id} name="market-message" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder={`${label}…`} aria-describedby={risky ? `${id}-warn` : undefined} className="min-w-0 flex-1" />
        {/* Tonal: the page's solid orange is never a chat send (DECISIONS.md "Chat do trade"). */}
        <Button type="submit" variant="secondary" disabled={!text.trim()} className="shrink-0 touch:min-h-11">{t('spaces.chat.send')}</Button>
      </div>
      <div aria-live="polite">
        {risky && <p id={`${id}-warn`} className="flex items-start gap-1.5 text-caption text-brand-warning-fg"><AlertTriangle aria-hidden="true" className="mt-px size-icon-xs shrink-0" />{t('spaces.chat.offTrade')}</p>}
      </div>
    </form>
  )
}

/** "Publicar intenção": three fields, then a card in the group. */
function IntentForm({ onPost, onCancel }: { onPost: (i: Intent) => void; onCancel: () => void }) {
  const id = useId()
  const [type, setType] = useState<IntentType>('buyUsdt')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<string>('Pix')
  return (
    <form className="space-y-3 rounded-lg bg-brand-elevated p-3" onSubmit={(e) => { e.preventDefault(); if (amount.trim()) onPost({ type, amount: amount.trim(), method }) }}>
      <RadioGroup legend={t('spaces.intent.typeLegend')} listClassName="grid gap-2 sm:grid-cols-2">
        {INTENT_TYPES.map((v) => <RadioCard key={v} name={`${id}-type`} value={v} checked={type === v} onChange={() => setType(v)}>{t(`spaces.intent.type.${v}`)}</RadioCard>)}
      </RadioGroup>
      <div>
        <label htmlFor={`${id}-amount`} className="text-sm font-medium text-brand-text">{t('spaces.intent.amount')}</label>
        <Input id={`${id}-amount`} name="intent-amount" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('spaces.intent.amountExample')} className="mt-1" />
      </div>
      <RadioGroup legend={t('spaces.intent.method')} listClassName="flex flex-wrap gap-2">
        {METHODS.map((v) => <RadioCard key={v} name={`${id}-method`} value={v} checked={method === v} onChange={() => setMethod(v)}>{v}</RadioCard>)}
      </RadioGroup>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onCancel} className="touch:min-h-11">{t('common.cancel')}</Button>
        <Button type="submit" variant="secondary" disabled={!amount.trim()} className="touch:min-h-11">{t('spaces.intent.post')}</Button>
      </div>
    </form>
  )
}

/** `membersSlot` renders the admin's member list (public keys only) with a way into a private conversation. */
export interface OpenPrivateRequest { peer: Peer; context?: string; side?: 'BUY' | 'SELL'; key: number }

export function MarketChats({ membersSlot, openWith }: {
  membersSlot?: (openPrivate: (peer: Peer) => void) => ReactNode
  /** Opens (or reopens) a private conversation from outside, e.g. "Conversar" on an offer; `context` is shown on top. */
  openWith?: OpenPrivateRequest | null
}) {
  const idBase = useId()
  const [tab, setTab] = useState<Tab>('group')
  const [group, setGroup] = useState<readonly Msg[]>(SEED_GROUP)
  const [posting, setPosting] = useState(false)
  const [threads, setThreads] = useState<Record<string, { peer: Peer; intent?: Intent; context?: string; side?: 'BUY' | 'SELL'; msgs: readonly Msg[] }>>({})
  const [open, setOpen] = useState<string | null>(null)

  const openPrivate = (peer: Peer, intent?: Intent, context?: string, side?: 'BUY' | 'SELL') => {
    setThreads((th) => ({ ...th, [peer.seed]: { peer, msgs: th[peer.seed]?.msgs ?? [], intent: intent ?? th[peer.seed]?.intent, context: context ?? th[peer.seed]?.context, side: side ?? th[peer.seed]?.side } }))
    setOpen(peer.seed)
    setTab('private')
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (openWith) openPrivate(openWith.peer, undefined, openWith.context, openWith.side) }, [openWith?.key])
  const sendGroup = (text: string) => { setGroup((g) => [...g, { id: `g${g.length + 1}`, ...ME, text, own: true }]); simulatedToast() }
  const postIntent = (intent: Intent) => { setGroup((g) => [...g, { id: `g${g.length + 1}`, ...ME, intent, own: true }]); setPosting(false); simulatedToast() }
  const sendPrivate = (seed: string, text: string) => {
    setThreads((th) => ({ ...th, [seed]: { ...th[seed], msgs: [...th[seed].msgs, { id: `p${th[seed].msgs.length + 1}`, ...ME, text, own: true }] } }))
    simulatedToast()
  }
  const thread = open ? threads[open] : null
  const list = Object.values(threads)

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <MessagesSquare aria-hidden="true" className="size-icon-sm text-brand-text-muted" />
        <h2 className="text-section-title">{t('spaces.chat.sectionTitle')}</h2>
        <SimulatedBadge label={t('spaces.simulated')} />
      </div>
      <p className="mt-1 text-caption text-brand-text-secondary">{t('spaces.chat.note')}</p>
      <Tabs
        className="mt-3"
        idBase={idBase}
        label={t('spaces.chat.sectionTitle')}
        value={tab}
        onChange={setTab}
        items={[{ value: 'group', label: t('spaces.chat.title') }, { value: 'private', label: list.length ? t('spaces.chat.privateTabCount', { count: list.length }) : t('spaces.chat.privateTab') }]}
      />
      {tab === 'group' ? (
        <div {...tabPanelProps(idBase, 'group')} className="space-y-3 pt-3 outline-none">
          <ul className="space-y-2" aria-label={t('spaces.chat.title')}>
            {group.map((m) => <Bubble key={m.id} m={m} onPrivate={(x) => openPrivate({ author: x.author, seed: x.seed }, x.intent)} />)}
          </ul>
          {posting ? <IntentForm onPost={postIntent} onCancel={() => setPosting(false)} /> : (
            <>
              <Composer label={t('spaces.chat.groupPlaceholder')} onSend={sendGroup} />
              <Button type="button" variant="ghost" size="sm" onClick={() => setPosting(true)} className="touch:min-h-11">{t('spaces.intent.open')}</Button>
            </>
          )}
          {membersSlot?.((p) => openPrivate(p))}
        </div>
      ) : (
        <div {...tabPanelProps(idBase, 'private')} className="space-y-3 pt-3 outline-none">
          {!thread ? (
            list.length === 0 ? (
              <p className="text-body-sm text-brand-text-secondary">{t('spaces.chat.privateEmpty')}</p>
            ) : (
              <ul className="divide-y divide-brand-border-subtle" aria-label={t('spaces.chat.privateTab')}>
                {list.map((th) => (
                  <li key={th.peer.seed}>
                    <button type="button" onClick={() => setOpen(th.peer.seed)} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left state-layer focus-visible:-outline-offset-2">
                      <IdentityAvatar seed={th.peer.seed} size={28} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-body-sm font-medium text-brand-text">{th.peer.author}</span>
                        <span className="block truncate text-caption text-brand-text-secondary">{th.msgs[th.msgs.length - 1]?.text ?? (th.intent ? t(`spaces.intent.type.${th.intent.type}`) : t('spaces.chat.privateNew'))}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(null)} className="touch:min-h-11"><ArrowLeft aria-hidden="true" />{t('spaces.chat.privateBack')}</Button>
              <p className="text-body-sm font-medium text-brand-text">{t('spaces.chat.privateWith', { name: thread.peer.author })}</p>
              {/* Fixed at the top of every private conversation (PO). */}
              <Alert tone="warning" icon={ShieldAlert} title={t('spaces.chat.safety')} />
              {thread.intent && <IntentCard intent={thread.intent} />}
              {thread.context && <p className="rounded-md bg-brand-elevated px-3 py-2 text-body-sm text-brand-text">{thread.context}</p>}
              <ul className="space-y-2" aria-label={t('spaces.chat.privateWith', { name: thread.peer.author })}>
                {thread.msgs.length === 0 && <li className="text-caption text-brand-text-secondary">{t('spaces.chat.privateNew')}</li>}
                {thread.msgs.map((m) => <Bubble key={m.id} m={m} />)}
              </ul>
              <Composer label={t('spaces.chat.privatePlaceholder')} onSend={(v) => sendPrivate(thread.peer.seed, v)} warn />
              <Link to={`${TRADES_ROUTES.newOffer}?side=${thread.side ?? (thread.intent ? ANSWER_SIDE[thread.intent.type] : 'SELL')}`} className={cn(buttonVariants({ variant: 'secondary' }), 'touch:min-h-11')}>{t('spaces.chat.createTrade')}</Link>
            </>
          )}
        </div>
      )}
    </div>
  )
}
