/**
 * DEV/demo only: the wiring map (/dev/wiring, PO 2026-11-22). The team's checklist of what is not wired to the
 * backend yet: one row per LOOSE_WIRES item with where to find it, its status, the contract or SDK call it needs and
 * the owner. Source of truth: lib/wiringMap.ts (status) + lib/looseWires.ts (contract). Developer text in pt-BR.
 */
import { Link } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { Page, PageHeader } from '../../components/layout/PageHeader'
import { Badge } from '../../components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { LOOSE_WIRES, type LooseWireId } from '../../lib/looseWires'
import { WIRE_META, WIRE_STATUS_LABEL, wireCounts, type WireArea, type WireStatus } from '../../lib/wiringMap'
import { cn } from '../../lib/utils'

const TONE: Record<WireStatus, string> = {
  wired: 'bg-brand-info-bg text-brand-info-fg',
  simulated: 'bg-brand-tonal text-brand-text',
  outOfDay0: 'bg-brand-warning-bg text-brand-warning-fg',
  notice: 'bg-brand-tonal text-brand-text-secondary',
}

export function WiringMap() {
  const ids = Object.keys(WIRE_META) as LooseWireId[]
  const counts = wireCounts()
  const areas = [...new Set(ids.map((id) => WIRE_META[id].area))] as WireArea[]
  return (
    <Page width="detail">
      <PageHeader
        title="Mapa de ligações"
        meta={`${ids.length} itens da lista de fios soltos. Na demonstração cada um é simulado e marcado; em produção, a tela continua honesta.`}
        back={<Link to="/" className="inline-flex touch:min-h-11 items-center gap-1 text-body-sm text-brand-text-secondary hover:text-brand-text"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Market</Link>}
      />
      <ul className="mb-6 flex flex-wrap gap-2" aria-label="Contagem por situação">
        {(Object.keys(counts) as WireStatus[]).map((s) => (
          <li key={s}><Badge variant="outline" className={cn('border-transparent font-medium tabular-nums', TONE[s])}>{WIRE_STATUS_LABEL[s]}: {counts[s]}</Badge></li>
        ))}
      </ul>
      <div className="space-y-8">
        {areas.map((area) => (
          <section key={area} aria-labelledby={`wiring-${area}`}>
            <h2 id={`wiring-${area}`} className="text-section-title">{area}</h2>
            <div className="mt-2 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Onde</TableHead>
                    <TableHead>Situação</TableHead>
                    <TableHead>Contrato ou chamada do SDK</TableHead>
                    <TableHead>Responsável</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ids.filter((id) => WIRE_META[id].area === area).map((id) => {
                    const m = WIRE_META[id]
                    return (
                      <TableRow key={id}>
                        <TableCell className="align-top">
                          <span className="block font-medium">{LOOSE_WIRES[id].label}</span>
                          <code className="text-caption text-brand-text-muted">{id}</code>
                        </TableCell>
                        <TableCell className="align-top text-caption">{m.where}</TableCell>
                        <TableCell className="align-top">
                          <Badge variant="outline" className={cn('border-transparent font-medium', TONE[m.status])}>{WIRE_STATUS_LABEL[m.status]}</Badge>
                          {m.status === 'outOfDay0' && m.simulatedInDemo && <span className="mt-1 block text-caption text-brand-text-secondary">Simulado na demonstração</span>}
                        </TableCell>
                        <TableCell className="align-top text-caption text-brand-text-secondary">{LOOSE_WIRES[id].contract}</TableCell>
                        <TableCell className="align-top text-caption">{m.owner}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </section>
        ))}
      </div>
    </Page>
  )
}
