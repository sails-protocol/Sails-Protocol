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
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Link } from 'react-router'
import { AlertTriangle, ArrowLeft, MessageCircle, Pin, ShieldAlert } from 'lucide-react'
import { Tabs, tabPanelProps } from '../../components/ui/tabs'
import { Input } from '../../components/ui/input'
import { Button, buttonVariants } from '../../components/ui/button'
import { IconButton } from '../../components/ui/icon-button'
import { Alert } from '../../components/ui/alert'
import { SafetyCenterLink } from '../../components/safety/SafetyCenterLink'
import { IdentityAvatar } from '../../components/ui/IdentityAvatar'
import { SimulatedBadge } from '../../components/ui/SimulatedBadge'
import { RadioCard, RadioGroup } from '../../components/ui/radio-group'
import { TRADES_ROUTES } from '../../components/layout/navMatch'
import { looksOffTrade } from '../../lib/offTradeRisk'
import { parseUsdWhole } from '../../lib/createMarket'
import { currencyDisplay } from '../../lib/format'
import { getLocale } from '../../lib/locale'
import { cn } from '../../lib/utils'
import { simulatedToast } from './shared'
import { t } from '../../i18n'

type IntentType = 'payBill' | 'buyUsdt' | 'buyBtc' | 'sellBtc'
interface Intent { type: IntentType; min: number; max?: number; method: string }
interface Msg { id: string; author: string; seed: string; text?: string; intent?: Intent; own?: boolean; risky?: boolean; demoReply?: boolean }
interface Peer { author: string; seed: string }
type Tab = 'group' | 'private'

const INTENT_TYPES: readonly IntentType[] = ['payBill', 'buyUsdt', 'buyBtc', 'sellBtc']
// The side of the person who answers: they sell what the poster wants to buy, and buy what the poster sells.
const ANSWER_SIDE: Record<IntentType, 'BUY' | 'SELL'> = { payBill: 'BUY', buyUsdt: 'SELL', buyBtc: 'SELL', sellBtc: 'BUY' }
const METHODS = ['Pix', 'TED', 'Boleto'] as const
const METHOD_CODE: Record<string, string> = { Pix: 'PIX', TED: 'TED', Boleto: 'OTHER' }
const INTENT_ASSET: Record<IntentType, string> = { payBill: 'USDT_TRC20', buyUsdt: 'USDT_TRC20', buyBtc: 'BTC', sellBtc: 'BTC' }

/**
 * "Propor negociação": from an offer, that offer's trade start (/offer/:id); otherwise the new-offer flow prefilled from
 * the intent card (side, asset, amount, method) with a link back to this conversation.
 */
function proposeLink(th: { offerId?: string; side?: 'BUY' | 'SELL'; intent?: Intent; peer: Peer }, backTo?: string): { to: string; state?: { ctx?: string; peerName: string } } {
  if (th.offerId) return { to: `/offer/${encodeURIComponent(th.offerId)}` }
  const q = new URLSearchParams({ side: th.side ?? (th.intent ? ANSWER_SIDE[th.intent.type] : 'SELL') })
  let ctx: string | undefined
  if (th.intent) {
    // Never a USD amount in the crypto quantity fields: the amount goes as context text only.
    q.set('asset', INTENT_ASSET[th.intent.type])
    q.set('method', METHOD_CODE[th.intent.method] ?? 'PIX')
    ctx = t('spaces.propose.context', { name: th.peer.author, type: t(`spaces.intent.type.${th.intent.type}`), amount: intentAmount(th.intent), method: th.intent.method })
  }
  // Back to Conversas › Privadas with this thread open. Names and context go in router state, never in the URL.
  if (backTo) q.set('back', `${backTo}?tab=chat&peer=${encodeURIComponent(th.peer.seed)}`)
  return { to: `${TRADES_ROUTES.newOffer}?${q.toString()}`, state: { ctx, peerName: th.peer.author } }
}

// Canned counterparty replies (demo): the other side answers about 2 s after you send, marked as an example.
const REPLY_DELAY_MS = 2000
const replyLater = (fn: () => void) => window.setTimeout(fn, REPLY_DELAY_MS)

// Fictional members (DECISIONS.md "Identidade") and intentions, pt-BR like the other demo fixtures.
const SEED_GROUP: readonly Msg[] = [
  { id: 'g1', author: 'Alice', seed: 'demo-member-alice', intent: { type: 'payBill', min: 40, max: 60, method: 'Pix' } },
  { id: 'g2', author: 'Bob', seed: 'demo-member-bob', text: 'Eu vendo USDT. Me chama no privado que a gente combina.' },
  { id: 'g3', author: 'Erin', seed: 'demo-member-erin', intent: { type: 'buyBtc', min: 200, method: 'TED' } },
]
const ME = { author: 'Você', seed: 'demo-member-you' }

