/**
 * Layer A: "Criar mercado", one step at a time (lib/createMarket.ts): identity, visibility, participation,
 * infrastructure (secondary), review and, for a private market, participants and invites. Visibility, participation
 * and infrastructure are separate choices. The final action always hands the draft to `onCreate` (the caller shows a
 * preview); `createAvailable` false only adds `unavailableNote` under it. `participantsAvailable` false = the
 * participant field and "generate invite" stay disabled with `participantsUnavailableNote`. Nothing is ever sent from
 * here. Copy from props, tokens only.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Ticket, X } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { Progress } from '../ui/progress'
import { IconButton } from '../ui/icon-button'
import { RadioCard, RadioGroup } from '../ui/radio-group'
import { EMPTY_DRAFT, MARKET_NAME_MAX, addParticipant, canAdvance, createSteps, type CreateStep, type MarketDraft } from '../../lib/createMarket'
import type { MarketInfrastructure, MarketVisibility, ParticipationPreset } from '../../lib/myMarkets'

type Option<T extends string> = { value: T; label: string; description: string; disabled?: boolean }

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
  review: { name: string; description: string; visibility: string; participation: string; infrastructure: string; empty: string }
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

function Choice<T extends string>({ legend, name, options, value, onChange, note }: {
  legend: string
  name: string
  options: Option<T>[]
  value: T | null
  onChange: (v: T) => void
  note?: string
}) {
  return (
    <RadioGroup legend={legend} legendHidden description={note} listClassName="grid gap-2">
      {options.map((o) => (
        <RadioCard key={o.value} name={name} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} className="items-start">
          <span className="min-w-0">
            <span className="block">{o.label}</span>
            <span className="block text-caption font-normal text-brand-text-secondary">{o.description}</span>
          </span>
        </RadioCard>
      ))}
    </RadioGroup>
  )
}

export function CreateMarketWizard({ copy, brandingSlot, invitesSlot, createAvailable, unavailableNote, participantsAvailable, participantsUnavailableNote, onCreate }: {
  copy: CreateMarketCopy
  /** Logo and colors (planned item until branding exists). */
  brandingSlot?: ReactNode
  /** Participants and invites for a private market (planned item until invites exist). */
  invitesSlot?: ReactNode
  createAvailable: boolean
  unavailableNote?: ReactNode
  participantsAvailable: boolean
  participantsUnavailableNote?: ReactNode
  onCreate?: (draft: MarketDraft) => void
}) {
  const id = useId()
  const [draft, setDraft] = useState<MarketDraft>(EMPTY_DRAFT)
  const [index, setIndex] = useState(0)
  const [participant, setParticipant] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const steps = createSteps(draft.visibility)
  const step = steps[Math.min(index, steps.length - 1)]
  const last = index >= steps.length - 1
  const set = <K extends keyof MarketDraft>(key: K, value: MarketDraft[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const label = <T extends string>(options: Option<T>[], v: T | null) => options.find((o) => o.value === v)?.label ?? copy.review.empty

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
          {brandingSlot}
        </div>
      )
      break
    case 'visibility':
      body = <Choice legend={copy.steps.visibility} name={`${id}-visibility`} options={copy.visibility} value={draft.visibility} onChange={(v) => set('visibility', v)} note={copy.visibilityNote} />
      break
    case 'participation':
      body = <Choice legend={copy.steps.participation} name={`${id}-preset`} options={copy.participation} value={draft.preset} onChange={(v) => set('preset', v)} note={copy.participationNote} />
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
            [copy.review.visibility, label(copy.visibility, draft.visibility)],
            [copy.review.participation, label(copy.participation, draft.preset)],
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
          <Button type="button" aria-describedby={!createAvailable && unavailableNote ? `${id}-unavailable` : undefined} onClick={() => onCreate?.(draft)} className="touch:min-h-11">
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
