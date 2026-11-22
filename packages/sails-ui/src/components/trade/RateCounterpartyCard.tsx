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
import { cn } from '../../lib/utils'
import { commentOverBy, MAX_RATING_COMMENT, RATING_COUNTER_LIVE_FROM, validateRating, type RatingInput } from '../../lib/rating'

export interface RateCounterpartyCopy {
  title: string
  description: string
  legend: string
  starLabel: (n: number) => string
  valueText: (score: number | null) => string
  scoreError: string
  commentLabel: string
  /** Visible counter, e.g. "12/280". */
  commentCounter: (length: number, max: number) => string
  /** Inline message once the comment is over the limit (typed or pasted); the text is kept, never cut. */
  commentTooLong: (over: number, max: number) => string
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
  const ids = { title: useId(), comment: useId(), scoreError: useId(), error: useId(), counter: useId(), tooLong: useId() }

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
    // Focus the field with the error so the message next to it is where the keyboard is.
    if (!v.ok && v.error === 'score') { setScoreMissing(true); e.currentTarget.querySelector<HTMLInputElement>('input[name]')?.focus(); return }
    if (!v.ok) { e.currentTarget.querySelector<HTMLTextAreaElement>('textarea')?.focus(); return }
    onSubmit(v.input)
  }

  // No native maxLength: it would silently cut a paste. The full text stays, the counter and message say what to fix.
  // Over the limit the alert speaks; the counter goes quiet so it is not announced twice.
  const over = commentOverBy(comment)
  const describedBy = [ids.counter, over > 0 && ids.tooLong, error && ids.error].filter(Boolean).join(' ')

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
          <Textarea id={ids.comment} name="comment" autoComplete="off" value={comment} onChange={(e) => setComment(e.target.value)} rows={3} className="mt-1.5" aria-invalid={over > 0 || undefined} aria-describedby={describedBy} />
          <div className="mt-1 flex items-start justify-between gap-3 text-xs">
            {over > 0 ? <p id={ids.tooLong} role="alert" className="text-brand-danger-fg">{copy.commentTooLong(over, MAX_RATING_COMMENT)}</p> : <span />}
            <span id={ids.counter} aria-live={comment.length >= RATING_COUNTER_LIVE_FROM && over === 0 ? 'polite' : 'off'} className={cn('shrink-0 tabular-nums', over > 0 ? 'text-brand-danger-fg' : 'text-brand-text-muted')}>
              {copy.commentCounter(comment.length, MAX_RATING_COMMENT)}
            </span>
          </div>
        </div>
        {error && <p id={ids.error} role="alert" className="text-sm text-brand-danger-fg">{error}</p>}
        <Button type="submit" loading={submitting} className="min-h-10 touch:min-h-11">{copy.submitLabel}</Button>
      </form>
    </section>
  )
}
