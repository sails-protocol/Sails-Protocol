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
import { demoNodes } from '../../lib/demoMarkers'
import type { NodeView } from '../../lib/sailsNode'
import { cn } from '../../lib/utils'
import { SOON, WireNote, WirePlanned } from '../../pages/markets/shared'

const DIALOG_CLASS = 'max-w-lg max-h-[90dvh] overflow-y-auto overscroll-contain max-md:inset-0 max-md:max-h-none max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:content-start max-md:border-0'
const TONAL_BADGE = 'border-transparent bg-brand-tonal font-medium text-brand-text'

const NODE_LIST_COPY: NodeListCopy = {
  label: 'Nós Sails',
  profile: { public: 'Sails Public Node', private: 'Sails Private Node' },
  sharedHosting: 'Hospedagem compartilhada',
  status: { online: 'Disponível', degraded: 'Instável', offline: 'Fora do ar' },
  fields: { operator: 'Operador', region: 'Região', status: 'Status', fee: 'Taxa', limits: 'Limites', custody: 'Modelo de custódia declarado' },
  unavailable: SOON,
  current: 'Em uso',
  illustrative: 'Exemplo fictício',
}

// The configured node is the only real one; none of its metadata is exposed today (LOOSE_WIRES.nodeCatalog).
const CURRENT_NODE: NodeView = { id: 'current', name: 'Automático', current: true }

const NETWORK_COPY: NetworkSummaryCopy = {
  wording: {
    unknown: () => 'Por enquanto este app conhece só o nó definido pela configuração. O número de nós ativos e quem os opera aparecem quando a rede publicar essas informações.',
    single: () => '1 nó ativo, de 1 operador.',
    redundant: (s) => `${s.active} nós ativos do mesmo operador. Isso é redundância, não vários operadores.`,
    multiOperator: (s) => `${s.active} nós ativos, mantidos por ${s.operators} operadores diferentes.`,
  },
  operatorLine: (op, n) => `${op}: ${n} ${n === 1 ? 'nó' : 'nós'}`,
  operatorsLabel: 'Operadores',
  nodesTitle: 'Nós',
  list: NODE_LIST_COPY,
}

const ADD_NODE_COPY: AddNodeCopy = {
  address: 'Endereço ou identificador do nó Sails',
  addressHelp: 'Peça ao operador do nó e copie exatamente como ele enviou.',
  addressPlaceholder: 'Cole aqui o que o operador enviou…',
  name: 'Nome local',
  nameOptional: '(opcional)',
  nameHelp: 'Só para você reconhecer este nó. Fica neste aparelho.',
  connectionTitle: 'Ao conectar',
  connection: [
    'O app passa a falar com este nó para buscar ofertas, enviar mensagens e acompanhar trades.',
    'Conectar a um nó não dá acesso aos mercados hospedados nele. Para entrar num mercado privado, você precisa de um convite.',
    'O Mercado aberto pertence à rede, não ao nó.',
  ],
  privacy: 'Confirme com o operador. Um nó falso pode ver sua atividade.',
  responsibility: 'Cada operador é responsável pelo próprio nó: disponibilidade, taxas e limites. O nó hospeda e retransmite, mas não acessa suas chaves nem seus fundos.',
  submit: 'Conectar',
  cancel: 'Cancelar',
}

/** First row of Configurações → Rede e nós, before the configured-node (connection) row. */
export function NetworkRow() {
  return (
    <SettingsRow
      icon={Network}
      label="Rede Sails"
      description="Funciona por trás do Market. Você não precisa escolher um nó para usar o Mercado aberto."
      value={<Badge variant="outline" className={TONAL_BADGE}>Padrão</Badge>}
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
  const nodes = [CURRENT_NODE, ...demoNodes()]
  return (
    <>
      <SettingsRow icon={BadgeCheck} label="Operador do nó" description="Aparece só quando o operador for verificado." plannedLabel={SOON} />
      <SettingsRow icon={Plus} label="Adicionar nó manualmente" description="Com o endereço ou o identificador que o operador enviou" onClick={() => setAdding(true)} />
      <li className="px-4 py-3">
        <Alert tone="info" size="sm" title="Nó não é mercado">
          Conectar a um nó não dá acesso aos mercados hospedados nele. O Mercado aberto pertence à rede, não ao nó. Cada operador é responsável pelo próprio nó.
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
            <span className="block text-sm font-medium text-brand-text">Avançado</span>
            <span className="mt-0.5 block text-xs text-brand-text-muted">Nós, operadores e diagnóstico</span>
          </span>
          <ChevronDown aria-hidden="true" className={cn('h-4 w-4 shrink-0 text-brand-text-muted transition-transform duration-short', open && 'rotate-180')} />
        </button>
        <div id={`${id}-advanced`} hidden={!open}>
          <div className="px-4 pb-4 pt-1">
            <NetworkSummary nodes={nodes} copy={NETWORK_COPY}>
              {nodes.length === 1 && <WirePlanned id="nodeCatalog" description="Os nós da rede, seus operadores, o perfil de cada nó e os detalhes aparecem aqui quando a rede publicar essas informações." />}
              <WirePlanned id="nodeStateSync" description="Como ofertas, descoberta e atualizações circulam entre os nós ainda está em especificação." />
            </NetworkSummary>
          </div>
          {advanced && <ul className="divide-y divide-brand-border-subtle border-t border-brand-border-subtle">{advanced}</ul>}
        </div>
      </li>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className={DIALOG_CLASS}>
          <DialogHeader className="pr-10 text-left">
            <DialogTitle>Adicionar nó manualmente</DialogTitle>
            <DialogDescription>Opcional. O nó mantém a sua conexão com a rede; ele não decide quem participa de cada mercado.</DialogDescription>
          </DialogHeader>
          <AddNodeForm copy={ADD_NODE_COPY} submitAvailable={false} unavailableNote={<WireNote ids={['nodeCatalog', 'manualServer']} />} onCancel={() => setAdding(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}
