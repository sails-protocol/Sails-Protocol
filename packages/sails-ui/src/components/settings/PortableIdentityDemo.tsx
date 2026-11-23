/**
 * Layer C, demo only: portable identity (CTO 29, 2026-11-23). "Ativar o Sails P2P" (3 steps), "Recuperar minha
 * identidade" (3 steps + result) and the Configurações › Identidade e recuperação rows. Nothing here is real: no
 * identity is created, connected or recovered, nothing is read, stored or sent, and the record below is a fixture.
 * The flows render inside the caller's DialogContent (Login's dialog or the Settings dialog). Real mode renders only
 * the honest rows ("Não configurada", "Em breve"). Wires: portableIdentity, portableRecord, groupMembershipStatus,
 * savedContacts (lib/looseWires.ts).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import {
  ArrowLeft, ChevronDown, CircleAlert, CircleCheck, CircleOff, FileLock2, Fingerprint, KeyRound, Loader2, MessageSquareOff, Radio, RefreshCw,
  RotateCcw, SearchCheck, TimerOff, Wallet, type LucideIcon,
} from 'lucide-react'
import { SettingsRow } from './SettingsRow'
import { SimulatedBadge } from '../ui/SimulatedBadge'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { LOOSE_WIRES } from '../../lib/looseWires'
import { isDemoMode } from '../../lib/demoMarkers'
import { cn } from '../../lib/utils'
import type { MarketInfrastructure } from '../../lib/myMarkets'
import { simulatedToast } from '../../pages/markets/shared'
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

// Markets the recovered identity administers (demo, one per verification state). Fictional names, as in the fixtures.
export type MarketRole = 'owner' | 'delegated'
type OwnershipState = 'checking' | 'restored' | 'notConfirmed' | 'stale'
const DEMO_ADMIN_MARKETS: readonly { name: string; role: MarketRole; infrastructure: MarketInfrastructure; state: OwnershipState }[] = [
  { name: 'Meu Mercado Exemplo', role: 'owner', infrastructure: 'network', state: 'restored' },
  { name: 'Loja Exemplo', role: 'delegated', infrastructure: 'network', state: 'checking' },
  { name: 'Clientes Empresa ABC', role: 'owner', infrastructure: 'own', state: 'notConfirmed' },
  { name: 'Boreal OTC', role: 'delegated', infrastructure: 'managed', state: 'stale' },
]
const OWNERSHIP_STATE: Record<OwnershipState, { icon: LucideIcon; tone: string }> = {
  checking: { icon: Loader2, tone: 'text-brand-info-fg motion-safe:animate-spin' },
  restored: { icon: CircleCheck, tone: 'text-brand-success-fg' },
  notConfirmed: { icon: CircleAlert, tone: 'text-brand-warning-fg' },
  stale: { icon: RefreshCw, tone: 'text-brand-warning-fg' },
}
const HOSTED_KEY = { network: 'markets.create.infrastructure.networkLabel', own: 'markets.list.infrastructure.own', managed: 'markets.create.infrastructure.managedLabel' } as const

/** "Proprietário" / "Administrador delegado" · "Hospedado em: …" (plain labels; the role is never proven by a payment or a wallet). */
export function MarketRoleLine({ role, infrastructure, className }: { role: MarketRole; infrastructure: MarketInfrastructure; className?: string }) {
  return (
    <span className={cn('text-caption text-brand-text-secondary', className)}>
      {t(role === 'owner' ? 'identity.role.owner' : 'identity.role.delegated')} · {t('identity.hosted', { where: t(HOSTED_KEY[infrastructure]) })}
    </span>
  )
}

