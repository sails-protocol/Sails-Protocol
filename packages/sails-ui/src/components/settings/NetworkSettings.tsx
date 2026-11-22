/**
 * Layer C: Configurações → Rede e nós (CTO final correction for plan 1.4; DECISIONS.md "Nó não é mercado", issue
 * #361, ADR-001). Rede Sails works behind the scenes and is the default: choosing a node is never a step to use the
 * public market. The section shows the network, the connection (the configured node), verified operator info (none
 * verified today), "Adicionar nó manualmente", and an "Avançado" area, collapsed, with the node list, operators,
 * deployment profiles and diagnostics. Markets are not managed here: they live in the Market area (/markets).
 * Only demo mode (?demo=1) adds fictional nodes, marked on every row.
 */
import { useId, useState, type ReactNode } from 'react'
import { BadgeCheck, ChevronDown, Network, Plus } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Alert } from '../ui/alert'
import { Badge } from '../ui/badge'
import { SettingsRow } from './SettingsRow'
import type { NodeListCopy } from '../markets/NodeList'
import { NetworkSummary, type NetworkSummaryCopy } from '../markets/NetworkSummary'
import { AddNodeForm, type AddNodeCopy } from '../markets/AddNodeForm'
import { demoNodes, isDemoMode } from '../../lib/demoMarkers'
import { SimulatedBadge } from '../ui/SimulatedBadge'
import { LOOSE_WIRES } from '../../lib/looseWires'
import type { NodeView } from '../../lib/sailsNode'
import { cn } from '../../lib/utils'
import { simulatedToast, WireNote, WirePlanned } from '../../pages/markets/shared'
import { t } from '../../i18n'

const DIALOG_CLASS = 'max-w-lg max-h-[90dvh] overflow-y-auto overscroll-contain max-md:inset-0 max-md:max-h-none max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:content-start max-md:border-0'
const TONAL_BADGE = 'border-transparent bg-brand-tonal font-medium text-brand-text'

function nodeListCopy(): NodeListCopy {
  return {
    label: t('markets.node.listLabel'),
    // Product names of the two official deployment profiles: never translated.
    profile: { public: 'Sails Public Node', private: 'Sails Private Node' },
    sharedHosting: t('markets.node.sharedHosting'),
    status: { online: t('markets.node.status.online'), degraded: t('markets.node.status.degraded'), offline: t('markets.node.status.offline') },
    fields: {
      operator: t('markets.node.field.operator'), region: t('markets.node.field.region'), status: t('markets.node.field.status'),
      fee: t('markets.node.field.fee'), limits: t('markets.node.field.limits'), custody: t('markets.node.field.custody'),
    },
    unavailable: t('common.soon'),
    current: t('markets.node.current'),
    illustrative: t('markets.fictionalExample'),
  }
}

// The configured node is the only real one; none of its metadata is exposed today (LOOSE_WIRES.nodeCatalog).
const currentNode = (): NodeView => ({ id: 'current', name: t('markets.node.automatic'), current: true })

function networkCopy(): NetworkSummaryCopy {
  return {
    wording: {
      unknown: () => t('markets.node.network.unknown'),
      single: () => t('markets.node.network.single'),
      redundant: (s) => t('markets.node.network.redundant', { count: s.active }),
      multiOperator: (s) => t('markets.node.network.multiOperator', { count: s.active, operators: s.operators }),
    },
    operatorLine: (operator, count) => t('markets.node.operatorLine', { operator, count }),
    operatorsLabel: t('markets.node.operatorsLabel'),
    nodesTitle: t('markets.node.nodesTitle'),
    list: nodeListCopy(),
  }
}

function addNodeCopy(): AddNodeCopy {
  return {
    address: t('markets.node.add.address'),
    addressHelp: t('markets.node.add.addressHelp'),
    addressPlaceholder: t('markets.node.add.addressPlaceholder'),
    name: t('markets.node.add.name'),
    nameOptional: t('markets.optional'),
    nameHelp: t('markets.node.add.nameHelp'),
    connectionTitle: t('markets.node.add.connectionTitle'),
    connection: [t('markets.node.add.connectionTalk'), t('markets.node.add.connectionAccess'), t('markets.node.add.connectionOpenMarket')],
    privacy: t('markets.node.add.privacy'),
    responsibility: t('markets.node.add.responsibility'),
    submit: t('markets.node.add.submit'),
    cancel: t('common.cancel'),
  }
}

