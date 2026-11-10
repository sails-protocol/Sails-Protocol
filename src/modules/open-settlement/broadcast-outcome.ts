import { EscrowError } from '../../common/errors'

/**
 * Issue #299 - UNKNOWN is not FAILED. The ONE MULTISIG failure that proves the round's transaction had no effect:
 * it never reached the network (the round could not be built), or the node refused it and the chain confirms the
 * txid is unknown and the funding outpoint unspent. Only this lets the caller release its claim; any other error
 * after the claim is UNKNOWN and keeps it, and PASS 1 converges from chain truth. Leaf module, so
 * escrow-pending-tx.ts can recognise it without importing the provider.
 */
export class SubmissionDefinitelyFailed extends EscrowError {}