/** "Seus mercados" in the recovery result: administration comes back only when the ownership check passes. */
function RecoveredMarkets() {
  const [states, setStates] = useState(() => DEMO_ADMIN_MARKETS.map((m) => m.state))
  const retry = (i: number) => {
    // Demo: the check runs again and lands on the same fixture result; nothing is sent.
    setStates((s) => s.map((v, j) => (j === i ? 'checking' : v)))
    simulatedToast()
    setTimeout(() => setStates((s) => s.map((v, j) => (j === i ? DEMO_ADMIN_MARKETS[i].state : v))), 1200)
  }
  return (
    <section aria-labelledby="identity-markets" className="space-y-2">
      <h3 id="identity-markets" className="text-sm font-medium text-brand-text">{t('identity.markets.title')}</h3>
      <p className="text-body-sm text-brand-text-secondary">{t('identity.markets.principle')} {t('identity.markets.note')}</p>
      <ul className="divide-y divide-brand-border-subtle rounded-lg bg-brand-elevated">
        {DEMO_ADMIN_MARKETS.map((m, i) => {
          const state = states[i]
          const { icon: Icon, tone } = OWNERSHIP_STATE[state]
          return (
            <li key={m.name} className="px-3 py-2">
              <span className="block text-body-sm text-brand-text">{m.name} <span className="text-caption text-brand-text-secondary">· {t('markets.fictionalExample')}</span></span>
              <MarketRoleLine role={m.role} infrastructure={m.infrastructure} className="block" />
              <span role="status" className="mt-0.5 flex items-center gap-1.5 text-caption text-brand-text">
                <Icon aria-hidden="true" className={cn('size-icon-sm shrink-0', tone)} />{t(`identity.markets.${state}`)}
              </span>
              {state === 'notConfirmed' && <span className="mt-0.5 block text-caption text-brand-text-secondary">{t('identity.markets.notConfirmedHelp')}</span>}
              {(state === 'notConfirmed' || state === 'stale') && (
                <Button type="button" size="sm" variant="secondary" onClick={() => retry(i)} className="mt-1.5 touch:min-h-11">
                  {t('identity.markets.retry')}<span className="sr-only">: {m.name}</span>
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// Icon + text for every state, never color alone.
const GROUP_STATE: Record<GroupState, { icon: LucideIcon; tone: string }> = {
  found: { icon: SearchCheck, tone: 'text-brand-info-fg' },
  valid: { icon: CircleCheck, tone: 'text-brand-success-fg' },
  expired: { icon: TimerOff, tone: 'text-brand-warning-fg' },
  unavailable: { icon: CircleOff, tone: 'text-brand-text-secondary' },
}

const simulated = () => <SimulatedBadge label={t('spaces.simulated')} />

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

/** What a portable record never brings back (shown at the end of both flows). */
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

/** "O que é isso?": the one place that names Pubky (native disclosure, keyboard and screen reader for free). */
function WhatIs() {
  return (
    <details className="group rounded-lg bg-brand-elevated px-3">
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 text-body-sm font-medium text-brand-text touch:min-h-11">
        {t('identity.whatIs')}<ChevronDown aria-hidden="true" className="size-icon-sm shrink-0 text-brand-text-secondary group-open:rotate-180" />
      </summary>
      <p className="pb-3 text-body-sm text-brand-text-secondary">{t('identity.whatIsText')}</p>
    </details>
  )
}

const Note = () => <p className="text-caption text-brand-text-secondary">{t('spaces.simulated.toast')}</p>

/** "Ativar o Sails P2P": identity created, portable identity, communication. `onDone` closes the host dialog. */
export function ActivationFlow({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const back = () => setStep((s) => s - 1)
  if (step === 0) return (
    <>
      <StepHeader step={1} total={3} title={t('identity.activate.s1.title')} description={t('identity.activate.s1.text')} />
      <Fact icon={KeyRound} tone="text-brand-info">{t('identity.status.description')}</Fact>
      <Button onClick={() => setStep(1)} className="w-full touch:min-h-11">{t('identity.continue')}</Button>
    </>
  )
  if (step === 1) return (
    <>
      <StepHeader step={2} total={3} title={t('identity.activate.s2.title')} description={t('identity.activate.s2.text')} onBack={back} />
      <WhatIs />
      <div className="grid gap-2">
        <Button onClick={() => setStep(2)} className="w-full touch:min-h-11">{t('identity.activate.s2.create')}</Button>
        <Button variant="secondary" onClick={() => setStep(2)} className="w-full touch:min-h-11">{t('identity.activate.s2.connect')}</Button>
      </div>
    </>
  )
  if (step === 2) return (
    <>
      <StepHeader step={3} total={3} title={t('identity.activate.s3.title')} description={t('identity.activate.s3.text')} onBack={back} />
      <Fact icon={Radio} tone="text-brand-success-fg">{t('identity.activate.s3.nothing')}</Fact>
      <Button onClick={() => setStep(3)} className="w-full touch:min-h-11">{t('identity.finish')}</Button>
    </>
  )
  return (
    <>
      <StepHeader title={t('identity.activate.row')} />
      <p role="status" className="flex items-start gap-2 text-body text-brand-text">
        <CircleCheck aria-hidden="true" className="mt-0.5 size-icon-md shrink-0 text-brand-success-fg" />{t('identity.activate.done')}
      </p>
      <Limits onLeave={onDone} />
      <Note />
      <Button variant="secondary" onClick={onDone} className="w-full touch:min-h-11">{t('settings.backup.close')}</Button>
    </>
  )
}

/** Saved contacts (demo): nickname + abbreviated public key. */
export function ContactsList() {
  return (
    <ul className="divide-y divide-brand-border-subtle rounded-lg bg-brand-elevated">
      {DEMO_CONTACTS.map((c) => (
        <li key={c.key} className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-2">
          <span className="text-body-sm text-brand-text">{c.name}</span>
          <span className="text-caption text-brand-text-secondary">
            <span className="sr-only">{t('identity.contacts.key')}: </span>
            <span translate="no" className="font-mono">{c.key}</span>
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

/** The recovery result: identity / social data / funds kept apart, then groups and contacts. */
function RecoveryResult({ doneLabel, onDone }: { doneLabel: string; onDone: () => void }) {
  return (
    <>
      <StepHeader title={t('identity.result.title')} />
      <div className="grid gap-2">
        <ResultCard icon={Fingerprint} title={t('identity.result.identity')}>
          <p className="flex items-center gap-1.5 text-brand-text"><CircleCheck aria-hidden="true" className="size-icon-sm text-brand-success-fg" />{t('identity.result.identityValue')}</p>
        </ResultCard>
        <ResultCard icon={FileLock2} title={t('identity.result.social')}>
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

/** "Recuperar minha identidade": recover, authorize this app, restore social data, result. */
export function RecoveryFlow({ onExit, onDone, doneLabel }: { onExit?: () => void; onDone: () => void; doneLabel: string }) {
  const [step, setStep] = useState(0)
  const back = () => setStep((s) => s - 1)
  const STEPS = [
    { title: 'identity.recover.s1.title', text: 'identity.recover.s1.text', action: 'identity.recover.s1.action' },
    { title: 'identity.recover.s2.title', text: 'identity.recover.s2.text', action: 'identity.recover.s2.action' },
    { title: 'identity.recover.s3.title', text: 'identity.recover.s3.text', action: 'identity.recover.s3.action' },
  ] as const
  if (step >= STEPS.length) return <RecoveryResult doneLabel={doneLabel} onDone={onDone} />
  const s = STEPS[step]
  return (
    <>
      <StepHeader step={step + 1} total={STEPS.length} title={t(s.title)} description={t(s.text)} onBack={step > 0 ? back : onExit} />
      {step === 0 && (
        <WhatIs />
      )}
      <Button onClick={() => setStep(step + 1)} className="w-full touch:min-h-11">{t(s.action)}</Button>
    </>
  )
}

const DIALOG_CLASS = 'max-w-lg max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto'

/** Configurações › Identidade e recuperação: status, Ativar / Recuperar, what the portable record holds, contacts, backup link. */
export function PortableIdentityRows() {
  const demo = isDemoMode()
  const [open, setOpen] = useState<'activate' | 'recover' | null>(null)
  const close = () => setOpen(null)
  const soon = t('common.soon')
  const withBadge = (text: string) => <><SimulatedBadge label={t('spaces.simulated')} className="mr-1.5" />{text}</>
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
          <p className="text-body-sm text-brand-text-secondary">{t('identity.social.excluded')}</p>
          <p className="text-body-sm text-brand-text-secondary">{t('identity.limits.messages')}</p>
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
              <p className="text-caption text-brand-text-secondary">{t('identity.contacts.description')}</p>
            </div>
            <ContactsList />
          </div>
        </li>
      ) : (
        <SettingsRow icon={LOOSE_WIRES.savedContacts.icon} label={t('identity.contacts.title')} description={t('identity.contacts.description')} plannedLabel={soon} />
      )}
      {/* R0 backup (economic key, escrow keys) is a separate thing from the portable social record. */}
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
