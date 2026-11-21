/**
 * Small, dependency-free error classes shared across the UI's auth/escrow
 * key flows.
 *
 * PRE-M3-REALITY-GATE-1-R1 (2026-09-13) — `WrongPassphraseError` used to
 * live inline in `context/AuthContext.tsx`, which is fine for every real
 * caller (Login.tsx, Trade.tsx, useEscrowKey.ts all already import it from
 * there and keep doing so — see the re-export at the bottom of
 * AuthContext.tsx) but is the wrong home for a plain `instanceof` check
 * that a *pure, dependency-free* classification function needs to import:
 * AuthContext.tsx also imports `lib/sailsClient.ts` (which reads
 * `import.meta.env` — real Vite syntax ts-jest/CommonJS cannot transform)
 * and `lib/keyEncryption.ts` (real `localStorage`/WebCrypto calls at
 * module scope), so importing AuthContext.tsx from a Jest test — even
 * just to reach one class — would drag in code this repo's own
 * `packages/sails-ui` "no test runner configured" gap (TD#62/#63) exists
 * precisely to avoid pulling into a plain Node test. Moving the class
 * itself to this leaf module (no imports at all) lets
 * `escrowErrorClassification.ts` import it directly, with zero risk of
 * dragging React/DOM/Vite-only syntax into the test process. Nothing
 * about the class's behavior or its public import path from
 * `context/AuthContext` changed — see that file's own re-export.
 */
export class WrongPassphraseError extends Error {
  constructor(message = 'Senha incorreta.') {
    super(message)
    this.name = 'WrongPassphraseError'
  }
}

// SDK 409 codes from trade admission (PR #651), matched by `code` string so
// this leaf module stays import-free (SailsError carries `code`).
const SDK_ERROR_MESSAGES: Record<string, string> = {
  INTENT_BOUND: 'Esta intenção já está vinculada a um trade e não pode ser removida.',
  AMBIGUOUS_INTENT: 'Esta intenção corresponde a mais de um trade. Abra o trade pela lista de Trades Ativos.',
  IDEMPOTENCY_OUTCOME_UNKNOWN: 'Não foi possível confirmar se o trade foi criado. Confira seus Trades Ativos antes de tentar de novo.',
}

/** User-facing message for a caught error: known SDK codes first, then the error's own message, then `fallback`. */
export function errorMessage(err: unknown, fallback: string): string {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && SDK_ERROR_MESSAGES[code]) return SDK_ERROR_MESSAGES[code]
  return err instanceof Error && err.message ? err.message : fallback
}
