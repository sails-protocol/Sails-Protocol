/**
 * Layer C, demo only: portable identity and market ownership (CTO 29, homologated and ratified 2026-11-23 as direction;
 * the SDK contract does not exist yet). "Ativar o Sails P2P" (2 actions), "Recuperar minha identidade" (result with
 * identity / social data / funds kept apart), recovery of the markets you administer (7-day minimum safety period with
 * objection, and the host must cooperate), the owner's objection banner, the market "Sobre" notices and the
 * recovery-authority choice in Criar mercado. Nothing here is real: no identity is created, linked or recovered,
 * nothing is read, stored or sent, every record is a fixture. Real mode renders only the honest rows ("Não
 * configurada", "Em breve", "Seus contatos ficam neste aparelho").
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import {
  ArrowLeft, Ban, BellRing, ChevronDown, CircleAlert, CircleCheck, CircleOff, FileLock2, Fingerprint, Hourglass, KeyRound,
  MessageSquareOff, QrCode, Radio, RotateCcw, SearchCheck, Server, ServerCog, ShieldAlert, Star, TimerOff, Wallet, type LucideIcon,
} from 'lucide-react'
import { SettingsRow } from './SettingsRow'
import { SimulatedBadge } from '../ui/SimulatedBadge'
import { Button } from '../ui/button'
import { ConfirmActionDialog } from '../ui/ConfirmActionDialog'
import { RadioCard, RadioGroup } from '../ui/radio-group'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { LOOSE_WIRES } from '../../lib/looseWires'
import { isDemoMode } from '../../lib/demoMarkers'
import { cn } from '../../lib/utils'
import type { MarketInfrastructure } from '../../lib/myMarkets'
import { simulatedToast, WirePlanned } from '../../pages/markets/shared'
import { t } from '../../i18n'

// Fictional portable record (demo): what a recovery would find. Names are illustrative, keys are not real.
const DEMO_CONTACTS = [
  { name: 'Ana', key: '8f3a…c21d' },
  { name: 'Bruno', key: '2b9e…71f0' },
  { name: 'Carla', key: 'd04c…9a3b' },
] as const
type GroupState = 'found' | 'valid' | 'expired' | 'unavailable'
const DEMO_GROUPS: readonly { name: string; state: GroupState }[] = [
  { name: 'Boreal', state: 'valid' },
  { name: 'Vela Norte', state: 'found' },
  { name: 'Porto Sul', state: 'expired' },
  { name: 'Maré Alta', state: 'unavailable' },
]
const DEMO_FAVORITES = 5
// Fictional identity domain (where the owner's portable identity lives); shown as a plain label.
const DEMO_IDENTITY_DOMAIN = 'identidade.exemplo'

// Icon + text for every state, never color alone.
const GROUP_STATE: Record<GroupState, { icon: LucideIcon; tone: string }> = {
  found: { icon: SearchCheck, tone: 'text-brand-info-fg' },
  valid: { icon: CircleCheck, tone: 'text-brand-success-fg' },
  expired: { icon: TimerOff, tone: 'text-brand-warning-fg' },
  unavailable: { icon: CircleOff, tone: 'text-brand-text-secondary' },
}

// Markets the recovered identity administers (demo, one per state of the CTO 29 model).
export type MarketRole = 'owner' | 'delegated'
type RecoveryState = 'pending' | 'awaitingHost' | 'restored' | 'cancelled' | 'notConfirmed' | 'noAuthority'
const DEMO_ADMIN_MARKETS: readonly { name: string; role: MarketRole; infrastructure: MarketInfrastructure; state: RecoveryState; daysLeft?: number }[] = [
  { name: 'Meu Mercado Exemplo', role: 'owner', infrastructure: 'network', state: 'pending', daysLeft: 5 },
  { name: 'Traders P2P Exemplo', role: 'delegated', infrastructure: 'own', state: 'awaitingHost' },
  { name: 'Loja Exemplo', role: 'delegated', infrastructure: 'network', state: 'restored' },
  { name: 'Clientes Empresa ABC', role: 'owner', infrastructure: 'own', state: 'cancelled' },
  { name: 'Boreal OTC', role: 'delegated', infrastructure: 'managed', state: 'notConfirmed' },
  { name: 'Bitcoin Sul Exemplo', role: 'owner', infrastructure: 'network', state: 'noAuthority' },
]
const RECOVERY_STATE: Record<RecoveryState, { icon: LucideIcon; tone: string }> = {
  pending: { icon: Hourglass, tone: 'text-brand-info-fg' },
  awaitingHost: { icon: ServerCog, tone: 'text-brand-info-fg' },
  restored: { icon: CircleCheck, tone: 'text-brand-success-fg' },
  cancelled: { icon: Ban, tone: 'text-brand-warning-fg' },
  notConfirmed: { icon: CircleAlert, tone: 'text-brand-warning-fg' },
  noAuthority: { icon: CircleOff, tone: 'text-brand-text-secondary' },
}
const HOSTED_KEY = { network: 'markets.create.infrastructure.networkLabel', own: 'markets.list.infrastructure.own', managed: 'markets.create.infrastructure.managedLabel' } as const
// Demo case for "Mudança de dono recente" (market page › Sobre).
const DEMO_RECENT_OWNER_CHANGE: Readonly<Record<string, { requestedDaysAgo: number; doneDaysAgo: number }>> = {
  'demo-market-boreal': { requestedDaysAgo: 9, doneDaysAgo: 2 },
}

const simulated = (className?: string) => <SimulatedBadge label={t('spaces.simulated')} className={className} />

/** Title of the current step; focus moves to it on each step so keyboard and screen reader follow the flow. */
function StepHeader({ step, total, title, description, onBack }: { step?: number; total?: number; title: string; description?: ReactNode; onBack?: () => void }) {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => { ref.current?.focus() }, [title])
  return (
    <DialogHeader className="pr-10 text-left">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label={t('identity.back')}
          className="-ml-1 mb-1 flex h-8 w-8 items-center justify-center rounded-md text-brand-text-secondary state-layer hover:text-brand-text touch:h-11 touch:w-11"
        >
          <ArrowLeft aria-hidden="true" className="size-icon-sm" />
        </button>
      )}
      {step !== undefined && total !== undefined && <p className="text-caption text-brand-text-secondary">{t('identity.step', { current: step, total })}</p>}
      {/* Not a control: focused only by script to announce the new step, so no focus ring (the buttons keep theirs). */}
      <DialogTitle ref={ref} tabIndex={-1} className="flex flex-wrap items-center gap-2 outline-none">{title}{simulated()}</DialogTitle>
      {description && <DialogDescription>{description}</DialogDescription>}
    </DialogHeader>
  )
}

