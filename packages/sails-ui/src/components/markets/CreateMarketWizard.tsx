/**
 * Layer A: "Criar mercado", one step at a time (lib/createMarket.ts): identity, visibility, participation,
 * infrastructure (secondary), review and, for a private market, participants and invites. Visibility, participation
 * and infrastructure are separate choices. The final action always hands the draft to `onCreate` (the caller shows a
 * preview); `createAvailable` false only adds `unavailableNote` under it. `participantsAvailable` false = the
 * participant field and "generate invite" stay disabled with `participantsUnavailableNote`. Nothing is ever sent from
 * here. Copy from props, tokens only.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Checkbox } from '../ui/checkbox'
import { ImagePicker, type ImagePickerCopy } from './ImagePicker'
import { ArrowLeft, ArrowRight, ChevronDown, Ticket, X } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { Progress } from '../ui/progress'
import { IconButton } from '../ui/icon-button'
import { RadioCard, RadioGroup } from '../ui/radio-group'
import { EMPTY_DRAFT, MARKET_NAME_MAX, addParticipant, canAdvance, createSteps, parseUsdWhole, type CreateStep, type MarketDraft } from '../../lib/createMarket'
import { safeHttpsUrl } from '../../lib/marketSpaces'
import type { KycMode, MarketCategory, MarketProfile, SocialLogin } from '../../lib/marketContract'
import type { MarketInfrastructure, MarketVisibility, ParticipationPreset } from '../../lib/myMarkets'

type Option<T extends string> = { value: T; label: string; description?: string; disabled?: boolean }
type ImageKey = 'iconUrl' | 'bannerUrl' | 'coverUrl'

export interface CreateMarketCopy {
  steps: Record<CreateStep, string>
  progress: (at: number, total: number, title: string) => string
  name: string
  nameHelp: (max: number) => string
  description: string
  descriptionOptional: string
  visibility: Option<MarketVisibility>[]
  visibilityNote: string
  participation: Option<ParticipationPreset>[]
  participationNote: string
  infrastructure: Option<MarketInfrastructure>[]
  infrastructureNote: string
  category: { legend: string; options: Option<MarketCategory>[] }
  profile: { legend: string; note: string; options: Option<MarketProfile>[] }
  images: { icon: ImagePickerCopy; banner: ImagePickerCopy; cover: ImagePickerCopy; coverToggle: string; note: string }
  /** "Opções avançadas" (KYC and social login, collapsed). */
  advanced: string
  entry: {
    lead: string
    kycLegend: string
    kyc: Option<KycMode>[]
    threshold: string
    thresholdHelp: string
    thresholdError: string
    provider: string
    providerHelp: string
    providerError: string
    socialLegend: string
    socialHelp: string
    social: Option<SocialLogin>[]
    responsibility: string
    /** What a policy can and cannot do (CTO 31): it never touches funds or a trade in escrow. */
    limits: string
    summary: (d: MarketDraft) => string
  }
  review: { name: string; description: string; visibility: string; participation: string; infrastructure: string; empty: string; category: string; profile: string; entry: string }
  invites: {
    identifier: string
    identifierHelp: string
    identifierPlaceholder: string
    generate: string
    listLabel: string
    empty: string
    pending: string
    remove: (identifier: string) => string
  }
  back: string
  next: string
  create: string
}

function Choice<T extends string>({ legend, name, options, value, onChange, note, legendVisible = false, columns = false }: {
  legend: string
  name: string
  options: Option<T>[]
  value: T | null
  onChange: (v: T) => void
  note?: string
  legendVisible?: boolean
  columns?: boolean
}) {
  return (
    <RadioGroup legend={legend} legendHidden={!legendVisible} description={note} listClassName={columns ? 'grid gap-2 sm:grid-cols-2' : 'grid gap-2'}>
      {options.map((o) => (
        <RadioCard key={o.value} name={name} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} className="items-start">
          <span className="min-w-0">
            <span className="block">{o.label}</span>
            {o.description && <span className="block text-caption font-normal text-brand-text-secondary">{o.description}</span>}
          </span>
        </RadioCard>
      ))}
    </RadioGroup>
  )
}

