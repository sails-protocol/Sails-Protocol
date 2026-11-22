/**
 * Layer C, demo only (PO 2026-11-22, "the demo is a complete working simulation"): what a planned Settings row does in
 * the demo. Toggles keep a local value, actions answer with a simulated result, and every one says
 * "Simulado: nada foi enviado ao nó Sails". Rows that would touch real secrets or money outside the app (a real
 * wallet, a real key export, a payout address) are never simulated: they show an honest notice instead
 * (lib/wiringMap.ts, status "notice"). Real mode never renders this file.
 */
import { useState } from 'react'
import { SettingsRow } from './SettingsRow'
import { Switch } from '../ui/switch'
import { SimulatedBadge } from '../ui/SimulatedBadge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { LOOSE_WIRES, type LooseWireId } from '../../lib/looseWires'
import { WIRE_META } from '../../lib/wiringMap'
import { simulatedToast } from '../../pages/markets/shared'
import { t } from '../../i18n'

const TOGGLES: ReadonlySet<LooseWireId> = new Set(['notifyTrades', 'notifyChat', 'notifyDisputes', 'sessionLock', 'publicAvatar', 'marketParticipationPrivacy'])
const DEMO_HELP = ['spaces.sim.help1', 'spaces.sim.help2', 'spaces.sim.help3'] as const

function Toggle({ id, description }: { id: LooseWireId; description?: string }) {
  const wire = LOOSE_WIRES[id]
  const [on, setOn] = useState(id !== 'publicAvatar' && id !== 'sessionLock')
  return (
    <SettingsRow
      icon={wire.icon}
      label={wire.label}
      description={<><SimulatedBadge label={t('spaces.simulated')} className="mr-1.5" />{description}</>}
      // Transparent 10px top/bottom border clipped from the fill: a 44px touch target with the same 24px track.
      control={<Switch checked={on} aria-label={wire.label} onCheckedChange={(v) => { setOn(v); simulatedToast() }} className="touch:h-11 touch:border-y-[10px] touch:bg-clip-padding" />}
    />
  )
}

function Help() {
  const [open, setOpen] = useState(false)
  const wire = LOOSE_WIRES.helpCenter
  return (
    <>
      <SettingsRow icon={wire.icon} label={wire.label} description={<SimulatedBadge label={t('spaces.simulated')} />} onClick={() => setOpen(true)} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader className="pr-10 text-left">
            <DialogTitle>{t('spaces.sim.helpTitle')}</DialogTitle>
            <DialogDescription>{t('spaces.sim.helpNote')}</DialogDescription>
          </DialogHeader>
          <ul className="space-y-2">
            {DEMO_HELP.map((k) => <li key={k} className="rounded-lg bg-brand-elevated px-3 py-2 text-body-sm text-brand-text">{t(k)}</li>)}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** The demo version of a planned Settings row; null when the wire is not simulated (the caller keeps its own row). */
export function SimulatedSettingRow({ id, description }: { id: LooseWireId; description?: string }) {
  const meta = WIRE_META[id]
  const wire = LOOSE_WIRES[id]
  if (meta.status === 'notice') {
    return <SettingsRow icon={wire.icon} label={wire.label} description={t('spaces.sim.notSimulatedReason')} plannedLabel={t('spaces.sim.notSimulated')} />
  }
  if (!meta.simulatedInDemo) return null
  if (TOGGLES.has(id)) return <Toggle id={id} description={description} />
  if (id === 'helpCenter') return <Help />
  const result = id === 'connectionDiagnostics' ? t('spaces.sim.diagnostics') : id === 'displayCurrency' ? t('spaces.sim.currency') : undefined
  return (
    <SettingsRow
      icon={wire.icon}
      label={wire.label}
      description={<><SimulatedBadge label={t('spaces.simulated')} className="mr-1.5" />{description}</>}
      onClick={() => simulatedToast(result)}
    />
  )
}