/** "US$ 50" or "US$ 40–60", in the interface language. */
const usd = (v: number) => v.toLocaleString(getLocale(), { style: 'currency', currency: 'USD', currencyDisplay: currencyDisplay('USD'), maximumFractionDigits: 0 })
const intentAmount = (i: Intent) => (i.max && i.max !== i.min ? `${usd(i.min)}–${usd(i.max)}` : usd(i.min))

function IntentCard({ intent, author, onPrivate }: { intent: Intent; author: string; onPrivate?: () => void }) {
  return (
    <div className="mt-1 space-y-1 rounded-md bg-brand-surface px-3 py-2">
      <p className="text-body-sm font-medium text-brand-text">{t(`spaces.intent.type.${intent.type}`)}</p>
      <p className="tabular-nums text-caption text-brand-text-secondary">{intentAmount(intent)} · {intent.method}</p>
      {onPrivate && <Button type="button" size="sm" variant="secondary" onClick={onPrivate} aria-label={t('spaces.chat.privateWith', { name: author })} className="touch:min-h-11"><MessageCircle aria-hidden="true" />{t('spaces.chat.privateShort')}</Button>}
    </div>
  )
}

function Bubble({ m, onPrivate, onPin }: { m: Msg; onPrivate?: (m: Msg) => void; onPin?: (m: Msg) => void }) {
  return (
    <li className={cn('flex items-start gap-2', m.own && 'flex-row-reverse')}>
      <IdentityAvatar seed={m.seed} size={28} />
      <div className={cn('min-w-0 max-w-prose rounded-lg px-3 py-2', m.own ? 'bg-brand-info-solid text-brand-on-info' : 'bg-brand-elevated text-brand-text')}>
        <p className={cn('text-caption font-medium', m.own ? 'text-brand-on-info' : 'text-brand-text')}>{m.author}</p>
        {m.text && <p className="break-words text-body-sm">{m.text}</p>}
        {m.demoReply && <SimulatedBadge label={t('spaces.chat.demoReply')} className="mt-1" />}
        {m.intent && <IntentCard intent={m.intent} author={m.author} onPrivate={onPrivate && !m.own ? () => onPrivate(m) : undefined} />}
        {/* Stays on the sent message too (a soft reminder, never a block). */}
        {m.risky && <p className="mt-1 flex items-start gap-1 text-caption"><AlertTriangle aria-hidden="true" className="mt-px size-icon-xs shrink-0" />{t('spaces.chat.offTrade')}</p>}
      </div>
      {onPrivate && !m.own && !m.intent && (
        <IconButton label={t('spaces.chat.privateWith', { name: m.author })} size="sm" onClick={() => onPrivate(m)} className="mt-1 shrink-0">
          <MessageCircle aria-hidden="true" />
        </IconButton>
      )}
      {onPin && (
        <IconButton label={t('spaces.admin.pin')} size="sm" onClick={() => onPin(m)} className="mt-1 shrink-0">
          <Pin aria-hidden="true" />
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
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const minN = parseUsdWhole(min)
  const maxN = max.trim() ? parseUsdWhole(max) : null
  const valid = minN !== null && (max.trim() === '' || (maxN !== null && maxN >= minN))
  const [method, setMethod] = useState<string>('Pix')
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid && minN !== null) onPost({ type, min: minN, max: maxN ?? undefined, method }) }}>
      <RadioGroup legend={t('spaces.intent.typeLegend')} listClassName="grid gap-2 sm:grid-cols-2">
        {INTENT_TYPES.map((v) => <RadioCard key={v} name={`${id}-type`} value={v} checked={type === v} onChange={() => setType(v)}>{t(`spaces.intent.type.${v}`)}</RadioCard>)}
      </RadioGroup>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={`${id}-min`} className="text-sm font-medium text-brand-text">{t('spaces.intent.amount')}</label>
          <Input id={`${id}-min`} name="intent-min" inputMode="numeric" autoComplete="off" value={min} onChange={(e) => setMin(e.target.value)} placeholder="50" className="mt-1 tabular-nums" />
        </div>
        <div>
          <label htmlFor={`${id}-max`} className="text-sm font-medium text-brand-text">{t('spaces.intent.amountMax')} <span className="font-normal text-brand-text-secondary">{t('markets.optional')}</span></label>
          <Input id={`${id}-max`} name="intent-max" inputMode="numeric" autoComplete="off" value={max} onChange={(e) => setMax(e.target.value)} placeholder="100" className="mt-1 tabular-nums" />
        </div>
      </div>
      <RadioGroup legend={t('spaces.intent.method')} listClassName="flex flex-wrap gap-2">
        {METHODS.map((v) => <RadioCard key={v} name={`${id}-method`} value={v} checked={method === v} onChange={() => setMethod(v)}>{v}</RadioCard>)}
      </RadioGroup>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onCancel} className="touch:min-h-11">{t('common.cancel')}</Button>
        <Button type="submit" variant="secondary" disabled={!valid} aria-describedby={valid ? undefined : `${id}-hint`} className="touch:min-h-11">{t('spaces.intent.post')}</Button>
      </div>
      {!valid && <p id={`${id}-hint`} className="text-right text-caption text-brand-text-muted">{t('spaces.intent.amountHint')}</p>}
    </form>
  )
}

