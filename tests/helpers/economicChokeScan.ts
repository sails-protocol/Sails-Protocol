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
//
// Found while designing S1: `updateLockResult` writes `multisigAddr` through a `data` VARIABLE, so a pattern that looks for the
// word inside the call's own arguments misses it. The multisigAddr rule therefore looks at the WHOLE enclosing function.

export interface ChokeRule {
  readonly id: string
  readonly description: string
  /** Global regex over comment-stripped code. A match is a CALL (or a raw statement) of the pattern. */
  readonly pattern: RegExp
  /** The rule only applies to files whose path matches (a generic name such as `repo.create` is only meaningful in one service). */
  readonly onlyInFile?: RegExp
  /** Extra condition on the text that follows the match. */
  readonly followedBy?: { readonly within: number; readonly pattern: RegExp }
  /** Extra condition on the WHOLE enclosing function (signature and body): the rule only fires when the function mentions this. */
  readonly bodyContains?: RegExp
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
    id: 'DEPOSIT_ADDRESS_PERSIST_AT_LOCK',
    description: 'updateLockResult (the SECOND writer of multisigAddr: lockFunds stores the provider address with the funding)',
    pattern: /\.updateLockResult\s*\(/g,
    allowed: [`${ESCROW_SERVICE}::lockFunds`],
  },
  {
    id: 'MULTISIG_ADDR_UPDATE_MODEL',
    description: 'any escrow update / updateMany / upsert in a function that handles multisigAddr (the value may travel in a data variable)',
    pattern: /\bescrow\.(?:update|updateMany|upsert)\s*\(/g,
    bodyContains: /multisigAddr/,
    allowed: [`${ESCROW_REPOSITORY}::updateMultisigAddr`, `${ESCROW_REPOSITORY}::updateLockResult`],
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
    id: 'LOCK_PAIR_FOR_EFFECT_CALL',
    description: 'lockPairForEffect: lock order par first (F4_AUDITORIA_ORDEM_DE_LOCKS). Only the A1 entry may take the pair lock; a caller that already holds an escrow/economic lock (reconciler, C4, sweeps, dispute) must never call it',
    pattern: /(?<!function\s+)\blockPairForEffect\s*\(/g,
    allowed: [`${ESCROW_SERVICE}::createEscrow`],
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
// A declaration is a line that starts with optional modifiers and a name, then `(...)` on ONE line (it may contain object-type
// params such as `data: { a: string; b: number }`), an optional return type, and `{` ending the line.
const DECLARATION = /(?:^|\n)[ \t]*(?:export\s+)?(?:public\s+|private\s+|protected\s+|static\s+)*(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\([^\n]*\)\s*(?::\s*[^{=\n]+)?\s*\{[ \t]*(?=\n)/g

interface FunctionRange { readonly name: string; readonly start: number; readonly end: number }

/** The nearest preceding function / method (heuristic): its name and the text range up to the next declaration. */
export function enclosingFunctionRange(code: string, index: number): FunctionRange | null {
  const head = code.slice(0, index)
  const re = new RegExp(DECLARATION.source, 'g')
  let found: { name: string; start: number } | null = null
  for (let m = re.exec(head); m; m = re.exec(head)) {
    if (!NOT_A_FUNCTION.has(m[1])) found = { name: m[1], start: m.index }
  }
  if (!found) return null
  const after = new RegExp(DECLARATION.source, 'g')
  after.lastIndex = Math.max(index, found.start + 1)
  let end = code.length
  for (let m = after.exec(code); m; m = after.exec(code)) {
    if (!NOT_A_FUNCTION.has(m[1])) { end = m.index; break }
  }
  return { name: found.name, start: found.start, end }
}

/** The nearest preceding function / method name (arrow callbacks in a route file fall back to the file). */
export function enclosingFunction(code: string, index: number): string | null {
  return enclosingFunctionRange(code, index)?.name ?? null
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
        const range = enclosingFunctionRange(code, m.index)
        if (rule.bodyContains) {
          const text = range ? code.slice(range.start, range.end) : code.slice(Math.max(0, m.index - 600), m.index + 600)
          if (!rule.bodyContains.test(text)) continue
        }
        const fn = range?.name ?? null
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
