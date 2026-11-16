/**
 * @satsails/p2p-trading-sdk — Sails P2P Trading SDK
 * See docs/SDK_GUIDE.md for the full interface specification and
 * docs/DEVELOPER_JOURNEY.md for the step-by-step onboarding flow.
 */
export { SailsClient, type SailsClientOptions } from './client'
// SailsTransport/SailsTransportOptions deliberately NOT re-exported here
// (audit finding, docs/TODO.md §28): internal plumbing SailsClient
// assembles itself — zero documented use case for an external caller
// constructing one directly, zero real external usage (packages/sails-ui,
// examples/simple-wallet), and this package's own tests already import
// it straight from './transport', never through this barrel. Still
// exported from transport.ts itself for that internal use; just not part
// of the public @satsails/p2p-trading-sdk surface.

export {
  SailsError,
  SailsValidationError,
  SailsNotFoundError,
  SailsEscrowError,
  SailsAuthError,
  SailsForbiddenError,
  SailsInternalError,
  SailsRateLimitError,
  SailsTransportError,
  SailsConfigError,
  SailsNotImplementedError,
} from './errors'

export {
  SailsIdentityModule,
  generateKeypair,
  hexToBytes,
  type Ed25519Keypair,
  type AuthenticateResult,
  type PublicParticipant,
} from './modules/identity'
export { SailsReputationModule, type RateInput } from './modules/reputation'
export {
  SailsLiquidityModule,
  type PublishOfferInput,
  type OrderBook,
  type MatchInput,
  type LiquidityOfferSummary,
  type DiscoverResult,
  type PublicOfferDetail,
  type PublicOfferSeller,
} from './modules/liquidity'
export {
  SailsOpenP2PModule,
  WebSocketChannel,
  type ChatFrame,
  type ChatMessageEvent,
  type WebSocketChannelOptions,
  type WebSocketConnectionState,
} from './modules/openp2p'
export {
  SailsSettlementModule,
  type CreateEscrowInput,
  recommendedEscrowType,
  type SafeGuardBundle,
  parseSafeGuardBundle,
  type ReleaseApproval,
  type ReleaseApprovalsResult,
  MULTISIG_CAPABILITY_PROFILE_V1,
  type AuthorityDecisionOutcome,
  type AuthorityDecisionInput,
  canonicalizeAuthorityDecision,
  hashAuthorityDecision,
  type ConditionResult,
  type SemanticIdentity,
  type DisputeRulingOutcome,
  type DisputeRulingAttribution,
  type DisputeRulingSemanticRecord,
} from './modules/settlement'
export { SailsProofModule, type EvidenceBundle, type AssertClaimInput, type SubmitProofInput, type VerifyProofInput } from './modules/proof'
export {
  SailsAgentsModule,
  type GeneratedTradeIntent,
  type GeneratedOfferIntent,
  type IntentRiskAssessment,
  type IntentRiskLevel,
  type IntentRiskRecommendation,
  type AssessableIntent,
} from './modules/agents'
export type { Proof, Verification } from './types'
export { generateEscrowKeypair, signEscrowPsbt, type EscrowKeypair } from './modules/escrow-key'
// Deterministic, recoverable participant-key derivation (Missão 10,
// Fase 6-9) — ADDITIVE to generateEscrowKeypair() above, which is
// unchanged and remains the default (fresh random, non-recoverable) key
// generation path. This is an opt-in mechanism for a wallet that wants
// seed + local-metadata recovery (Cenários A/B only — seed-only recovery
// with zero local metadata needs a server-side capability that does not
// exist today and is deliberately out of scope, see
// escrow-key-derivation.ts's own header comment).
export {
  deriveEscrowKey,
  recoverEscrowKey,
  verifyRecoveredKeyRegistration,
  buildEscrowKeyDerivationPath,
  EscrowKeyVerificationError,
  SAILS_ESCROW_PURPOSE,
  ESCROW_KEY_DERIVATION_VERSION,
  ESCROW_KEY_METADATA_FORMAT_VERSION,
  type EscrowKeyNetwork,
  type EscrowKeyRole,
  type EscrowScriptType,
  type EscrowKeyDerivationScope,
  type EscrowKeyRecord,
  type EscrowKeyMetadata,
  type EscrowRegistrationLookup,
} from './modules/escrow-key-derivation'
// InMemoryEscrowKeyIndexStore deliberately NOT re-exported here (Missão
// 10, Fase 6.10/6.11, CTO decision — Option B): it loses every counter on
// restart, so an integrator using it in production would silently
// reintroduce the exact account_index reuse risk this whole scheme
// exists to eliminate. The CONTRACT (EscrowKeyIndexStore) is the real
// public surface — a wallet integrator must implement it against real
// durable/transactional storage. Same "internal plumbing, not part of
// the public @satsails/p2p-trading-sdk surface" precedent this file
// already applies to SailsTransport above — still exported from its own
// source file for this monorepo's own tests, just not from this barrel.
export { type EscrowKeyIndexStore, type EscrowKeyIndexScope } from './modules/escrow-key-index-store'
// Pre-signature PSBT verification (Missão 10, Fase 6-9) — decodes the
// real PSBT and compares it against the caller's own expectation before
// any signature is produced. verifyAndSignEscrowPsbt() is the
// recommended entry point: signing is structurally unreachable when
// verification fails.
export {
  verifySigningIntent,
  verifyAndSignEscrowPsbt,
  deriveExpectedMultisigAddress,
  buildExpectedFeeAwareReleaseOutputs,
  computeProtocolFeeSatsExact,
  combineAndFinalizeEscrowPsbt,
  networkFromMultisigAddress,
  btcToSats,
  SigningIntentVerificationError,
  type EscrowOperation,
  type ExpectedSigningIntent,
  type SigningIntentMismatch,
  type SigningIntentVerification,
  type FeeAwareReleaseParams,
} from './modules/wallet-verification'
export { signEscrowArkTx } from './modules/escrow-ark-signing'
export { signEscrowSafeUserOp } from './modules/escrow-safe-signing'
export { SailsPeersModule, type StaticTopic } from './modules/peers'
export { SailsCapabilitiesModule, CANONICAL_CAPABILITY_SCOPES, type RegisterCapabilityInput } from './modules/capabilities'
export { SailsArbitrationModule, type ArbiterCandidate } from './modules/arbitration'
export { SailsPaymentAccountModule, type PaymentAccount, type PublicPaymentAccount } from './modules/payment-account'
export { hashPaymentAccount } from './payment-account'
export { encryptChatMessage, decryptChatMessage, type EncryptedChatMessage } from './chat-encryption'

