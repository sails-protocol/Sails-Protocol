/**
 * PRE-M3-REALITY-GATE-1-R1 (2026-09-13) — pure, dependency-free error
 * classification extracted from `hooks/useEscrowKey.ts` and
 * `pages/Trade.tsx`.
 *
 * Context: PRE-M3-REALITY-GATE-1 (P3-F03/P3-F04, same date) fixed a real
 * bug class — a bare `catch { return null }` in `useEscrowKey.ts` and a
 * catch-all in `Trade.tsx`'s `ignoreExceptWrongPassphrase` both used to
 * treat EVERY error (a 401, a 403, a network failure, a timeout, a 500,
 * or a genuine 404) as silent "nothing to do." That mission's own CTO
 * follow-up found the fix's automated evidence proved only that the SDK
 * now *sends* the auth header (`packages/sails-sdk/tests/modules.test.ts`)
 * — nothing automated proved the failure-classification property itself:
 * that absence, failure, and unknown-but-real errors are actually kept
 * distinct. `packages/sails-ui` has no test runner configured at all
 * (pre-existing, disclosed TD#62/#63) and installing one (Vitest/RTL/
 * jsdom) just to prove this one property would be disproportionate — the
 * repo ROOT `jest.config.js` already picks up any file matching its
 * `testMatch` glob (a `.test.ts` file under a `tests` directory) anywhere
 * in the repo with zero new dependencies, as long as the
 * code under test is plain TypeScript with no React/DOM dependency
 * (exactly how `packages/sails-sdk/tests/modules.test.ts` already runs).
 * So the classification logic itself — previously inline inside a React
 * hook and inside a page component, both unreachable from that harness —
 * is extracted here as two small pure functions with no React, no DOM,
 * and no toast import: each returns a plain classification tag and lets
 * its caller (still inline in `useEscrowKey.ts`/`Trade.tsx`) decide what
 * to actually do (return null vs. throw; which toast text). Nothing
 * about either caller's *external behavior* changed — this is a pure
 * refactor for testability, not a semantics change. See
 * `packages/sails-ui/tests/escrowErrorClassification.test.ts` for the
 * scenarios this proves.
 *
 * Principle carried over unchanged from the original mission:
 * Absence ≠ Failure ≠ Unknown.
 */
import { SailsAuthError, SailsForbiddenError, SailsNotFoundError } from '@satsails/p2p-trading-sdk'
import { WrongPassphraseError } from './errors'

/**
 * Classifies the error `sailsClient.settlement.getPendingTransaction()`
 * threw, for `Trade.tsx`'s read-only `readPending()` (CTO 437 step 4: the
 * page only reads the round; signing is an explicit user action).
 *
 * `'absence'` — a genuine `SailsNotFoundError` (the real backend's
 * `getPendingTransaction()` throws this specifically when no pending
 * signing round exists for this escrow) — the ONLY case that may become
 * a no-op (`return null`).
 *
 * `'propagate'` — anything else: a `SailsAuthError` (401 — session
 * expired), a `SailsForbiddenError` (403 — wrong actor), a
 * `SailsTransportError` (network failure or timeout — both surface as
 * this type, see `packages/sails-sdk/src/transport.ts`), a
 * `SailsInternalError`/`SailsRateLimitError` (5xx/429), or any other
 * unexpected error. All of these must propagate to the caller — they are
 * real failures or unknowns, never legitimate absence.
 */
export type PendingTransactionErrorOutcome = 'absence' | 'propagate'

export function classifyPendingTransactionError(err: unknown): PendingTransactionErrorOutcome {
  return err instanceof SailsNotFoundError ? 'absence' : 'propagate'
}

/**
 * Classifies an error caught by `Trade.tsx`'s `ignoreExceptWrongPassphrase`
 * (the `.catch()` handler on `submitEscrowKeyIfNeeded()`). By the
 * time an error reaches here, `classifyPendingTransactionError()` above
 * has already filtered out genuine absence upstream (inside
 * `useEscrowKey.ts`) — so every outcome below is a real failure or a
 * genuinely unexpected error, and NONE of them may be silently dropped.
 *
 * `'wrong-passphrase'` — the user's own passphrase didn't decrypt their
 * stored escrow/identity key; has its own specific, actionable message.
 *
 * `'session-expired'` — a `SailsAuthError` (401); the session expired
 * mid-trade. Not absence, not the wrong-passphrase case — must surface a
 * session-expiry-specific outcome (see `docs/BACKLOG.md` item 34's
 * P3-F08 for the still-open product decision on an app-wide version of
 * this).
 *
 * `'forbidden'` — a `SailsForbiddenError` (403); this participant isn't
 * authorized for this escrow/action. Distinct from session expiry: the
 * session is valid, the actor isn't.
 *
 * `'unknown'` — every other case: network failure, timeout, 5xx, rate
 * limit, or any error type this function doesn't specifically recognize
 * (deliberately NOT a default-to-silent bucket — the caller must still
 * show a visible, honest "something went wrong" outcome, never nothing).
 */
export type SigningWatchErrorOutcome = 'wrong-passphrase' | 'session-expired' | 'forbidden' | 'unknown'

export function classifySigningWatchError(err: unknown): SigningWatchErrorOutcome {
  if (err instanceof WrongPassphraseError) return 'wrong-passphrase'
  if (err instanceof SailsAuthError) return 'session-expired'
  if (err instanceof SailsForbiddenError) return 'forbidden'
  return 'unknown'
}