/** `membersSlot` renders the admin's member list (public keys only) with a way into a private conversation. */
export interface OpenPrivateRequest { peer: Peer; context?: string; side?: 'BUY' | 'SELL'; offerId?: string; key: number }

export function MarketChats({ membersSlot, openWith, backTo, canPin = false, canPost = true }: {
  membersSlot?: (openPrivate: (peer: Peer) => void) => ReactNode
  /** Opens (or reopens) a private conversation from outside, e.g. "Conversar" on an offer; `context` is shown on top. */
  openWith?: OpenPrivateRequest | null
  /** Where "Propor negociação" returns to (the market page). */
  backTo?: string
  /** Admin (demo): pin one group message to the top. */
  canPin?: boolean
  /** Members post in the group; anyone else reads the preview only. */
  canPost?: boolean
}) {
  const idBase = useId()
  const [tab, setTab] = useState<Tab>('group')
  const [group, setGroup] = useState<readonly Msg[]>(SEED_GROUP)
  const [posting, setPosting] = useState(false)
  const [pinned, setPinned] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const postButton = useRef<HTMLButtonElement>(null)
  const [threads, setThreads] = useState<Record<string, { peer: Peer; intent?: Intent; context?: string; side?: 'BUY' | 'SELL'; offerId?: string; msgs: readonly Msg[] }>>({})
  const [open, setOpen] = useState<string | null>(null)

  const openPrivate = (peer: Peer, intent?: Intent, context?: string, side?: 'BUY' | 'SELL', offerId?: string) => {
    setThreads((th) => ({ ...th, [peer.seed]: { peer, msgs: th[peer.seed]?.msgs ?? [], intent: intent ?? th[peer.seed]?.intent, context: context ?? th[peer.seed]?.context, side: side ?? th[peer.seed]?.side, offerId: offerId ?? th[peer.seed]?.offerId } }))
    setOpen(peer.seed)
    setTab('private')
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (openWith) openPrivate(openWith.peer, undefined, openWith.context, openWith.side, openWith.offerId) }, [openWith?.key])
  const sendGroup = (text: string) => {
    setGroup((g) => [...g, { id: `g${g.length + 1}`, ...ME, text, own: true }])
    simulatedToast()
    replyLater(() => setGroup((g) => [...g, { id: `g${g.length + 1}`, author: 'Bob', seed: 'demo-member-bob', text: t('spaces.chat.demoReplyGroup'), demoReply: true }]))
  }
  const postIntent = (intent: Intent) => {
    setGroup((g) => [...g, { id: `g${g.length + 1}`, ...ME, intent, own: true }])
    setPosting(false)
    simulatedToast()
    // The posted card scrolls into view once rendered.
    // After the dialog closes and the list renders: smooth only when the system allows motion.
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    window.setTimeout(() => listRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' }), 50)
  }
  const sendPrivate = (seed: string, text: string) => {
    setThreads((th) => ({ ...th, [seed]: { ...th[seed], msgs: [...th[seed].msgs, { id: `p${th[seed].msgs.length + 1}`, ...ME, text, own: true, risky: looksOffTrade(text) }] } }))
    simulatedToast()
    replyLater(() => setThreads((th) => th[seed] ? ({ ...th, [seed]: { ...th[seed], msgs: [...th[seed].msgs, { id: `p${th[seed].msgs.length + 1}`, author: th[seed].peer.author, seed, text: t('spaces.chat.demoReplyPrivate'), demoReply: true }] } }) : th))
  }
  const thread = open ? threads[open] : null
  const list = Object.values(threads)

  return (
    <div>
      {/* The page tab already says "Conversas": no second heading, just the honest note. */}
      <p className="flex flex-wrap items-center gap-2 text-caption text-brand-text-secondary"><SimulatedBadge label={t('spaces.simulated')} />{t('spaces.chat.note')}</p>
      <Tabs
        className="mt-3"
        idBase={idBase}
        label={t('spaces.chat.sectionTitle')}
        value={tab}
        onChange={setTab}
        items={[{ value: 'group', label: t('spaces.chat.groupTab') }, { value: 'private', label: list.length ? t('spaces.chat.privateTabCount', { count: list.length }) : t('spaces.chat.privateTab') }]}
      />
      {tab === 'group' ? (
        <div {...tabPanelProps(idBase, 'group')} className="space-y-3 pt-3">
          {pinned && (() => {
            const p = group.find((x) => x.id === pinned)
            return p ? (
              <div className="flex items-start gap-2 rounded-lg bg-brand-elevated px-3 py-2">
                <Pin aria-hidden="true" className="mt-0.5 size-icon-sm shrink-0 text-brand-text-muted" />
                <p className="min-w-0 flex-1 text-body-sm text-brand-text"><span className="font-medium">{t('spaces.admin.pinnedPrefix')}</span>{' '}{t('spaces.admin.pinnedLine', { author: p.author, text: p.text ?? (p.intent ? `${t(`spaces.intent.type.${p.intent.type}`)} · ${intentAmount(p.intent)}` : '') })}</p>
                {canPin && <Button type="button" size="sm" variant="ghost" onClick={() => setPinned(null)} className="touch:min-h-11">{t('spaces.admin.unpin')}</Button>}
              </div>
            ) : null
          })()}
          <ul ref={listRef} className="space-y-2" aria-label={t('spaces.chat.title')}>
            {group.map((m) => <Bubble key={m.id} m={m} onPrivate={(x) => openPrivate({ author: x.author, seed: x.seed }, x.intent)} onPin={canPin ? (x) => { setPinned(x.id); simulatedToast() } : undefined} />)}
          </ul>
          {canPost ? (
            <>
              <Composer label={t('spaces.chat.groupPlaceholder')} onSend={sendGroup} />
              <Button ref={postButton} type="button" variant="ghost" size="sm" onClick={() => setPosting(true)} className="touch:min-h-11">{t('spaces.intent.open')}</Button>
            </>
          ) : (
            <p className="rounded-md bg-brand-elevated px-3 py-2 text-body-sm text-brand-text-secondary">{t('spaces.chat.joinToPost')}</p>
          )}
          <Dialog open={posting} onOpenChange={setPosting}>
            {/* No Radix trigger: focus goes back to "Publicar intenção" on close. */}
            <DialogContent className="max-w-lg" onCloseAutoFocus={(e) => { e.preventDefault(); postButton.current?.focus() }}>
              <DialogHeader className="pr-10 text-left"><DialogTitle>{t('spaces.intent.open')}</DialogTitle></DialogHeader>
              <IntentForm onPost={postIntent} onCancel={() => setPosting(false)} />
            </DialogContent>
          </Dialog>
          {membersSlot?.((p) => openPrivate(p))}
        </div>
      ) : (
        <div {...tabPanelProps(idBase, 'private')} className="space-y-3 pt-3">
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
              <Alert tone="warning" icon={ShieldAlert} title={t('spaces.chat.safety')}>
                <SafetyCenterLink page="escrowLimits">{t('shell.safetyCenter.howToStaySafe')}</SafetyCenterLink>
              </Alert>
              {thread.intent && <IntentCard intent={thread.intent} author={thread.peer.author} />}
              {thread.context && <p className="rounded-md bg-brand-elevated px-3 py-2 text-body-sm text-brand-text">{thread.context}</p>}
              <ul className="space-y-2" aria-label={t('spaces.chat.privateWith', { name: thread.peer.author })}>
                {thread.msgs.length === 0 && <li className="text-caption text-brand-text-secondary">{t('spaces.chat.privateNew')}</li>}
                {thread.msgs.map((m) => <Bubble key={m.id} m={m} />)}
              </ul>
              <Composer label={t('spaces.chat.privatePlaceholder')} onSend={(v) => sendPrivate(thread.peer.seed, v)} warn />
              <Link {...proposeLink(thread, backTo)} className={cn(buttonVariants({ variant: 'secondary' }), 'touch:min-h-11')}>{t('spaces.chat.createTrade')}</Link>
            </>
          )}
        </div>
      )}
    </div>
  )
}
