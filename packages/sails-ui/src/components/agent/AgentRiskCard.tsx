import { useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { assessRiskWithQvac, type AgentRiskAssessment } from '../../lib/qvacAgent'
import { InfoTooltip } from '../ui/InfoTooltip'
import { Card } from '../ui/card'
import { Brain } from 'lucide-react'
import type { AssetType, TradeSide } from '../../types'

const RISK_STYLE: Record<AgentRiskAssessment['risk'], string> = {
  low: 'text-green-500 bg-green-500/10 border-green-500/25',
  medium: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/25',
  high: 'text-red-500 bg-red-500/10 border-red-500/25',
}

const RECOMMENDATION_LABEL: Record<AgentRiskAssessment['recommendation'], string> = {
  proceed: 'Prosseguir',
  hold: 'Aguardar confirmação',
  reject: 'Não prosseguir',
}

interface Props {
  asset: AssetType
  side: TradeSide
  maxValue: number
  minValue: number
}

export function AgentRiskCard({ asset, side, maxValue, minValue }: Props) {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [assessment, setAssessment] = useState<AgentRiskAssessment | null>(null)
  // Real inference call now (2026-08-09) — genuinely can fail (network,
  // session expired, model error), unlike the old simulation which
  // always resolved. No error state existed here before because there
  // was nothing real to fail.
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
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
        if (!cancelled) setError(err instanceof Error ? err.message : 'Não foi possível obter a análise do agente')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user, asset, side, maxValue, minValue])

  return (
    <Card className="p-4 mt-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-brand-text mb-2">
        <Brain className="h-4 w-4 shrink-0" />
        Análise de risco do Sails Agent
        <InfoTooltip text="Análise automática feita por um modelo de IA local, só com os dados do ativo e do trade. É uma sugestão, não uma decisão nem uma garantia de segurança. O agente não acessa contas bancárias." />
      </div>

      {!user ? (
        <p className="text-xs text-brand-text-muted">Conecte sua carteira para ver a avaliação de risco do agente.</p>
      ) : loading ? (
        <div className="flex items-center gap-2 text-xs text-brand-text-muted">
          <span className="w-1.5 h-1.5 rounded-full bg-brand-orange-accent animate-pulse" />
          Analisando a negociação...
        </div>
      ) : error ? (
        <p className="text-xs text-red-500">{error}</p>
      ) : assessment ? (
        <div>
          <div className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${RISK_STYLE[assessment.risk]}`}>
            Risco {assessment.risk === 'low' ? 'baixo' : assessment.risk === 'medium' ? 'médio' : 'alto'}
          </div>
          <p className="text-sm text-brand-text-secondary mt-2">{assessment.reasoning}</p>
          <p className="text-xs text-brand-text-muted mt-1">
            Sugestão do agente: <span className="font-medium text-brand-text">{RECOMMENDATION_LABEL[assessment.recommendation]}</span>
          </p>
        </div>
      ) : null}
    </Card>
  )
}
