/**
 * DEV/demo only: the wiring map (/dev/wiring, PO 2026-11-22). The team's checklist of what is not wired to the
 * backend yet: one row per LOOSE_WIRES item with where to find it, its status, the contract or SDK call it needs and
 * the owner. Source of truth: lib/wiringMap.ts (status) + lib/looseWires.ts (contract). Developer text in pt-BR.
 */
import { useState } from 'react'
import { Link } from 'react-router'
import { FilterChip } from '../../components/ui/filter-chip'
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
  const all = Object.keys(WIRE_META) as LooseWireId[]
  const counts = wireCounts()
  const owners = [...new Set(all.map((id) => WIRE_META[id].owner))]
  const [status, setStatus] = useState<WireStatus | null>(null)
  const [owner, setOwner] = useState<string | null>(null)
  const ids = all.filter((id) => (!status || WIRE_META[id].status === status) && (!owner || WIRE_META[id].owner === owner))
  const areas = [...new Set(ids.map((id) => WIRE_META[id].area))] as WireArea[]
  return (
    <Page width="detail">
      <PageHeader
        title="Mapa de ligações"
        meta={`${all.length} itens da lista de fios soltos. Na demonstração cada um é simulado e marcado; em produção, a tela continua honesta.`}
        back={<Link to="/" className="inline-flex touch:min-h-11 items-center gap-1 text-body-sm text-brand-text-secondary hover:text-brand-text"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Market</Link>}
      />
      {/* One status per row: the counts add up to the total. Tap a count to filter. */}
      <div role="group" aria-label="Filtrar por situação" className="mb-3 flex flex-wrap gap-2">
        {(Object.keys(counts) as WireStatus[]).map((s) => (
          <FilterChip key={s} label={`${WIRE_STATUS_LABEL[s]}: ${counts[s]}`} selected={status === s} onToggle={() => setStatus(status === s ? null : s)} />
        ))}
      </div>
      <div role="group" aria-label="Filtrar por responsável" className="mb-6 flex flex-wrap gap-2">
        {owners.map((o) => <FilterChip key={o} label={o} selected={owner === o} onToggle={() => setOwner(owner === o ? null : o)} />)}
      </div>
      {ids.length === 0 && <p className="text-body-sm text-brand-text-secondary">Nenhum item com esses filtros.</p>}
      <div className="space-y-8">
        {areas.map((area) => (
          <section key={area} aria-labelledby={`wiring-${area}`}>
            <h2 id={`wiring-${area}`} className="text-section-title">{area}</h2>
            {/* Phones: one card per item; md and up: the table. */}
            <ul className="mt-2 space-y-2 md:hidden">
              {ids.filter((id) => WIRE_META[id].area === area).map((id) => (
                <li key={id} className="space-y-1 rounded-lg bg-brand-surface p-3">
                  <p className="font-medium text-brand-text">{LOOSE_WIRES[id].label} <code className="text-caption text-brand-text-muted">{id}</code></p>
                  <Badge variant="outline" className={cn('border-transparent font-medium', TONE[WIRE_META[id].status])}>{WIRE_STATUS_LABEL[WIRE_META[id].status]}</Badge>
                  <p className="text-caption text-brand-text">{WIRE_META[id].where}</p>
                  <p className="text-caption text-brand-text-secondary">{LOOSE_WIRES[id].contract}</p>
                  <p className="text-caption text-brand-text-muted">Responsável: {WIRE_META[id].owner}</p>
                </li>
              ))}
            </ul>
            <div className="mt-2 hidden overflow-x-auto md:block">
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
