import { EscrowError } from '../../common/errors'

/**
 * Issue #299 - UNKNOWN is not FAILED. The ONE MULTISIG failure that proves the round's transaction had no effect:
 * it could not be built, so nothing was ever sent. Only this lets the live caller release its claim. Once a
 * transaction has been POSTed, nothing a single explorer says proves it never propagated (CTO D1), so every later
 * error keeps the claim and PASS 1 converges from chain truth. Leaf module, so escrow-pending-tx.ts can recognise
 * it without importing the provider.
 */
export class SubmissionDefinitelyFailed extends EscrowError {}

/**
 * Issue #299 (CTO D1/D3) - the node answered 400 with an identifiable RPC rejection and the transaction is not
 * visible on this explorer. Still UNKNOWN (another node may already have it), but no automatic recovery will
 * converge it: PASS 1 routes it to manual review with the txid.
 */
export class BroadcastRejected extends EscrowError {}