/** First row of Configurações → Rede e nós, before the configured-node (connection) row. */
export function NetworkRow() {
  return (
    <SettingsRow
      icon={Network}
      label="Rede Sails"
      description={t('settings.network.description')}
      value={<Badge variant="outline" className={TONAL_BADGE}>{t('settings.network.default')}</Badge>}
    />
  )
}

/**
 * Rows after the connection row: verified operator, "Adicionar nó manualmente", the node-is-not-market note and the
 * collapsed "Avançado" area. `advanced` = the section's existing planned rows (kept, re-homed under Avançado).
 */
export function NetworkSettingsRows({ advanced }: { advanced?: ReactNode }) {
  const id = useId()
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState(false)
  const nodes = [currentNode(), ...demoNodes()]
  const demo = isDemoMode()
  return (
    <>
      <SettingsRow icon={BadgeCheck} label={t('settings.network.operator')} description={t('settings.network.operatorDescription')} plannedLabel={t('common.soon')} />
      <SettingsRow icon={Plus} label={t('settings.network.addNode')} description={t('settings.network.addNodeDescription')} onClick={() => setAdding(true)} />
      {/* Not in Day 0 (DECISIONS.md "Nó Sails gerenciado"): no provisioning, price or availability promise. */}
      {demo
        ? <SettingsRow icon={LOOSE_WIRES.managedNode.icon} label={LOOSE_WIRES.managedNode.label} description={<><SimulatedBadge label={t('spaces.simulated')} className="mr-1.5" />{t('spaces.managedNode.description')}</>} onClick={() => simulatedToast(t('spaces.hosting.provisioned'))} />
        : <SettingsRow icon={LOOSE_WIRES.managedNode.icon} label={LOOSE_WIRES.managedNode.label} description={t('spaces.managedNode.description')} plannedLabel={t('common.soon')} />}
      <li className="px-4 py-3">
        <Alert tone="info" size="sm" title={t('settings.network.notMarketTitle')}>
          {t('settings.network.notMarketBody')}
        </Alert>
      </li>
      <li>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-advanced`}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors state-layer focus-visible:-outline-offset-2"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-brand-text">{t('settings.network.advanced')}</span>
            <span className="mt-0.5 block text-xs text-brand-text-muted">{t('settings.network.advancedDescription')}</span>
          </span>
          <ChevronDown aria-hidden="true" className={cn('h-4 w-4 shrink-0 text-brand-text-muted transition-transform duration-short', open && 'rotate-180')} />
        </button>
        <div id={`${id}-advanced`} hidden={!open}>
          <div className="px-4 pb-4 pt-1">
            <NetworkSummary nodes={nodes} copy={networkCopy()}>
              {nodes.length === 1 && <WirePlanned id="nodeCatalog" description={t('settings.network.catalogPlanned')} />}
              <WirePlanned id="nodeStateSync" description={t('settings.network.syncPlanned')} />
            </NetworkSummary>
          </div>
          {advanced && <ul className="divide-y divide-brand-border-subtle border-t border-brand-border-subtle">{advanced}</ul>}
        </div>
      </li>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className={DIALOG_CLASS}>
          <DialogHeader className="pr-10 text-left">
            <DialogTitle>{t('settings.network.addNode')}</DialogTitle>
            <DialogDescription>{t('settings.network.addNodeDialog')}</DialogDescription>
          </DialogHeader>
          {/* Demo: the form works and says so; real mode keeps it disabled with its loose wires. */}
          <AddNodeForm copy={addNodeCopy()} submitAvailable={demo} unavailableNote={<WireNote ids={['nodeCatalog', 'manualServer']} />} onSubmit={() => { setAdding(false); simulatedToast(t('spaces.sim.nodeAdded')) }} onCancel={() => setAdding(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}
