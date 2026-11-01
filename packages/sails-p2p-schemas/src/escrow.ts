/**
 * Escrow creation — sails-p2p-schemas (Bounded Remediation F5,
 * docs/TECHNICAL_DEBT_AUDIT.md #52).
 *
 * The canonical STRUCTURAL contract for `POST /v1/settlement/escrow` —
 * field names, enum values, required/optional status. Before this file
 * existed, the SDK (`packages/sails-sdk/src/modules/settlement.ts`'s
 * `CreateEscrowInput`) and the server
 * (`src/modules/open-settlement/settlement.routes.ts`'s `createEscrowSchema`,
 * `src/modules/open-settlement/escrow.service.ts`'s own `CreateEscrowInput`)
 * each independently declared the same field list and the same two enum
 * value lists — real historical drift already happened once
 * (`WDK_USDT_EVM`/`SAFE_GUARD_EVM` were both missing from the server's
 * validator after being added as real providers; see that file's own
 * git history). Both sides now import this file's exports directly, so
 * a future addition/removal only needs to happen here.
 *
 * This file is the structural source of truth ONLY — it is not, and
 * must not become, a second runtime validator. `settlement.routes.ts`'s
 * `createEscrowSchema` (zod) remains the sole runtime validation
 * authority; its enums are built FROM `ESCROW_TYPE_VALUES`/
 * `ASSET_TYPE_VALUES` below (`z.enum(ESCROW_TYPE_VALUES)`), so parity is
 * structural (the same array) rather than two independently-maintained
 * validators that could silently diverge — e.g. `lockedAmount`'s real
 * validation (`common/validation.ts`'s `positiveDecimalString()`,
 * finite and >0) is business logic that belongs only to the server;
 * a second, weaker structural check here (e.g. "just a non-empty
 * string") would misrepresent what the real server actually enforces.
 * An earlier version of this file added such a validator
 * (`isValidCreateEscrowInput()`) — removed after CTO review found it
 * created exactly the drift risk this fix exists to close.
 *
 * Scope, deliberately narrow: this is the escrow-CREATION structural
 * contract only. `AssetType`/`EscrowType` remain independently declared
 * elsewhere for their own broader, non-creation-specific purposes
 * (`src/common/types/index.ts`, `src/common/types/trade.ts`,
 * `packages/sails-sdk/src/types.ts` — Offer/Trade/PayoutAddress response
 * shapes, not escrow creation) — today structurally identical to the
 * values below, unchanged by this file, out of this fix's scope.
 * Consolidating every use of these two enums repo-wide is a materially
 * bigger, separate undertaking this fix does not attempt.
 *
 * This file defines field names, enum membership, and required/optional
 * status only. It does NOT decide whether an amount is a valid positive
 * decimal (server-only, see above), which escrow type a given asset
 * defaults to (client/server business logic,
 * `recommendedEscrowType()`/`escrow.service.ts`'s own default), or
 * whether a given `EscrowType` is production-ready (provider maturity,
 * entirely separate from structural acceptance — `LIQUID_COVENANT`
 * below is a real, currently-accepted enum value even though its
 * provider is reserved/unimplemented, exactly the same distinction
 * `docs/DATABASE.md` §2 already documents; this fix does not change
 * that status).
 *
 * Zero runtime dependencies, matching this package's own convention
 * (see index.ts's header) — no zod here, and no hand-written validator
 * either (see above).
 */

export const ESCROW_TYPE_VALUES = [
  'MULTISIG',
  'LIGHTNING_HODL',
  'LIQUID_COVENANT',
  'WDK_USDT_EVM',
  'SAFE_GUARD_EVM',
  'MOCK',
] as const

export type EscrowType = (typeof ESCROW_TYPE_VALUES)[number]

export const ASSET_TYPE_VALUES = [
  'BTC',
  'USDT_ERC20',
  'USDT_TRC20',
  'USDT_LIQUID',
  'USDT_LIGHTNING',
  'LN_BTC',
  'LIQUID_BTC',
  'SPARK',
  'STACKS',
  'RSK_BTC',
] as const

export type AssetType = (typeof ASSET_TYPE_VALUES)[number]

export interface CreateEscrowInput {
  tradeId: string
  type?: EscrowType
  /** Decimal string (RFC-009), never a JS number. Positivity/format is validated server-side only (common/validation.ts's positiveDecimalString()) — a business rule, not a structural fact. */
  lockedAmount: string
  asset: AssetType
  network?: string
  /** @deprecated Ignored by the server (Master Backlog R5): the timelock is protocol policy (DEFAULT_TIMELOCK_HOURS), frozen on the escrow at creation and returned as Escrow.timelockHours. Still accepted so existing clients are not rejected. */
  timelockHours?: number
}
