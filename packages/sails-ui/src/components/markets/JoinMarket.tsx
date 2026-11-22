/**
 * Layer A: "Entrar em mercado privado". A pasted Sails Market Invite (never a public identifier alone), a QR entry
 * slot, and one status block per invite state (lib/marketInvite.ts). The invite text is never parsed here: checking
 * it is the protocol's job. State is owned by the caller; copy from props, tokens only.
 */
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { CheckCircle2, Clock, Hourglass, TimerOff, UserX, type LucideIcon } from 'lucide-react'
import { Alert, type AlertTone } from '../ui/alert'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import { Textarea } from '../ui/textarea'
import { canSubmitInvite, type InviteState } from '../../lib/marketInvite'

type ShownState = Exclude<InviteState, 'idle'>

export interface InviteStatusCopy {
  states: Record<ShownState, { title: string; description: string }>
}

const LOOK: Record<ShownState, { tone: AlertTone; Icon: LucideIcon }> = {
  validating: { tone: 'info', Icon: Hourglass },
  pending: { tone: 'info', Icon: Clock },
  granted: { tone: 'success', Icon: CheckCircle2 },
  expired: { tone: 'warning', Icon: TimerOff },
  revoked: { tone: 'danger', Icon: UserX },
}

/** One block per state; renders nothing for 'idle'. `live` announces it when it changes. */
export function InviteStatus({ state, copy, live = false, action, className }: {
  state: InviteState
  copy: InviteStatusCopy
  live?: boolean
  action?: ReactNode
  className?: string
}) {
  if (state === 'idle') return null
  const { tone, Icon } = LOOK[state]
  const text = copy.states[state]
  return (
    <Alert tone={tone} icon={Icon} live={live} title={text.title} action={action} className={className}>
      <p>{text.description}</p>
      {state === 'validating' && <Progress className="mt-2" label={text.title} />}
    </Alert>
  )
}

export interface JoinMarketCopy extends InviteStatusCopy {
  invite: string
  inviteHelp: string
  submit: string
  another: string
}

export function JoinMarketForm({ copy, state, contractAvailable, unavailableNote, qrEntry, demoControls, onSubmit, onReset }: {
  copy: JoinMarketCopy
  state: InviteState
  /** False = no contract: submit stays disabled and `unavailableNote` says why. */
  contractAvailable: boolean
  unavailableNote?: ReactNode
  /** The QR Code entry (planned item until a camera flow exists). */
  qrEntry?: ReactNode
  /** Demo-only controls that answer for the protocol; never passed in real mode. */
  demoControls?: ReactNode
  onSubmit: (invite: string) => void
  onReset: () => void
}) {
  const id = useId()
  const [value, setValue] = useState('')
  const canSubmit = canSubmitInvite(state, value, contractAvailable)
  const final = state === 'granted' || state === 'expired' || state === 'revoked'

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (canSubmit) onSubmit(value.trim())
  }
  const reset = () => { setValue(''); onReset() }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor={`${id}-invite`} className="text-sm font-medium text-brand-text">{copy.invite}</label>
        <Textarea
          id={`${id}-invite`}
          name="market-invite"
          className="mt-1 min-h-24 font-mono text-body-sm"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          readOnly={state !== 'idle'}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-invite-help`}
        />
        <p id={`${id}-invite-help`} className="mt-1 text-caption text-brand-text-muted">{copy.inviteHelp}</p>
      </div>
      {qrEntry}
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        {final ? (
          <Button type="button" variant="secondary" onClick={reset} className="touch:min-h-11">{copy.another}</Button>
        ) : (
          <Button
            type="submit"
            disabled={!canSubmit}
            loading={state === 'validating'}
            aria-describedby={!contractAvailable && unavailableNote ? `${id}-unavailable` : undefined}
            className="touch:min-h-11"
          >
            {copy.submit}
          </Button>
        )}
      </div>
      {!contractAvailable && unavailableNote && <div id={`${id}-unavailable`}>{unavailableNote}</div>}
      <div aria-live="polite">
        <InviteStatus state={state} copy={copy} />
      </div>
      {demoControls}
    </form>
  )
}
