import { useState } from 'react'
import { toast } from './toast'
import { useAuth } from '../../context/AuthContext'
import { sailsClient } from '../../lib/sailsClient'
import { canVouch } from '../../lib/reputation'
import { InfoTooltip } from './InfoTooltip'
import { IconButton } from './icon-button'
import { ShieldPlus, ShieldCheck } from 'lucide-react'
import { t } from '../../i18n'

// RFC-021 D7 — real endpoint (sailsClient.reputation.vouchFor), the
// actual cold-start-trust fix (pre-signs the vouchee's PaymentAccount to
// a higher trade-limit tier). Only shown for the OTHER party in a trade
// (TradeParties.tsx's own !isYou gate) — vouching for yourself is
// server-rejected anyway. Eligibility is checked against the CURRENT
// user (the voucher), not the person being vouched for.
export function VouchButton({ voucheeId }: { voucheeId: string }) {
  const { user } = useAuth()
  const [vouched, setVouched] = useState(false)
  const [loading, setLoading] = useState(false)

  if (!user) return null
  const eligible = canVouch(user)

  const handleVouch = async () => {
    if (!eligible || loading || vouched) return
    setLoading(true)
    try {
      await sailsClient.reputation.vouchFor(voucheeId)
      setVouched(true)
      toast.success(t('reputation.vouch.success'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('reputation.vouch.failed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-1">
      {/* IconButton: the reason is the name and the tooltip (no title=); unavailable stays focusable via aria-disabled. */}
      <IconButton
        size="sm"
        onClick={handleVouch}
        loading={loading}
        aria-disabled={!eligible || vouched || undefined}
        label={
          vouched
            ? t('reputation.vouch.already')
            : eligible
              ? t('reputation.vouch.action')
              : t('reputation.vouch.ineligible')
        }
        className={vouched ? 'aria-disabled:text-brand-success-fg' : undefined}
      >
        {vouched ? <ShieldCheck aria-hidden="true" /> : <ShieldPlus aria-hidden="true" />}
      </IconButton>
      <InfoTooltip text={t('reputation.vouch.explainer')} />
    </div>
  )
}
