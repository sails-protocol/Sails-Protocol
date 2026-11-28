/**
 * Layer C, demo only (PO 2026-11-22, "the demo is a complete working simulation"): what a planned Settings row does in
 * the demo. Toggles keep a local value, actions answer with a simulated result, and every one says
 * "Simulado: nada foi enviado ao nó Sails". Rows that would touch real secrets or money outside the app (a real
 * wallet, a real key export, a payout address) are never simulated: they show an honest notice instead
 * (lib/wiringMap.ts, status "notice"). Real mode never renders this file.
 */
import { useState } from 'react'
import { Link } from 'react-router'
import { ChevronRight } from 'lucide-react'
import { SettingsRow } from './SettingsRow'
import { Switch } from '../ui/switch'
import { SimulatedBadge } from '../ui/SimulatedBadge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { LOOSE_WIRES, type LooseWireId } from '../../lib/looseWires'
import { WIRE_META } from '../../lib/wiringMap'
import { simulatedToast } from '../../pages/markets/shared'
import { BackupDemoRow } from './BackupDemo'
import { RadioCard, RadioGroup } from '../ui/radio-group'
import { faqPath } from '../../lib/faq'
import { useCloseOnRouteChange } from './useCloseOnRouteChange'
import { t } from '../../i18n'

const TOGGLES: ReadonlySet<LooseWireId> = new Set(['notifyTrades', 'notifyChat', 'notifyDisputes', 'sessionLock', 'publicAvatar', 'marketParticipationPrivacy'])
// Each demo article opens: two go to the matching FAQ answer, the third has its own short text.
const DEMO_HELP = [
  { key: 'spaces.sim.help1', to: faqPath('como-funciona') },
  { key: 'spaces.sim.help2', to: faqPath('mercados') },
  { key: 'spaces.sim.help3', body: 'settings.help.publishArticle' },
] as const
// Display fiat for prices (demo): a saved preference only; prices stay in USD, the only real unit (DECISIONS).
const CURRENCIES = ['USD', 'BRL', 'EUR'] as const
const CURRENCY_KEY = 'sails_ui_display_currency'
const read = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const write = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* stays for this view */ } }

function Toggle({ id, description }: { id: LooseWireId; description?: string }) {
  const wire = LOOSE_WIRES[id]
  // Saved in this browser, so a switch keeps its position when the section opens again.
  const storeKey = `sails_ui_sim_toggle_${id}`
  const [on, setOn] = useState(() => { const v = read(storeKey); return v === null ? id !== 'publicAvatar' && id !== 'sessionLock' : v === '1' })
  return (
    <SettingsRow
      icon={wire.icon}
      label={wire.label}
      description={<><SimulatedBadge label={t('spaces.simulated')} className="mr-1.5" />{description}</>}
      // Transparent 10px top/bottom border clipped from the fill: a 44px touch target with the same 24px track.
      control={<Switch checked={on} aria-label={wire.label} onCheckedChange={(v) => { setOn(v); write(storeKey, v ? '1' : '0'); simulatedToast(t('settings.sim.saved')) }} className="touch:h-11 touch:border-y-[10px] touch:bg-clip-padding" />}
    />
  )
}

function Help() {
  const [open, setOpen] = useState(false)
  const wire = LOOSE_WIRES.helpCenter
  useCloseOnRouteChange(open, () => setOpen(false))
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
            {DEMO_HELP.map((a) => (
              <li key={a.key}>
                {'to' in a ? (
                  <Link to={a.to} onClick={() => setOpen(false)} className="flex min-h-11 items-center justify-between gap-2 rounded-lg bg-brand-elevated px-3 py-2 text-body-sm text-brand-text state-layer">
                    {t(a.key)}<ChevronRight aria-hidden="true" className="size-icon-sm shrink-0 text-brand-text-muted" />
                  </Link>
                ) : (
                  <details className="group rounded-lg bg-brand-elevated px-3">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-body-sm text-brand-text">
                      {t(a.key)}<ChevronRight aria-hidden="true" className="size-icon-sm shrink-0 text-brand-text-muted group-open:rotate-90" />
                    </summary>
                    <p className="pb-3 text-body-sm text-brand-text-secondary">{t(a.body)}</p>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  )
}

function DisplayCurrency({ description }: { description?: string }) {
  const wire = LOOSE_WIRES.displayCurrency
  const [value, setValue] = useState(() => read(CURRENCY_KEY) ?? 'USD')
  const pick = (c: string) => { setValue(c); write(CURRENCY_KEY, c); simulatedToast(t('spaces.sim.currency')) }
  return (
    <li className="px-4 py-3">
      <RadioGroup
        legend={<span className="inline-flex flex-wrap items-center gap-2">{wire.label}<SimulatedBadge label={t('spaces.simulated')} /></span>}
        description={`${description ? `${description} ` : ''}${t('settings.sim.currencyNote')}`}
        listClassName="flex flex-wrap gap-2"
      >
        {CURRENCIES.map((c) => (
          <RadioCard key={c} name="display-currency" value={c} checked={value === c} onChange={() => pick(c)} className="py-1.5">
            <span translate="no">{c}</span>
          </RadioCard>
        ))}
      </RadioGroup>
    </li>
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
  if (id === 'displayCurrency') return <DisplayCurrency description={description} />
  if (id === 'keyBackupExport' || id === 'keyBackupImport') return <BackupDemoRow kind={id === 'keyBackupExport' ? 'export' : 'import'} />
  const result = id === 'connectionDiagnostics' ? t('spaces.sim.diagnostics') : undefined
  return (
    <SettingsRow
      icon={wire.icon}
      label={wire.label}
      description={<><SimulatedBadge label={t('spaces.simulated')} className="mr-1.5" />{description}</>}
      onClick={() => simulatedToast(result)}
    />
  )
}
