import { useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { assessRiskWithQvac, type AgentRiskAssessment } from '../../lib/qvacAgent'
import { isDemoNoModelOutput } from '../../lib/demoMarkers'
import { InfoTooltip } from '../ui/InfoTooltip'
import { Brain } from 'lucide-react'
import type { AssetType, TradeSide } from '../../types'
import { useT } from '../../i18n'

const RISK_LEVEL = { low: 'agent.risk.levelLow', medium: 'agent.risk.levelMedium', high: 'agent.risk.levelHigh' } as const satisfies Record<AgentRiskAssessment['risk'], string>

const RECOMMENDATION = {
  proceed: 'agent.risk.proceed',
  hold: 'agent.risk.hold',
  reject: 'agent.risk.reject',
} as const satisfies Record<AgentRiskAssessment['recommendation'], string>

interface Props {
  asset: AssetType
  side: TradeSide
  maxValue: number
  minValue: number
}

// Lote B: neutral (no green "low risk" reassurance), collapsed by default, and the
// inference only runs once the viewer opens it (each call has a real cost).
export function AgentRiskCard({ asset, side, maxValue, minValue }: Props) {
  const t = useT()
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [assessment, setAssessment] = useState<AgentRiskAssessment | null>(null)
  // Real inference call now (2026-08-09) — genuinely can fail (network,
  // session expired, model error), unlike the old simulation which
  // always resolved. No error state existed here before because there
  // was nothing real to fail.
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (!user) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    assessRiskWithQvac({ asset, side, maxValue, minValue })
      .then((result) => {
        if (!cancelled) setAssessment(result)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('agent.risk.failed'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, user, asset, side, maxValue, minValue])

  return (
    <details className="rounded-lg border border-brand-border-subtle bg-brand-surface px-4" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="min-h-11 cursor-pointer flex items-center gap-2 text-sm font-semibold text-brand-text">
        <Brain className="h-4 w-4 shrink-0" aria-hidden="true" />
        {t('agent.risk.title')}
        <InfoTooltip text={t('agent.risk.tooltip')} />
      </summary>
      <div className="pb-4">
        {!user ? (
          <p className="text-sm text-brand-text-secondary">{t('agent.risk.connect')}</p>
        ) : loading ? (
          <p className="text-sm text-brand-text-secondary">{t('agent.risk.loading')}</p>
        ) : error ? (
          <p className="text-sm text-brand-danger-fg">{error}</p>
        ) : assessment ? (
          <div className="text-sm">
            {isDemoNoModelOutput(assessment) ? (
              <p className="text-brand-text-secondary">{t('agent.risk.noModel')}</p>
            ) : (
              <p className="text-brand-text">{t(RISK_LEVEL[assessment.risk])}</p>
            )}
            <p className="mt-1 text-brand-text-secondary">{assessment.reasoning}</p>
            {!isDemoNoModelOutput(assessment) && (
              <p className="mt-1 text-brand-text-secondary">
                {t('agent.risk.suggestion')} <span className="font-medium text-brand-text">{t(RECOMMENDATION[assessment.recommendation])}</span>
              </p>
            )}
            <p className="mt-2 text-xs text-brand-text-secondary">{t('agent.risk.disclaimer')}</p>
          </div>
        ) : null}
      </div>
    </details>
  )
}
