// tests/helpers/economicChokeScan.ts
//
// F4 / invariant 3b, static layer of the completeness guard (P54b §3.1 with the GK's 4 additions, §4.1). A pure scanner: it takes
// { path: source } and returns the CALLS of the economic choke-point patterns that are NOT on the reviewed allow-list, and the
// allow-list entries that no longer match anything (so the list cannot age silently).
//
// It reads TEXT: an alias (`const c = prisma.escrow; c.create(...)`) escapes it. That is why the structural layer (database
// triggers, F4 slice S1) exists; the two layers are acceptance criteria together.
//
// Scope: src/** and scripts/** (GK 4.1-4). Comments are stripped first; definitions are not calls (a call is preceded by `.`).

export interface ChokeRule {
  readonly id: string
  readonly description: string
  /** Global regex over comment-stripped code. A match is a CALL (or a raw statement) of the pattern. */
  readonly pattern: RegExp
  /** The rule only applies to files whose path matches (a generic name such as `repo.create` is only meaningful in one service). */
  readonly onlyInFile?: RegExp
  /** Extra condition on the text that follows the match (used for "update ... with multisigAddr in data"). */
  readonly followedBy?: { readonly within: number; readonly pattern: RegExp }
  /** Reviewed places, `path` or `path::function`. */
  readonly allowed: readonly string[]
}

const ESCROW_REPOSITORY = 'src/modules/open-settlement/escrow-repository.ts'
const ESCROW_SERVICE = 'src/modules/open-settlement/escrow.service.ts'
const ROUTES = 'src/modules/open-settlement/settlement.routes.ts'
const ORCHESTRATOR = 'src/modules/open-settlement/settlement-orchestrator.ts'

export const CHOKE_RULES: readonly ChokeRule[] = [
  {
    id: 'ESCROW_ROW_CREATE',
    description: 'create / createMany / upsert on the escrow model, or a raw INSERT INTO "escrows"',
    pattern: /\bescrow\.(?:create|createMany|upsert)\s*\(|INSERT\s+INTO\s+"?escrows"?/gi,
    allowed: [`${ESCROW_REPOSITORY}::create`],
  },
  {
    id: 'ESCROW_REPOSITORY_CREATE_IN_SERVICE',
    description: 'this.repo.create inside the escrow service (the only caller is createEscrow)',
    pattern: /\brepo\.create\s*\(/g,
    onlyInFile: /(?:^|\/)escrow\.service\.ts$/,
    allowed: [`${ESCROW_SERVICE}::createEscrow`],
  },
  {
    id: 'ESCROW_REPOSITORY_CREATE_ANYWHERE',
    description: 'any call of EscrowRepository#create through the escrowRepository singleton',
    pattern: /\bescrowRepository\.create\s*\(/g,
    allowed: [],
  },
  {
    id: 'DEPOSIT_ADDRESS_DERIVATION',
    description: 'provider.getDepositAddress (derives the address the buyer pays)',
    pattern: /\.getDepositAddress\s*\(/g,
    allowed: [`${ESCROW_SERVICE}::submitParticipantKey`],
  },
  {
    id: 'DEPOSIT_ADDRESS_PERSIST',
    description: 'updateMultisigAddr (persists the deposit address)',
    pattern: /\.updateMultisigAddr\s*\(/g,
    allowed: [`${ESCROW_SERVICE}::submitParticipantKey`],
  },
  {
    id: 'MULTISIG_ADDR_UPDATE_MODEL',
    description: 'any escrow update / updateMany / upsert that carries multisigAddr in its data',
    pattern: /\bescrow\.(?:update|updateMany|upsert)\s*\(/g,
    followedBy: { within: 600, pattern: /multisigAddr/ },
    allowed: [`${ESCROW_REPOSITORY}::updateMultisigAddr`],
  },
  {
    id: 'MULTISIG_ADDR_UPDATE_RAW',
    description: 'raw SQL UPDATE "escrows" that touches multisigAddr',
    pattern: /UPDATE\s+"?escrows"?/gi,
    followedBy: { within: 600, pattern: /multisigAddr/ },
    allowed: [],
  },
  {
    id: 'CREATE_ESCROW_CALL',
    description: 'escrowService.createEscrow (A1 route, A2 orchestrator)',
    pattern: /\.createEscrow\s*\(/g,
    allowed: [ROUTES, `${ORCHESTRATOR}::executeSettlement`],
  },
  {
    id: 'LOCK_FUNDS_CALL',
    description: 'lockFunds: the service call (A4 route, A2 orchestrator) and the provider call (only from the service lockFunds)',
    pattern: /\.lockFunds\s*\(/g,
    allowed: [ROUTES, `${ORCHESTRATOR}::executeSettlement`, `${ESCROW_SERVICE}::lockFunds`],
  },
]

/** Removes block and line comments (keeps newlines so offsets stay meaningful for the enclosing-function lookup). */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, (_m, p1: string) => p1)
}

const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'typeof', 'new'])

/** The nearest preceding function / method name (heuristic; arrow callbacks in a route file fall back to the file). */
export function enclosingFunction(code: string, index: number): string | null {
  const head = code.slice(0, index)
  const re = /(?:^|\n)[ \t]*(?:export\s+)?(?:public\s+|private\s+|protected\s+|static\s+)*(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\([^;{}]*\)\s*(?::\s*[^;{=\n]+)?\s*\{/g
  let name: string | null = null
  for (let m = re.exec(head); m; m = re.exec(head)) {
    if (!NOT_A_FUNCTION.has(m[1])) name = m[1]
  }
  return name
}

export interface ChokeFinding { readonly rule: string; readonly path: string; readonly fn: string | null; readonly line: number }
export interface ChokeResult { readonly violations: ChokeFinding[]; readonly stale: Array<{ rule: string; allowed: string }>; readonly matches: ChokeFinding[] }

function isAllowed(allowed: readonly string[], path: string, fn: string | null): boolean {
  return allowed.some((a) => (a.includes('::') ? a === `${path}::${fn}` : a === path))
}

export function scanChokePoints(files: Record<string, string>, rules: readonly ChokeRule[] = CHOKE_RULES): ChokeResult {
  const violations: ChokeFinding[] = []
  const matches: ChokeFinding[] = []
  for (const [path, source] of Object.entries(files)) {
    const code = stripComments(source)
    for (const rule of rules) {
      if (rule.onlyInFile && !rule.onlyInFile.test(path)) continue
      const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g')
      for (let m = re.exec(code); m; m = re.exec(code)) {
        if (rule.followedBy) {
          const tail = code.slice(m.index, m.index + m[0].length + rule.followedBy.within)
          if (!rule.followedBy.pattern.test(tail)) continue
        }
        const fn = enclosingFunction(code, m.index)
        const line = code.slice(0, m.index).split('\n').length
        const finding = { rule: rule.id, path, fn, line }
        matches.push(finding)
        if (!isAllowed(rule.allowed, path, fn)) violations.push(finding)
      }
    }
  }
  const stale: Array<{ rule: string; allowed: string }> = []
  for (const rule of rules) {
    for (const a of rule.allowed) {
      const seen = matches.some((f) => f.rule === rule.id && (a.includes('::') ? a === `${f.path}::${f.fn}` : a === f.path))
      if (!seen) stale.push({ rule: rule.id, allowed: a })
    }
  }
  return { violations, stale, matches }
}