function Fact({ icon: Icon, children, tone = 'text-brand-text-secondary' }: { icon: LucideIcon; children: ReactNode; tone?: string }) {
  return (
    <p className="flex items-start gap-2 text-body-sm text-brand-text">
      <Icon aria-hidden="true" className={cn('mt-0.5 size-icon-sm shrink-0', tone)} />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/** A native disclosure (keyboard and screen reader for free). */
function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group rounded-lg bg-brand-elevated px-3">
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 text-body-sm font-medium text-brand-text touch:min-h-11">
        {summary}<ChevronDown aria-hidden="true" className="size-icon-sm shrink-0 text-brand-text-secondary group-open:rotate-180" />
      </summary>
      <p className="pb-3 text-body-sm text-brand-text-secondary">{children}</p>
    </details>
  )
}
const WhatIs = () => <Disclosure summary={t('identity.whatIs')}>{t('identity.whatIsText')}</Disclosure>

/** The QR the identity app scans (a placeholder: the demo draws no real code) and the anti-phishing line. */
function QrApproval() {
  return (
    <>
      <figure className="flex flex-col items-center gap-2 rounded-lg bg-brand-elevated p-4">
        <span className="flex size-32 items-center justify-center rounded-md bg-brand-surface">
          <QrCode aria-hidden="true" className="size-icon-lg text-brand-text-secondary" />
        </span>
        <figcaption className="text-caption text-brand-text-secondary">{t('identity.qr')}</figcaption>
      </figure>
      <Fact icon={ShieldAlert} tone="text-brand-warning-fg">{t('identity.phishing')}</Fact>
    </>
  )
}