export function CreateMarketWizard({ copy, initial, privateHostingSlot, brandingSlot, invitesSlot, createAvailable, unavailableNote, participantsAvailable, participantsUnavailableNote, onCreate, primarySolid = true }: {
  copy: CreateMarketCopy
  /** Starting values (e.g. the kind of space bought in the demo); everything stays editable. */
  initial?: Partial<MarketDraft>
  /** Shown under the visibility choice when the market is private (where it runs; single node in Day 0). */
  privateHostingSlot?: ReactNode
  /** Logo and colors (planned item until branding exists). */
  brandingSlot?: ReactNode
  /** Participants and invites for a private market (planned item until invites exist). */
  invitesSlot?: ReactNode
  createAvailable: boolean
  unavailableNote?: ReactNode
  participantsAvailable: boolean
  participantsUnavailableNote?: ReactNode
  onCreate?: (draft: MarketDraft) => void
  /** False without a session: the topbar "Conectar wallet" is then the screen's only solid orange (DECISIONS.md). */
  primarySolid?: boolean
}) {
  const id = useId()
  const [draft, setDraft] = useState<MarketDraft>(() => ({ ...EMPTY_DRAFT, ...initial }))
  const [index, setIndex] = useState(0)
  const [participant, setParticipant] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const steps = createSteps(draft.visibility)
  const step = steps[Math.min(index, steps.length - 1)]
  const last = index >= steps.length - 1
  const set = <K extends keyof MarketDraft>(key: K, value: MarketDraft[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const label = <T extends string>(options: Option<T>[], v: T | null) => options.find((o) => o.value === v)?.label ?? copy.review.empty
  const [cover, setCover] = useState(false)
  const [advanced, setAdvanced] = useState(() => (initial?.kyc ?? 'none') !== 'none')
  // Local previews only: every object URL this wizard made is revoked when replaced and when it unmounts.
  const urls = useRef(new Set<string>())
  useEffect(() => () => { urls.current.forEach((u) => URL.revokeObjectURL(u)); urls.current.clear() }, [])
  const pick = (key: ImageKey) => (file: File | null) => {
    setDraft((d) => {
      const old = d[key]
      if (old) { URL.revokeObjectURL(old); urls.current.delete(old) }
      const next = file ? URL.createObjectURL(file) : null
      if (next) urls.current.add(next)
      return { ...d, [key]: next }
    })
  }
  const toggleSocial = (s: SocialLogin, on: boolean) => set('social', on ? [...draft.social.filter((x) => x !== s), s] : draft.social.filter((x) => x !== s))
  const thresholdBad = draft.kyc === 'above_threshold' && parseUsdWhole(draft.kycThreshold) === null
  const providerBad = draft.kyc !== 'none' && draft.kycProviderUrl.trim() !== '' && !safeHttpsUrl(draft.kycProviderUrl)

  // Move focus to the new step's heading so keyboard and screen-reader users land on it (not on first render).
  const moved = useRef(false)
  useEffect(() => { if (moved.current) headingRef.current?.focus(); moved.current = true }, [index])

  let body: ReactNode
  switch (step) {
    case 'identity':
      body = (
        <div className="space-y-4">
          <div>
            <label htmlFor={`${id}-name`} className="text-sm font-medium text-brand-text">{copy.name}</label>
            <Input id={`${id}-name`} name="market-name" className="mt-1" value={draft.name} maxLength={MARKET_NAME_MAX} autoComplete="off" onChange={(e) => set('name', e.target.value)} aria-describedby={`${id}-name-help`} />
            <p id={`${id}-name-help`} className="mt-1 text-caption text-brand-text-muted">{copy.nameHelp(MARKET_NAME_MAX)}</p>
          </div>
          <div>
            <label htmlFor={`${id}-desc`} className="text-sm font-medium text-brand-text">
              {copy.description} <span className="font-normal text-brand-text-secondary">{copy.descriptionOptional}</span>
            </label>
            <Textarea id={`${id}-desc`} name="market-description" className="mt-1" value={draft.description} onChange={(e) => set('description', e.target.value)} />
          </div>
          <Choice legend={copy.category.legend} legendVisible columns name={`${id}-category`} options={copy.category.options} value={draft.category} onChange={(v) => set('category', v)} />
          <Choice legend={copy.profile.legend} legendVisible columns name={`${id}-profile`} options={copy.profile.options} value={draft.profile} onChange={(v) => set('profile', v)} note={copy.profile.note} />
          <div className="space-y-4">
            <ImagePicker kind="icon" url={draft.iconUrl} copy={copy.images.icon} onPick={pick('iconUrl')} />
            <ImagePicker kind="banner" url={draft.bannerUrl} copy={copy.images.banner} onPick={pick('bannerUrl')} />
            {cover || draft.coverUrl ? (
              <ImagePicker kind="cover" url={draft.coverUrl} copy={copy.images.cover} onPick={pick('coverUrl')} />
            ) : (
              <Button type="button" size="sm" variant="ghost" onClick={() => setCover(true)} className="touch:min-h-11">{copy.images.coverToggle}</Button>
            )}
            <p className="text-caption text-brand-text-muted">{copy.images.note}</p>
          </div>
          {brandingSlot}
        </div>
      )
      break
    case 'visibility':
      body = (
        <div className="space-y-4">
          <Choice legend={copy.steps.visibility} name={`${id}-visibility`} options={copy.visibility} value={draft.visibility} onChange={(v) => set('visibility', v)} note={copy.visibilityNote} />
          {draft.visibility === 'private' && privateHostingSlot}
        </div>
      )
      break
    case 'participation':
      // Progressive disclosure (PO): KYC and social login stay under "Opções avançadas", default "Sem KYC".
      body = (
        <div className="space-y-4">
          <Choice legend={copy.steps.participation} name={`${id}-preset`} options={copy.participation} value={draft.preset} onChange={(v) => set('preset', v)} note={copy.participationNote} />
          <div>
            <button
              type="button" aria-expanded={advanced} aria-controls={`${id}-advanced`} onClick={() => setAdvanced((o) => !o)}
              className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-2 text-left text-sm font-medium text-brand-text state-layer focus-visible:-outline-offset-2"
            >
              <span className="min-w-0">
                <span className="block">{copy.advanced}</span>
                <span className="block text-caption font-normal text-brand-text-secondary">{copy.entry.summary(draft)}</span>
              </span>
              <ChevronDown aria-hidden="true" className={cn('h-4 w-4 shrink-0 text-brand-text-muted transition-transform duration-short', advanced && 'rotate-180')} />
            </button>
            <div id={`${id}-advanced`} hidden={!advanced} className="pt-3">
        <div className="space-y-5">
              <p className="text-body-sm text-brand-text-secondary">{copy.entry.lead}</p>
              <Choice legend={copy.entry.kycLegend} legendVisible name={`${id}-kyc`} options={copy.entry.kyc} value={draft.kyc} onChange={(v) => set('kyc', v)} />
              {draft.kyc === 'above_threshold' && (
                <div>
                  <label htmlFor={`${id}-threshold`} className="text-sm font-medium text-brand-text">{copy.entry.threshold}</label>
                  <Input
                    id={`${id}-threshold`} name="kyc-threshold" inputMode="numeric" autoComplete="off" className="mt-1 max-w-48 tabular-nums" value={draft.kycThreshold}
                    aria-invalid={thresholdBad || undefined} aria-describedby={`${id}-threshold-help`} onChange={(e) => set('kycThreshold', e.target.value)}
                  />
                  <p id={`${id}-threshold-help`} className={thresholdBad ? 'mt-1 text-caption text-brand-danger-fg' : 'mt-1 text-caption text-brand-text-muted'}>{thresholdBad ? copy.entry.thresholdError : copy.entry.thresholdHelp}</p>
                </div>
              )}
              {draft.kyc !== 'none' && (
                <div>
                  <label htmlFor={`${id}-provider`} className="text-sm font-medium text-brand-text">{copy.entry.provider}</label>
                  <Input
                    id={`${id}-provider`} name="kyc-provider" type="url" inputMode="url" autoComplete="off" spellCheck={false} className="mt-1" value={draft.kycProviderUrl}
                    placeholder="https://" aria-invalid={providerBad || undefined} aria-describedby={`${id}-provider-help`} onChange={(e) => set('kycProviderUrl', e.target.value)}
                  />
                  <p id={`${id}-provider-help`} className={providerBad ? 'mt-1 text-caption text-brand-danger-fg' : 'mt-1 text-caption text-brand-text-muted'}>{providerBad ? copy.entry.providerError : copy.entry.providerHelp}</p>
                </div>
              )}
              <fieldset>
                <legend className="text-sm font-medium text-brand-text">{copy.entry.socialLegend}</legend>
                <p className="mt-0.5 text-xs text-brand-text-muted">{copy.entry.socialHelp}</p>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
                  {copy.entry.social.map((o) => (
                    <div key={o.value} className="flex min-h-11 items-center gap-2">
                      <Checkbox id={`${id}-social-${o.value}`} checked={draft.social.includes(o.value)} onCheckedChange={(v) => toggleSocial(o.value, v === true)} />
                      <label htmlFor={`${id}-social-${o.value}`} className="cursor-pointer text-sm text-brand-text">{o.label}</label>
                    </div>
                  ))}
                </div>
              </fieldset>
              <div className="space-y-1 rounded-lg bg-brand-elevated p-3 text-caption text-brand-text-secondary">
                <p>{copy.entry.responsibility}</p>
                <p>{copy.entry.limits}</p>
              </div>
            </div>
            </div>
          </div>
        </div>
      )
      break
    case 'infrastructure':
      body = <Choice legend={copy.steps.infrastructure} name={`${id}-infra`} options={copy.infrastructure} value={draft.infrastructure} onChange={(v) => set('infrastructure', v)} note={copy.infrastructureNote} />
      break
    case 'review':
      body = (
        <dl className="divide-y divide-brand-border-subtle rounded-lg bg-brand-elevated">
          {([
            [copy.review.name, draft.name.trim() || copy.review.empty],
            [copy.review.description, draft.description.trim() || copy.review.empty],
            [copy.review.category, label(copy.category.options, draft.category)],
            [copy.review.profile, label(copy.profile.options, draft.profile)],
            [copy.review.visibility, label(copy.visibility, draft.visibility)],
            [copy.review.participation, label(copy.participation, draft.preset)],
            [copy.review.entry, copy.entry.summary(draft)],
            [copy.review.infrastructure, label(copy.infrastructure, draft.infrastructure)],
          ] as const).map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:gap-4">
              <dt className="text-caption text-brand-text-muted sm:w-36 sm:shrink-0">{k}</dt>
              <dd className="min-w-0 break-words text-body-sm text-brand-text">{v}</dd>
            </div>
          ))}
        </dl>
      )
      break
    case 'invites': {
      const add = () => { set('participants', addParticipant(draft.participants, participant)); setParticipant('') }
      body = (
        <div className="space-y-4">
          <form className="space-y-1" onSubmit={(e) => { e.preventDefault(); if (participantsAvailable) add() }}>
            <label htmlFor={`${id}-participant`} className="text-sm font-medium text-brand-text">{copy.invites.identifier}</label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id={`${id}-participant`} name="market-participant" className="min-w-0 sm:flex-1" value={participant} autoComplete="off" spellCheck={false}
                placeholder={copy.invites.identifierPlaceholder} disabled={!participantsAvailable}
                aria-describedby={`${id}-participant-help${!participantsAvailable && participantsUnavailableNote ? ` ${id}-participants-unavailable` : ''}`}
                onChange={(e) => setParticipant(e.target.value)}
              />
              <Button type="submit" variant="secondary" disabled={!participantsAvailable || !participant.trim()} className="shrink-0 touch:min-h-11">
                <Ticket aria-hidden="true" />{copy.invites.generate}
              </Button>
            </div>
            <p id={`${id}-participant-help`} className="text-caption text-brand-text-muted">{copy.invites.identifierHelp}</p>
          </form>
          {!participantsAvailable && participantsUnavailableNote && <div id={`${id}-participants-unavailable`}>{participantsUnavailableNote}</div>}
          <div>
            <h3 className="text-sm font-medium text-brand-text">{copy.invites.listLabel}</h3>
            {draft.participants.length === 0 ? (
              <p className="mt-1 text-body-sm text-brand-text-secondary">{copy.invites.empty}</p>
            ) : (
              <ul aria-label={copy.invites.listLabel} className="mt-2 divide-y divide-brand-border-subtle rounded-lg bg-brand-elevated">
                {draft.participants.map((p) => (
                  <li key={p} className="flex items-center gap-3 px-3 py-1.5">
                    <span translate="no" className="min-w-0 flex-1 break-all font-mono text-caption text-brand-text">{p}</span>
                    <span className="shrink-0 text-caption text-brand-text-secondary">{copy.invites.pending}</span>
                    <IconButton label={copy.invites.remove(p)} size="sm" onClick={() => set('participants', draft.participants.filter((x) => x !== p))}>
                      <X aria-hidden="true" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {invitesSlot}
        </div>
      )
      break
    }
  }

  const finalAction = (step === 'review' && draft.visibility !== 'private') || step === 'invites'
  return (
    <div className="space-y-4">
      <div>
        <h2 ref={headingRef} tabIndex={-1} className="text-section-title outline-none">
          {copy.progress(index + 1, steps.length, copy.steps[step])}
        </h2>
        <Progress className="mt-2" value={((index + 1) / steps.length) * 100} label={copy.progress(index + 1, steps.length, copy.steps[step])} />
      </div>
      {body}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button type="button" variant="secondary" disabled={index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))} className="touch:min-h-11">
          <ArrowLeft aria-hidden="true" />{copy.back}
        </Button>
        {finalAction ? (
          <Button type="button" variant={primarySolid ? 'default' : 'secondary'} aria-describedby={!createAvailable && unavailableNote ? `${id}-unavailable` : undefined} onClick={() => onCreate?.(draft)} className="touch:min-h-11">
            {copy.create}
          </Button>
        ) : (
          <Button type="button" variant="secondary" disabled={last || !canAdvance(step, draft)} onClick={() => setIndex((i) => i + 1)} className="touch:min-h-11">
            {copy.next}<ArrowRight aria-hidden="true" />
          </Button>
        )}
      </div>
      {finalAction && !createAvailable && unavailableNote && <div id={`${id}-unavailable`}>{unavailableNote}</div>}
    </div>
  )
}
