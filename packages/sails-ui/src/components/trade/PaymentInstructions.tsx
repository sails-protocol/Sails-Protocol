/**
 * Layer A: where the fiat payment goes. The host passes the method label,
 * the offer's free-text details and the visibility from deriveTradeState():
 * hidden until the escrow status records the funds as locked (buyer), muted
 * and collapsed once it is no longer an instruction to act on. This only
 * defers presentation on the recorded status (the API returns the details
 * from trade start); it is not access control nor a funding guarantee.
 */
import { CopyButton } from '../ui/CopyButton'
import { SafetyNote } from '../ui/SafetyNote'
import type { InstructionsVisibility } from '../../lib/tradeState'
import { t } from '../../i18n'

interface Props {
  viewer: 'buyer' | 'seller'
  visibility: InstructionsVisibility
  methodLabel: string
  details: string | null
  /** Inside the current-stage card: a divided section, not a box in a box. */
  embedded?: boolean
}

function Details({ viewer, details }: { viewer: Props['viewer']; details: string | null }) {
  if (!details) {
    return (
      <p className="text-sm text-brand-text-secondary">
        {t(viewer === 'buyer' ? 'trade.payment.noDetailsBuyer' : 'trade.payment.noDetailsSeller')}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <p className="min-w-0 flex-1 whitespace-pre-line text-sm text-brand-text [overflow-wrap:anywhere]">{details}</p>
      <CopyButton value={details} label={t('trade.payment.copyDetails')} className="w-fit shrink-0 min-h-11 px-3" />
    </div>
  )
}

export function PaymentInstructions({ viewer, visibility, methodLabel, details, embedded = false }: Props) {
  const title = t(viewer === 'buyer' ? 'trade.payment.titleBuyer' : 'trade.payment.titleSeller', { method: methodLabel })

  if (visibility === 'inactive') {
    return (
      <details className="rounded-lg border border-brand-border-subtle bg-brand-surface p-4">
        <summary className="min-h-11 cursor-pointer text-sm text-brand-text-secondary flex items-center">
          {title} <span className="ml-1">{t('trade.payment.noPendingAction')}</span>
        </summary>
        <div className="mt-2"><Details viewer={viewer} details={details} /></div>
      </details>
    )
  }

  return (
    <section aria-label={title} className={embedded ? 'border-t border-brand-border-subtle pt-4' : 'rounded-lg border border-brand-border-subtle bg-brand-surface p-4'}>
      <h2 className="text-sm font-semibold text-brand-text">{title}</h2>
      <div className="mt-2">
        {visibility === 'hidden' ? (
          <p className="text-sm text-brand-text-secondary">
            {t('trade.payment.hiddenUntilLocked')}
          </p>
        ) : (
          <>
            <Details viewer={viewer} details={details} />
            {viewer === 'buyer' && details && (
              <SafetyNote className="mt-3">
                {t('trade.payment.safety')}
              </SafetyNote>
            )}
            {viewer === 'seller' && details && (
              <p className="mt-2 text-xs text-brand-text-secondary">
                {t('trade.payment.sellerNote')}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  )
}