/** What the portable identity never brings back (end of the activation). */
function Limits({ onLeave }: { onLeave?: () => void }) {
  return (
    <section aria-labelledby="identity-limits" className="space-y-2 rounded-lg bg-brand-elevated p-3">
      <h3 id="identity-limits" className="text-sm font-medium text-brand-text">{t('identity.limits.title')}</h3>
      <Fact icon={MessageSquareOff}>{t('identity.limits.messages')}</Fact>
      <Fact icon={Wallet}>{t('identity.limits.funds')}</Fact>
      <Link to="/settings?section=seguranca" onClick={onLeave} className="inline-flex min-h-8 items-center text-body-sm font-medium text-brand-link underline-offset-2 hover:underline touch:min-h-11">
        {t('identity.limits.backupLink')}
      </Link>
    </section>
  )
}

const Note = () => <p className="text-caption text-brand-text-secondary">{t('spaces.simulated.toast')}</p>

/** "Ativar o Sails P2P": open the wallet, then scan the QR in the identity app and approve. `onDone` closes the host dialog. */
export function ActivationFlow({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  if (step === 0) return (
    <>
      <StepHeader step={1} total={2} title={t('identity.activate.s1.title')} description={t('identity.activate.s1.text')} />
      <Fact icon={Fingerprint} tone="text-brand-info">{t('identity.status.description')}</Fact>
      <Button onClick={() => setStep(1)} className="w-full touch:min-h-11">{t('identity.continue')}</Button>
    </>
  )
  if (step === 1) return (
    <>
      <StepHeader step={2} total={2} title={t('identity.activate.s2.title')} description={t('identity.activate.s2.text')} onBack={() => setStep(0)} />
      <QrApproval />
      <WhatIs />
      <Button onClick={() => setStep(2)} className="w-full touch:min-h-11">{t('identity.approved')}</Button>
    </>
  )
  return (
    <>
      <StepHeader title={t('identity.activate.row')} />
      <p role="status" className="flex items-start gap-2 text-body text-brand-text">
        <CircleCheck aria-hidden="true" className="mt-0.5 size-icon-md shrink-0 text-brand-success-fg" />{t('identity.activate.done')}
      </p>
      <Fact icon={Radio} tone="text-brand-success-fg">{t('identity.activate.comms')}</Fact>
      <Limits onLeave={onDone} />
      <Note />
      {/* One primary way out of the last screen (the dialog's own close stays the only "Fechar"). */}
      <Button onClick={onDone} className="w-full touch:min-h-11">{t('identity.finish')}</Button>
    </>
  )
}

/** Saved contacts (demo): nickname + abbreviated public key. */
export function ContactsList({ removable = false }: { removable?: boolean }) {
  // Demo: "Remover" takes a contact off this list only (nothing is stored or sent).
  const [contacts, setContacts] = useState<readonly (typeof DEMO_CONTACTS)[number][]>(DEMO_CONTACTS)
  if (contacts.length === 0) return <p className="rounded-lg bg-brand-elevated px-3 py-2 text-body-sm text-brand-text-secondary">{t('settings.contacts.empty')}</p>
  return (
    <ul className="divide-y divide-brand-border-subtle rounded-lg bg-brand-elevated">
      {contacts.map((c) => (
        <li key={c.key} className="flex flex-wrap items-center justify-between gap-x-3 px-3 py-2">
          <span className="text-body-sm text-brand-text">{c.name}</span>
          <span className="flex items-center gap-2 text-caption text-brand-text-secondary">
            <span className="sr-only">{t('identity.contacts.key')}: </span>
            <span translate="no" className="font-mono">{c.key}</span>
            {removable && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => { setContacts((list) => list.filter((x) => x.key !== c.key)); simulatedToast(t('settings.contacts.removed', { name: c.name })) }}
                className="touch:min-h-11"
              >
                {t('settings.contacts.remove')}<span className="sr-only">: {c.name}</span>
              </Button>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

function ResultCard({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg bg-brand-elevated p-3">
      <h3 className="flex items-center gap-2 text-sm font-medium text-brand-text">
        <Icon aria-hidden="true" className="size-icon-sm shrink-0 text-brand-text-secondary" />{title}
      </h3>
      <div className="mt-1.5 space-y-1 text-body-sm text-brand-text-secondary">{children}</div>
    </section>
  )
}

/** "Proprietário" / "Administrador delegado" · "Hospedado em: …" (plain labels; never proven by a payment or a wallet). */
export function MarketRoleLine({ role, infrastructure, className }: { role: MarketRole; infrastructure: MarketInfrastructure; className?: string }) {
  return (
    <span className={cn('text-caption text-brand-text-secondary', className)}>
      {t(role === 'owner' ? 'identity.role.owner' : 'identity.role.delegated')} · {t('identity.hosted', { where: t(HOSTED_KEY[infrastructure]) })}
    </span>
  )
}

const HostDependency = () => <Fact icon={Server}>{t('identity.markets.host')}</Fact>

/** "Seus mercados" in the recovery result: administration can come back only after the safety period, with no objection and a cooperating host. */
function RecoveredMarkets() {
  return (
    <section aria-labelledby="identity-markets" className="space-y-2">
      <h3 id="identity-markets" className="text-sm font-medium text-brand-text">{t('identity.markets.title')}</h3>
      <p className="text-body-sm text-brand-text-secondary">{t('identity.markets.principle')}</p>
      <p className="text-body-sm text-brand-text">{t('identity.markets.wait')}</p>
      <HostDependency />
      <ul className="divide-y divide-brand-border-subtle rounded-lg bg-brand-elevated">
        {DEMO_ADMIN_MARKETS.map((m) => {
          const { icon: Icon, tone } = RECOVERY_STATE[m.state]
          return (
            <li key={m.name} className="px-3 py-2">
              <span className="block text-body-sm text-brand-text">{m.name} <span className="text-caption text-brand-text-secondary">· {t('markets.fictionalExample')}</span></span>
              <MarketRoleLine role={m.role} infrastructure={m.infrastructure} className="block" />
              <span className="block text-caption text-brand-text-secondary">{t('identity.identityAt', { domain: DEMO_IDENTITY_DOMAIN })}</span>
              <span className="mt-0.5 flex items-center gap-1.5 text-caption text-brand-text">
                <Icon aria-hidden="true" className={cn('size-icon-sm shrink-0', tone)} />{t(`identity.markets.${m.state}`)}
              </span>
              {m.state === 'pending' && m.daysLeft !== undefined && (
                <span className="mt-0.5 block text-caption tabular-nums text-brand-text-secondary">{t('identity.markets.daysLeft', { count: m.daysLeft })}</span>
              )}
              {m.state === 'notConfirmed' && (
                <>
                  <span className="mt-0.5 block text-caption text-brand-text-secondary">{t('identity.markets.notConfirmedHelp')}</span>
                  <Button type="button" size="sm" variant="secondary" onClick={() => simulatedToast()} className="mt-1.5 touch:min-h-11">
                    {t('identity.markets.retry')}<span className="sr-only">: {m.name}</span>
                  </Button>
                </>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** The recovery result: identity / social data / funds kept apart, then reputation, groups, markets and contacts. */
function RecoveryResult({ doneLabel, onDone }: { doneLabel: string; onDone: () => void }) {
  return (
    <>
      <StepHeader title={t('identity.result.title')} />
      <div className="grid gap-2">
        <ResultCard icon={Fingerprint} title={t('identity.result.identity')}>
          <p className="flex items-center gap-1.5 text-brand-text"><CircleCheck aria-hidden="true" className="size-icon-sm text-brand-success-fg" />{t('identity.result.identityValue')}</p>
        </ResultCard>
        <ResultCard icon={FileLock2} title={t('identity.result.social')}>
          <p>{t('identity.result.socialFuture')}</p>
          <p>{t('identity.result.found')}</p>
          <ul className="list-disc pl-5 text-brand-text">
            <li>{t('identity.result.contacts', { count: DEMO_CONTACTS.length })}</li>
            <li>{t('identity.result.groups', { count: DEMO_GROUPS.length })}</li>
            <li>{t('identity.result.favorites', { count: DEMO_FAVORITES })}</li>
          </ul>
        </ResultCard>
        <ResultCard icon={Wallet} title={t('identity.result.funds')}>
          <p>{t('identity.limits.funds')}</p>
        </ResultCard>
      </div>
      <Fact icon={Star}>{t('identity.result.reputation')}</Fact>
      <Fact icon={MessageSquareOff}>{t('identity.limits.messages')}</Fact>

      <section aria-labelledby="identity-groups" className="space-y-2">
        <h3 id="identity-groups" className="text-sm font-medium text-brand-text">{t('identity.groups.title')}</h3>
        <p className="text-body-sm text-brand-text-secondary">{t('identity.groups.note')}</p>
        <ul className="divide-y divide-brand-border-subtle rounded-lg bg-brand-elevated">
          {DEMO_GROUPS.map((g) => {
            const { icon: Icon, tone } = GROUP_STATE[g.state]
            return (
              <li key={g.name} className="px-3 py-2">
                <span className="block text-body-sm text-brand-text">{g.name} <span className="text-caption text-brand-text-secondary">· {t('markets.fictionalExample')}</span></span>
                <span className="mt-0.5 flex items-center gap-1.5 text-caption text-brand-text">
                  <Icon aria-hidden="true" className={cn('size-icon-sm shrink-0', tone)} />{t(`identity.groups.${g.state}`)}
                </span>
                {g.state === 'expired' && <span className="mt-0.5 block text-caption text-brand-text-secondary">{t('identity.groups.expiredAction')}</span>}
              </li>
            )
          })}
        </ul>
      </section>

      <RecoveredMarkets />

      <section aria-labelledby="identity-contacts" className="space-y-2">
        <h3 id="identity-contacts" className="text-sm font-medium text-brand-text">{t('identity.contacts.title')}</h3>
        <ContactsList />
      </section>
      <Note />
      <Button onClick={onDone} className="w-full touch:min-h-11">{doneLabel}</Button>
    </>
  )
}

/** "Recuperar minha identidade": restore the identity app, scan and approve, social data (future), result. */
export function RecoveryFlow({ onExit, onDone, doneLabel }: { onExit?: () => void; onDone: () => void; doneLabel: string }) {
  const [step, setStep] = useState(0)
  const next = () => setStep((s) => s + 1)
  const back = () => setStep((s) => s - 1)
  if (step === 0) return (
    <>
      <StepHeader step={1} total={3} title={t('identity.recover.s1.title')} description={t('identity.recover.s1.text')} onBack={onExit} />
      <WhatIs />
      <Disclosure summary={t('identity.loseAll.title')}>{t('identity.loseAll.text')}</Disclosure>
      <Button onClick={next} className="w-full touch:min-h-11">{t('identity.recover.s1.action')}</Button>
    </>
  )
  if (step === 1) return (
    <>
      <StepHeader step={2} total={3} title={t('identity.recover.s2.title')} description={t('identity.recover.s2.text')} onBack={back} />
      <QrApproval />
      <Button onClick={next} className="w-full touch:min-h-11">{t('identity.approved')}</Button>
    </>
  )
  if (step === 2) return (
    <>
      <StepHeader step={3} total={3} title={t('identity.recover.s3.title')} description={t('identity.recover.s3.text')} onBack={back} />
      <Button onClick={next} className="w-full touch:min-h-11">{t('identity.recover.s3.action')}</Button>
    </>
  )
  return <RecoveryResult doneLabel={doneLabel} onDone={onDone} />
}

/**
 * The owner's notice on the old device (demo: Meus mercados): a pending recovery of their market, with "Contestar"
 * (the veto). Channels shown: in-app notice and wallet push, both simulated.
 */
export function RecoveryObjectionBanner({ marketName }: { marketName: string }) {
  const [confirming, setConfirming] = useState(false)
  const [sent, setSent] = useState(false)
  return (
    <section aria-labelledby="identity-objection" className="space-y-2 rounded-lg bg-brand-warning-bg p-3">
      <h2 id="identity-objection" className="flex flex-wrap items-center gap-2 text-sm font-medium text-brand-text">
        <BellRing aria-hidden="true" className="size-icon-sm shrink-0 text-brand-warning-fg" />
        {t('identity.objection.text', { name: marketName })}{simulated()}
      </h2>
      <p className="text-caption text-brand-text-secondary">{t('identity.objection.channels')}</p>
      <p className="text-body-sm text-brand-text">{t('identity.objection.revoke')}</p>
      {sent ? (
        <p role="status" className="flex items-center gap-1.5 text-body-sm text-brand-text"><CircleCheck aria-hidden="true" className="size-icon-sm shrink-0 text-brand-success-fg" />{t('identity.objection.sent')}</p>
      ) : (
        <Button type="button" variant="destructive" size="sm" onClick={() => setConfirming(true)} className="touch:min-h-11">{t('identity.objection.action')}</Button>
      )}
      <ConfirmActionDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('identity.objection.confirmTitle', { name: marketName })}
        consequence={t('identity.objection.confirmBody')}
        confirmLabel={t('identity.objection.action')}
        tone="danger"
        onConfirm={() => { setConfirming(false); setSent(true); simulatedToast() }}
      />
    </section>
  )
}

/** Market page › Sobre (demo): host and identity labels, the host dependency, and a recent owner change when there is one. */
export function MarketRecoveryAbout({ marketId, infrastructure, className }: { marketId: string; infrastructure: MarketInfrastructure; className?: string }) {
  const change = DEMO_RECENT_OWNER_CHANGE[marketId]
  return (
    <section aria-labelledby="market-ownership" className={cn('space-y-2', className)}>
      <h2 id="market-ownership" className="flex flex-wrap items-center gap-2 text-section-title">{t('identity.about.title')}{simulated()}</h2>
      <p className="text-body-sm text-brand-text-secondary">
        {t('identity.hosted', { where: t(HOSTED_KEY[infrastructure]) })}
        <span className="block">{t('identity.identityAt', { domain: DEMO_IDENTITY_DOMAIN })}</span>
      </p>
      <HostDependency />
      {change && (
        <div role="note" className="space-y-1 rounded-lg bg-brand-warning-bg p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-brand-text"><RotateCcw aria-hidden="true" className="size-icon-sm shrink-0 text-brand-warning-fg" />{t('identity.ownerChange.title')}</p>
          <ol className="list-decimal space-y-0.5 pl-5 text-body-sm text-brand-text">
            <li>{t('identity.ownerChange.requested', { count: change.requestedDaysAgo })}</li>
            <li>{t('identity.ownerChange.window')}</li>
            <li>{t('identity.ownerChange.done', { count: change.doneDaysAgo })}</li>
          </ol>
        </div>
      )}
    </section>
  )
}

/** Criar mercado › Opções avançadas: who can recover the market (demo); real mode shows the planned item. */
export function RecoveryAuthorityChoice({ name }: { name: string }) {
  const [value, setValue] = useState<'self' | 'group'>('self')
  if (!isDemoMode()) return <WirePlanned id="marketRecoveryAuthority" label={t('identity.recovery.legend')} description={t('identity.recovery.help')} />
  return (
    <RadioGroup legend={<span className="inline-flex flex-wrap items-center gap-2">{t('identity.recovery.legend')}{simulated()}</span>} description={t('identity.recovery.help')} listClassName="grid gap-2">
      {(['self', 'group'] as const).map((v) => (
        <RadioCard key={v} name={name} value={v} checked={value === v} onChange={() => setValue(v)} className="items-start">
          <span className="min-w-0">
            <span className="block">{t(v === 'self' ? 'identity.recovery.self' : 'identity.recovery.group')}</span>
            <span className="block text-caption font-normal text-brand-text-secondary">{t(v === 'self' ? 'identity.recovery.selfHelp' : 'identity.recovery.groupHelp')}</span>
          </span>
        </RadioCard>
      ))}
    </RadioGroup>
  )
}

const DIALOG_CLASS = 'max-w-lg max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto'

/** Configurações › Identidade e recuperação: status, Ativar / Recuperar, what the portable record holds, contacts, backup link. */
export function PortableIdentityRows() {
  const demo = isDemoMode()
  const [open, setOpen] = useState<'activate' | 'recover' | null>(null)
  const close = () => setOpen(null)
  const soon = t('common.soon')
  const withBadge = (text: string) => <>{simulated('mr-1.5')}{text}</>
  return (
    <>
      <SettingsRow
        icon={LOOSE_WIRES.portableIdentity.icon}
        label={t('identity.status.label')}
        description={t('identity.status.description')}
        value={demo ? t('identity.status.demo') : t('identity.status.real')}
      />
      {demo ? (
        <>
          <SettingsRow icon={Fingerprint} label={t('identity.activate.row')} description={withBadge(t('identity.activate.rowDescription'))} onClick={() => setOpen('activate')} />
          <SettingsRow icon={RotateCcw} label={t('identity.recover.row')} description={withBadge(t('identity.recover.rowDescription'))} onClick={() => setOpen('recover')} />
        </>
      ) : (
        <>
          <SettingsRow icon={Fingerprint} label={t('identity.activate.row')} description={t('identity.activate.rowDescription')} plannedLabel={soon} />
          <SettingsRow icon={RotateCcw} label={t('identity.recover.row')} description={t('identity.recover.rowDescription')} plannedLabel={soon} />
        </>
      )}
      <li className="flex items-start gap-3 px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-elevated">
          <FileLock2 aria-hidden="true" className="h-4 w-4 text-brand-text-secondary" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3 className="text-sm font-medium text-brand-text">{t('identity.social.title')}</h3>
          <p className="text-body-sm text-brand-text-secondary">{t('identity.social.included')}</p>
          <p className="max-w-[68ch] text-body-sm text-brand-text-secondary">{t('identity.social.excluded')}</p>
          <p className="max-w-[68ch] text-body-sm text-brand-text-secondary">{t('identity.social.today')}</p>
          <p className="max-w-[68ch] text-body-sm text-brand-text-secondary">{t('identity.limits.messages')}</p>
        </div>
      </li>
      {demo ? (
        <li className="flex items-start gap-3 px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-elevated">
            <LOOSE_WIRES.savedContacts.icon aria-hidden="true" className="h-4 w-4 text-brand-text-secondary" />
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium text-brand-text">{t('identity.contacts.title')}{simulated()}</h3>
              <p className="text-caption text-brand-text-secondary">{t('identity.contacts.description')} {t('identity.contacts.local')}</p>
            </div>
            <ContactsList removable />
          </div>
        </li>
      ) : (
        <SettingsRow icon={LOOSE_WIRES.savedContacts.icon} label={t('identity.contacts.title')} description={t('identity.contacts.local')} plannedLabel={soon} />
      )}
      {/* R0 backup (escrow keys, asked only with an open escrow) is a separate thing from the identity and the social record. */}
      <SettingsRow icon={KeyRound} label={t('identity.backup.label')} description={t('identity.backup.description')} to="/settings?section=seguranca" />
      {demo && (
        <Dialog open={open !== null} onOpenChange={(o) => !o && close()}>
          <DialogContent className={DIALOG_CLASS}>
            {open === 'activate' ? <ActivationFlow onDone={close} /> : <RecoveryFlow onDone={close} doneLabel={t('identity.finish')} />}
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
