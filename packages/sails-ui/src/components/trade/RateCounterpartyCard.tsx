/**
 * Layer A: rate the other party of a finished trade (1-5 stars + optional comment). Presentational:
 * the host page sends it (reputation.rate()) and says when it is done. All copy comes from props.
 * Done = one line in place of the form, never a score echo or a reputation change.
 */
import { useId, useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { StarRating } from '../ui/star-rating'
import { validateRating, type RatingInput } from '../../lib/rating'

export interface RateCounterpartyCopy {
  title: string
  description: string
  legend: string
  starLabel: (n: number) => string
  valueText: (score: number | null) => string
  scoreError: string
  commentLabel: string
  submitLabel: string
}

export function RateCounterpartyCard({ copy, doneText, submitting, error, onSubmit }: {
  copy: RateCounterpartyCopy
  /** Set once the rating is recorded (or the server says it already was): replaces the form. */
  doneText?: string | null
  submitting: boolean
  /** Send failure from the host, shown under the form. */
  error?: string | null
  onSubmit: (input: RatingInput) => void
}) {
  const [score, setScore] = useState<number | null>(null)
  const [comment, setComment] = useState('')
  const [scoreMissing, setScoreMissing] = useState(false)
  const ids = { title: useId(), comment: useId(), scoreError: useId(), error: useId() }

  if (doneText) {
    return (
      <section aria-labelledby={ids.title} className="rounded-lg border border-brand-border-subtle bg-brand-surface p-4">
        <h2 id={ids.title} className="sr-only">{copy.title}</h2>
        <p role="status" className="flex items-center gap-2 text-sm text-brand-text">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-brand-text-secondary" aria-hidden="true" />
          {doneText}
        </p>
      </section>
    )
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const v = validateRating(score, comment)
    // Focus the first star so the error next to it is where the keyboard is.
    if (!v.ok) { setScoreMissing(true); e.currentTarget.querySelector<HTMLInputElement>('input[name]')?.focus(); return }
    onSubmit(v.input)
  }

  return (
    <section aria-labelledby={ids.title} className="rounded-lg border border-brand-border-subtle bg-brand-surface p-4">
      <h2 id={ids.title} className="text-heading text-brand-text">{copy.title}</h2>
      <p className="mt-1 text-body-sm text-brand-text-secondary">{copy.description}</p>
      <form onSubmit={submit} noValidate className="mt-4 space-y-4">
        <StarRating
          legend={copy.legend}
          name={`${ids.title}-score`}
          value={score}
          onChange={(n) => { setScore(n); setScoreMissing(false) }}
          starLabel={copy.starLabel}
          valueText={copy.valueText(score)}
          invalid={scoreMissing}
          describedBy={scoreMissing ? ids.scoreError : undefined}
        />
        {scoreMissing && <p id={ids.scoreError} role="alert" className="-mt-2 text-xs text-brand-danger-fg">{copy.scoreError}</p>}
        <div>
          <label htmlFor={ids.comment} className="block text-sm font-medium text-brand-text">{copy.commentLabel}</label>
          <Textarea id={ids.comment} name="comment" autoComplete="off" value={comment} onChange={(e) => setComment(e.target.value)} rows={3} className="mt-1.5" aria-describedby={error ? ids.error : undefined} />
        </div>
        {error && <p id={ids.error} role="alert" className="text-sm text-brand-danger-fg">{error}</p>}
        <Button type="submit" loading={submitting} className="min-h-10 touch:min-h-11">{copy.submitLabel}</Button>
      </form>
    </section>
  )
}
