import { useState } from 'react'
import { toast } from 'sonner'
import { useAuth } from '../../context/AuthContext'
import { sailsClient } from '../../lib/sailsClient'
import { canVouch } from '../../lib/reputation'
import { InfoTooltip } from './InfoTooltip'
import { ShieldPlus, ShieldCheck } from 'lucide-react'

const VOUCH_EXPLAINER =
  'Vouching (RFC-021) usa a SUA reputação como aval — não é KYC nem verificação de identidade. Se a pessoa que você avalizar perder a primeira disputa dela enquanto o aval estiver ativo, sua própria reputação sofre uma penalidade real.'

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
      toast.success('Aval registrado — sua reputação agora respalda esta pessoa')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível registrar o aval')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={handleVouch}
        disabled={!eligible || loading || vouched}
        title={
          vouched
            ? 'Você já avalizou esta pessoa'
            : eligible
              ? 'Avalizar esta pessoa com sua reputação'
              : 'Requer pelo menos 3 trades e reputação positiva para avalizar alguém'
        }
        className={`p-2 -m-2 transition-colors disabled:cursor-not-allowed ${
          vouched ? 'text-brand-success' : eligible ? 'text-brand-text-muted hover:text-brand-orange-accent' : 'text-brand-text-muted/40'
        }`}
      >
        {vouched ? <ShieldCheck className="h-4 w-4" /> : <ShieldPlus className="h-4 w-4" />}
      </button>
      <InfoTooltip text={VOUCH_EXPLAINER} />
    </div>
  )
}