// SailsIntentFacade (the class) deliberately NOT re-exported here (audit
// finding, docs/TODO.md §28): SailsClient.intents is private specifically
// so the delegate methods (createIntent/cancelIntent/negotiate/
// submitProof/releaseAsset/dispute — SDK_GUIDE.md's original six-verb
// facade — plus proposeTrade, an RFC-023 addition, not part of that
// original six-verb set) are the only supported entry point — exporting
// the class itself would let a caller construct one directly against a
// raw transport, bypassing SailsClient's session management entirely,
// exactly what `private` was meant to prevent. Zero real external usage
// confirmed. The two payload types below stay exported — negotiate()/
// submitProof() callers genuinely need them to construct their second
// argument.
export {
  type NegotiationEvent,
  type ProofSubmission,
} from './intent-facade'

export type { WalletAdapter, WalletCapabilitiesDeclaration } from './wallet-adapter'
// MockWalletAdapter — real, genuine external use case: README.md's own
// quickstart snippet needs a WalletAdapter a first-time visitor can run
// without a real wallet, and importing it via a relative source path
// (the previous state) only works inside this monorepo, not for an
// external `npm install @satsails/p2p-trading-sdk` consumer. Production Readiness Audit
// finding, closed 2026-08-09.
export { MockWalletAdapter } from './wallet-adapter-mock'
// LocalKeypairWalletAdapter — Missão 13 Fase 2 (INV-12, 2026-08-29): bridges
// an already-held Ed25519 identity keypair into the WalletAdapter shape
// resolveDisputeWithWallet()/authenticateWithWallet()/attachEvidence()
// expect, for a caller (e.g. sails-ui's AuthContext) that manages this
// exact keypair itself and needs to sign with that SAME registered public
// key — see wallet-adapter-local-keypair.ts's own header for the full
// rationale and its deliberately narrow scope (signMessage only).
export { LocalKeypairWalletAdapter } from './wallet-adapter-local-keypair'

// RFC-020 custody providers (fulfills RFC-019 Phase 2) — see
// packages/sails-sdk/src/custody/types.ts's own header comment.
export type {
  CustodyProvider,
  CreateEscrowAccountParams,
  EscrowAccount,
  UnsignedCustodyAction,
  PackedUserOperation,
  MuSig2Nonces,
  MuSig2Round,
} from './custody/types'
export { ERC4337CustodyProvider, hashUserOp, domainSeparator, getUserOpHash, type Erc4337CustodyConfig } from './custody/evm-4337'
export { BitcoinCustodyProvider, type EscrowRulingPath, type MuSig2SigningRound } from './custody/bitcoin-taproot'
export {
  SailsSignerService,
  parseDerSignature,
  toEthereumSignature,
  extractUncompressedPubkeyFromSpki,
  ethereumAddressFromUncompressedPubkey,
  type SailsSignerServiceConfig,
} from './custody/kms-signer'

export type {
  AssetType,
  TradeSide,
  OfferStatus,
  TradeStatus,
  EscrowType,
  EscrowStatus,
  PaymentMethod,
  DisputeStatus,
  DisputeRuling,
  IntentStatus,
  Participant,
  Offer,
  Trade,
  PaginatedTrades,
  Escrow,
  EscrowPendingTransaction,
  EscrowTransactionSignature,
  Dispute,
  Message,
  PaginatedMessages,
  ReputationScore,
  LeaderboardEntry,
  LeaderboardResult,
  Intent,
  TradeIntentPayload,
  TradeProposal,
  CounterProposal,
  TradeProposalOutcome,
  PeerStatus,
  CapabilityGrant,
  Vouch,
} from './types'
