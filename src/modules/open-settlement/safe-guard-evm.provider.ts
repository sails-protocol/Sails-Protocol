/**
 * Sails OpenSettlement — SAFE_GUARD_EVM (Safe Transaction Guard + ERC-4337) SettlementProvider
 *
 * RFC-020's real EVM custody path — fulfills RFC-019 Phase 2. Same
 * custody-model shape MULTISIG/LIGHTNING_HODL already use: buyer and
 * seller each hold their own key client-side (`@satsails/p2p-trading-sdk`'s
 * `generateEscrowKeypair()` — the SAME compressed secp256k1 keypair
 * already submitted via `POST /v1/settlement/escrow/:id/submit-key`/
 * `EscrowParticipantKey`, reused as-is rather than inventing a second
 * key-submission mechanism); the one server-held key is the arbiter
 * co-signer, and it lives in AWS KMS (`SailsSignerService`, imported from
 * `@satsails/p2p-trading-sdk` rather than duplicated here — the userOpHash a co-signer
 * signs must be byte-identical on both client and server, so sharing the
 * real, already-tested implementation is safer than a second hand-written
 * copy that could silently drift).
 *
 * What's real here: constructing a real `PackedUserOperation` and its
 * real `userOpHash` (`@satsails/p2p-trading-sdk`'s `getUserOpHash()`); recovering each
 * submitted ECDSA signature's real signer address and combining them into
 * Safe's real, documented ascending-address-sorted packed-signature
 * format (`checkNSignatures()` in `Safe.sol`); CREATE2 address prediction
 * for both the Safe and the Guard (below); real on-chain balance checks
 * (`lockFunds()`) and real ERC-4337 bundler submission
 * (`broadcast()`) via a configured RPC/bundler endpoint. Never exercised
 * against a live funded Sepolia account or a live bundler in this
 * environment — same disclosed "verified structurally, not end-to-end"
 * boundary `MultisigProvider`/`LightningHodlProvider` already established.
 *
 * **Deployment design (2026-08-01 pass — the actual engineering gap this
 * pass closes):** the Safe is deployed via `SafeProxyFactory.setup()`
 * with `to=SafeModuleSetup, data=enableModules([safe4337Module])`
 * (Safe's own official pattern for atomically enabling a module at
 * setup time — no custom contract needed). The Guard (`SailsEscrowSafe`)
 * is deployed separately via the well-known EIP-2470-style deterministic
 * deployer (`0x4e59b44847...`, verified live-deployed on Sepolia below),
 * since its constructor needs the Safe's own address — computable
 * off-chain via CREATE2 before the Safe exists, so no circular
 * dependency. Attaching the guard (`Safe.setGuard()`) can only happen via
 * a Safe-authorized self-call (`SelfAuthorized.sol`'s `authorized`
 * modifier, read directly: `require(msg.sender == address(this))`) — it
 * genuinely cannot be set by a plain EOA call, so it needs the same
 * 2-of-3 signature flow release/refund already use. Rather than invent a
 * SEPARATE signing round for it (a materially bigger, riskier change —
 * new pending-transaction kind, new routes, new SDK surface), this pass
 * folds `setGuard()` into the SAME UserOp as the terminal release/refund
 * transfer, via a `MultiSendCallOnly` batch (Safe's own official
 * multi-call utility — no custom contract): [setGuard(guard),
 * transfer(to, amount)]. This is safe specifically because the Safe's
 * guard state is read ONCE at the top of `executeUserOp()`, before either
 * batched call executes — since the guard isn't set yet, it doesn't (and
 * structurally can't) gate this one bootstrap transaction, but the
 * transaction's own content is fixed entirely by this server's
 * `buildBundle()` logic before any signature is ever requested, not by
 * the signers — there is no window in which a compromised 2-of-3 set
 * could substitute a different, unauthorized transaction into that slot.
 * The guard becomes active for every transaction after this one, which
 * — by this protocol's own one-shot-per-trade design — there shouldn't
 * be. Only reached once per escrow, exactly like the existing
 * `buildUnsignedRelease()`/`buildUnsignedRefund()` release/refund flow.
 *
 * Every contract address below (Safe v1.4.1, Safe4337Module v0.3.0,
 * SafeModuleSetup, MultiSendCallOnly, the deterministic deployer) was
 * cross-checked two ways before being hardcoded: against
 * `safe-global/safe-deployments`'/`safe-global/safe-modules-deployments`'
 * own published registry, AND via a live `eth_getCode` call against
 * Sepolia confirming real, non-empty bytecode at each address — not
 * copied from memory or documentation alone. `SAFE_PROXY_CREATION_CODE`
 * below (needed for CREATE2 prediction, since `SafeProxyFactory` has no
 * external way to predict an address without it) was verified even more
 * strictly: read from the installed `@safe-global/safe-contracts@1.4.1-2`
 * package's own pre-built artifact, then independently confirmed
 * byte-for-byte identical to the real, deployed, canonical factory's own
 * `proxyCreationCode()` return value via a live `eth_call` — not merely
 * trusted from the npm package.
 *
 * `lockedAmount` is a Decimal string (RFC-009) — converted to wei via
 * exact string/BigInt math (`weiFromDecimalString` below), deliberately
 * NOT `multisig.provider.ts`'s own `Math.round(parseFloat(x) * 1e8)`
 * pattern: satoshi-scale (1e8) float conversion is an accepted existing
 * precedent for realistic trade sizes, but wei-scale (1e18) is a real,
 * much larger precision-loss risk RFC-009 exists specifically to avoid.
 *
 * Testnet-target only (Sepolia default). `AWS_KMS_KEY_ID` empty by
 * default — same "surface a clear config error, don't refuse to boot"
 * pattern as `MULTISIG_SEED`/`WDK_SEED_PHRASE`. The cooperative
 * (buyer+seller, no arbiter) release/refund path needs no AWS access at
 * all — only the disputed path touches KMS. Deriving the Safe/Guard's
 * addresses similarly needs no AWS access UNLESS the disputed path is in
 * play (the arbiter is one of the three owners regardless of path).
 */
import { getUserOpHash, SailsSignerService, ethereumAddressFromUncompressedPubkey, type PackedUserOperation } from '@satsails/p2p-trading-sdk'
// This file resolves @noble/curves from the ROOT node_modules (v1.x,
// real dual CJS/ESM). Root package.json now pins it explicitly
// (`^1.2.0`) rather than relying on incidental hoisting — a real
// `@arkade-os/sdk` patch bump (0.4.52 -> 0.4.58) once shifted its own
// transitive v2.x pin into winning the root slot, breaking this file's
// v1.x API assumption below with no change on this file's own side.
// A DIFFERENT resolution than packages/sails-sdk's own files get (forced
// to v2.x there by @arkade-os/sdk's transitive tree, see jest.config.js's
// own header comment). Confirmed via a real `node -e` probe against
// this exact install before writing this file, not assumed from the SDK
// code: v1.x uses `ProjectivePoint`/`Signature.fromCompact`/
// `.toRawBytes()`/`.recovery`, not v2.x's `Point`/`Signature.fromBytes`/
// `.toBytes()`/`.addRecoveryBit()` return shape.
import { secp256k1 } from '@noble/curves/secp256k1'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import {
  JsonRpcProvider,
  FetchRequest,
  Contract,
  Interface,
  AbiCoder,
  getCreate2Address,
  keccak256,
  concat,
  zeroPadValue,
  toBeHex,
  toUtf8Bytes,
} from 'ethers'
import { EscrowError } from '../../common/errors'
import { config } from '../../config'
import type { SettlementProvider } from './escrow.service'
import { boundedFetch, withBoundedRetry } from './bounded-rpc'
import { ensureFinalizationAttempt, recordFinalizationOutcome } from './signature-collection-finalization-truth'

// docs/TECHNICAL_DEBT_AUDIT.md #51 (F1) — bounded, safe retry for
// read-only RPC queries only (getNonce/getStorage/getBalance below).
// Never applied to broadcast() (a mutating/submission call) — see
// bounded-rpc.ts's own header. Timeout itself is NOT handled here — see
// provider() below.
const RPC_READ_RETRY = { attempts: 3, backoffMs: 250 }

const ZERO_BYTES32 = '0x' + '00'.repeat(32)

// Verified byte-for-byte against a live eth_call to the real, deployed factory (this file's own header comment) — do not hand-edit.
const SAFE_PROXY_CREATION_CODE = "0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564"

// Read directly from contracts/artifacts/contracts/SailsEscrowSafe.sol/SailsEscrowSafe.json — regenerate if SailsEscrowSafe.sol changes.
const SAILS_ESCROW_SAFE_CREATION_CODE = "0x6101008060405234610126576080816106a78038038091610020828561013f565b8339810103126101265761003381610178565b9061004060208201610178565b606061004e60408401610178565b920151604051631cea46b760e31b81529093906020816004816001600160a01b0386165afa8015610133576000906100fb575b60029150106100ea5760805260a05260c05260e05260405161051a908161018d823960805181818160e0015281816101f501526103b6015260a0518181816102410152610371015260c051818181608d01526102c4015260e05181818161027a01526103380152f35b633916714960e21b60005260046000fd5b506020813d60201161012b575b816101156020938361013f565b810103126101265760029051610081565b600080fd5b3d9150610108565b6040513d6000823e3d90fd5b601f909101601f19168101906001600160401b0382119082101761016257604052565b634e487b7160e01b600052604160045260246000fd5b51906001600160a01b03821682036101265756fe608080604052600436101561001357600080fd5b60003560e01c90816301ffc9a7146103e557508063186f0354146103a05780633dedf3dd1461035b5780636ab28bc81461032057806375f0bb52146101575780638f7758391461013457806393271368146100c157639aa8becd1461007757600080fd5b346100bc5760003660031901126100bc576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b600080fd5b346100bc5760403660031901126100bc5760243580151581036100bc577f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031633036101235761011457005b6000805460ff19166001179055005b6367a159eb60e01b60005260046000fd5b346100bc5760003660031901126100bc57602060ff600054166040519015158152f35b346100bc576101603660031901126100bc576004356001600160a01b038116908190036100bc5760443567ffffffffffffffff81116100bc5761019e903690600401610465565b906064359160028310156100bc576101b4610438565b50610104356001600160a01b038116036100bc576101243567ffffffffffffffff81116100bc576101e9903690600401610465565b506101f261044e565b507f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031633036101235760ff60005416610310576000921590811591610305575b506102f6577f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031681141590816102c2575b506102b3577f0000000000000000000000000000000000000000000000000000000000000000602435036102a45780f35b6349986e7360e01b8152600490fd5b63d64fd8b560e01b8152600490fd5b7f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03161415905082610273565b635ee8231160e01b8252600482fd5b90505115158361023a565b62560ff960e81b60005260046000fd5b346100bc5760003660031901126100bc5760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b346100bc5760003660031901126100bc576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b346100bc5760003660031901126100bc576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b346100bc5760203660031901126100bc576004359063ffffffff60e01b82168092036100bc5760209163736bd41d60e11b8114908115610427575b5015158152f35b6301ffc9a760e01b14905083610420565b60e435906001600160a01b03821682036100bc57565b61014435906001600160a01b03821682036100bc57565b81601f820112156100bc5780359067ffffffffffffffff82116104ce5760405192601f8301601f19908116603f0116840167ffffffffffffffff8111858210176104ce57604052828452602083830101116100bc57816000926020809301838601378301015290565b634e487b7160e01b600052604160045260246000fdfea2646970667358221220ce33335ec5e72985f6d4abe22ee41f7dbdbb0a09c8b77999b9aaf8611830e8ee64736f6c634300081c0033"

// keccak256("guard_manager.guard.address") — GuardManager.sol's own
// documented derivation, independently recomputed and confirmed to match
// before use, since GuardManager exposes no public getter for it
// (`getGuard()` is `internal`).
const GUARD_STORAGE_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8'

const SAFE_SETUP_IFACE = new Interface([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
])
const SAFE_MODULE_SETUP_IFACE = new Interface(['function enableModules(address[] modules)'])
const GUARD_MANAGER_IFACE = new Interface(['function setGuard(address guard)'])
const SAFE_4337_MODULE_IFACE = new Interface(['function executeUserOp(address to, uint256 value, bytes data, uint8 operation)'])
const ENTRY_POINT_IFACE = new Interface(['function getNonce(address sender, uint192 key) view returns (uint256 nonce)'])
const MULTISEND_CALL_ONLY_IFACE = new Interface(['function multiSend(bytes transactions)'])

// Deterministic per-trade salt — same "derive, don't store a second
// counter" precedent `wdk-settlement.provider.ts`'s tradeId-derived child
// account already uses.
export function deriveSaltNonce(tradeId: string): bigint {
  return BigInt(keccak256(toUtf8Bytes(tradeId)))
}

// Real CREATE2 math for a Safe deployed via `createProxyWithNonce()` —
// transcribed directly from `SafeProxyFactory.sol`'s own `deployProxy()`/
// `createProxyWithNonce()` (read in full before this was written):
//   deploymentData = SafeProxy.creationCode ++ abi.encode(uint256(uint160(singleton)))
//   salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce))
//   address = CREATE2(factory, salt, keccak256(deploymentData))
// `owners`/threshold=2/`to`=SafeModuleSetup/`data`=enableModules([safe4337Module])/
// `fallbackHandler`=safe4337Module are this protocol's fixed setup shape —
// not parameterized further, since every SAFE_GUARD_EVM escrow uses the
// exact same shape (only the three owner addresses and the salt differ).
export function predictSafeAddress(owners: [string, string, string], saltNonce: bigint): string {
  const enableModulesData = SAFE_MODULE_SETUP_IFACE.encodeFunctionData('enableModules', [[config.safeGuardEvm.safe4337Module]])
  const initializer = SAFE_SETUP_IFACE.encodeFunctionData('setup', [
    owners,
    2,
    config.safeGuardEvm.safeModuleSetup,
    enableModulesData,
    config.safeGuardEvm.safe4337Module,
    '0x0000000000000000000000000000000000000000',
    0,
    '0x0000000000000000000000000000000000000000',
  ])
  const salt = keccak256(concat([keccak256(initializer), zeroPadValue(toBeHex(saltNonce), 32)]))
  const deploymentData = concat([SAFE_PROXY_CREATION_CODE, zeroPadValue(config.safeGuardEvm.safeSingleton, 32)])
  return getCreate2Address(config.safeGuardEvm.safeProxyFactory, salt, keccak256(deploymentData))
}

// Real CREATE2 math for the Guard, deployed via the well-known
// EIP-2470-style deterministic deployer (any EVM chain that has it —
// verified live-deployed on Sepolia before use): the deployer's own
// bytecode does `create2(0, initCodeOffset, initCodeSize, salt)` with
// `salt`/`initCode` taken verbatim from calldata, so the standard CREATE2
// formula applies directly against the deployer's own address as
// `sender` — no dependency on its exact calldata packing.
export function predictGuardAddress(safeAddress: string, releaseTo: string, refundTo: string, lockedAmountWei: bigint, saltNonce: bigint): string {
  const constructorArgs = AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address', 'uint256'], [safeAddress, releaseTo, refundTo, lockedAmountWei])
  const initCode = concat([SAILS_ESCROW_SAFE_CREATION_CODE, constructorArgs])
  const salt = zeroPadValue(toBeHex(saltNonce), 32)
  return getCreate2Address(config.safeGuardEvm.deterministicDeployer, salt, keccak256(initCode))
}

export type SafeGuardEvmEscrowInput = {
  // Issue #240 - optional/additive, same reasoning as ArkEscrowInput's own comment: needed to bind
  // this provider's durable finalization-attempt evidence to the exact escrow.
  id?: string
  tradeId: string
  lockedAmount: string
  buyerPubkey?: string   // hex, 33-byte compressed secp256k1 — from EscrowParticipantKey, same as MULTISIG
  sellerPubkey?: string  // hex, 33-byte compressed secp256k1
  buyerId?: string
  sellerId?: string
  multisigAddr?: string | null // reused generic column — the deployed Safe's address, once real deployment exists
  status?: string
  triggeredBy?: string
}

// Exact string/BigInt decimal-to-wei conversion — no floats, no
// precision loss, per this file's own header comment.
export function weiFromDecimalString(decimal: string): bigint {
  const negative = decimal.startsWith('-')
  const unsigned = negative ? decimal.slice(1) : decimal
  const [intPart, fracPart = ''] = unsigned.split('.')
  if (fracPart.length > 18) {
    throw new EscrowError(`SAFE_GUARD_EVM provider: lockedAmount '${decimal}' has more than 18 decimal places — cannot represent as wei without precision loss`)
  }
  const paddedFrac = fracPart.padEnd(18, '0')
  const wei = BigInt(intPart || '0') * 10n ** 18n + BigInt(paddedFrac || '0')
  return negative ? -wei : wei
}

// Decompresses a client-submitted 33-byte compressed pubkey and derives
// its real Ethereum address — the same real point-decompression +
// keccak256 derivation `@satsails/p2p-trading-sdk`'s `ethereumAddressFromUncompressedPubkey()`
// already implements and tests, reused rather than duplicated.
export function ethereumAddressFromCompressedHex(hex: string | undefined, role: 'buyer' | 'seller', tradeId: string): string {
  if (!hex) {
    throw new EscrowError(
      `SAFE_GUARD_EVM provider requires a submitted ${role} pubkey for trade ${tradeId} — call POST /v1/settlement/escrow/:id/submit-key first (see EscrowParticipantKey)`
    )
  }
  const compressed = hexToBytes(hex)
  if (compressed.length !== 33) {
    throw new EscrowError(`SAFE_GUARD_EVM provider: ${role} pubkey for trade ${tradeId} must be a 33-byte compressed secp256k1 key, got ${compressed.length} bytes`)
  }
  const uncompressed = secp256k1.ProjectivePoint.fromHex(compressed).toRawBytes(false)
  return ethereumAddressFromUncompressedPubkey(uncompressed)
}

// Recovers a submitted 65-byte (r||s||v) Ethereum signature's real
// signer address against a known digest — the inverse of
// `@satsails/p2p-trading-sdk`'s `toEthereumSignature()`, needed here to sort submitted
// signatures into Safe's real ascending-address order before combining.
export function recoverSignerAddress(signatureHex: string, digest: Uint8Array): string {
  let sig: Uint8Array
  try {
    sig = hexToBytes(signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex)
  } catch (err) {
    throw new EscrowError(`SAFE_GUARD_EVM provider: '${signatureHex}' is not valid hex: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (sig.length !== 65) throw new EscrowError(`SAFE_GUARD_EVM provider: expected a 65-byte (r,s,v) signature, got ${sig.length} bytes`)
  const v = sig[64]
  if (v !== 27 && v !== 28) throw new EscrowError(`SAFE_GUARD_EVM provider: signature's recovery byte must be 27 or 28, got ${v}`)
  let recovered: Uint8Array
  try {
    recovered = secp256k1.Signature.fromCompact(sig.slice(0, 64))
      .addRecoveryBit(v - 27)
      .recoverPublicKey(digest)
      .toRawBytes(false)
  } catch (err) {
    throw new EscrowError(`SAFE_GUARD_EVM provider: failed to recover a signer address from the submitted signature: ${err instanceof Error ? err.message : String(err)}`)
  }
  return ethereumAddressFromUncompressedPubkey(recovered)
}

interface SerializedUserOp extends Omit<PackedUserOperation, 'nonce' | 'preVerificationGas'> {
  nonce: string
  preVerificationGas: string
}

interface SafeGuardBundle {
  path: 'COOPERATIVE' | 'DISPUTED_RELEASE' | 'DISPUTED_REFUND'
  userOp: SerializedUserOp
  userOpHash: string // hex, no 0x prefix
  toAddress: string
  guardAddress: string
  // Deploying SailsEscrowSafe needs no trade-party signature at all — its
  // constructor args are immutable and fixed by this bundle, so ANYONE
  // (typically the seller, motivated to move the trade forward) can
  // permissionlessly submit this raw transaction with their own gas
  // before signing the userOp below. `to`/`data` are the deterministic
  // deployer's own real calldata format ("32-byte salt followed by init
  // code" — its own published README, verified before use).
  guardDeployment: { to: string; data: string }
  preEmbeddedSignature?: { address: string; signatureHex: string } // arbiter's, disputed path only
}

// MultiSendCallOnly.sol's own real packed sub-transaction format (read
// directly before this was written): operation(1 byte, must be 0/Call —
// this version reverts on delegatecall) || to(20 bytes) || value(32
// bytes) || dataLength(32 bytes) || data.
function packMultiSendTx(to: string, value: bigint, data: string): string {
  const dataLength = BigInt((data.length - 2) / 2)
  return concat(['0x00', to, zeroPadValue(toBeHex(value), 32), zeroPadValue(toBeHex(dataLength), 32), data])
}

function serializeUserOp(userOp: PackedUserOperation): SerializedUserOp {
  return { ...userOp, nonce: userOp.nonce.toString(), preVerificationGas: userOp.preVerificationGas.toString() }
}

function deserializeUserOp(serialized: SerializedUserOp): PackedUserOperation {
  return { ...serialized, nonce: BigInt(serialized.nonce), preVerificationGas: BigInt(serialized.preVerificationGas) }
}

export class SafeGuardEvmProvider implements SettlementProvider {
  name = 'SAFE_GUARD_EVM'
  readonly custodyModel = 'client-held-buyer-seller-keys-server-held-kms-arbiter' as const

  private signerService(): SailsSignerService {
    if (!config.safeGuardEvm.kmsKeyId) {
      throw new EscrowError(
        'SAFE_GUARD_EVM provider requires AWS_KMS_KEY_ID configured (.env.example) — refusing to attempt arbiter co-signing without a real KMS key'
      )
    }
    return new SailsSignerService({ region: config.safeGuardEvm.kmsRegion, keyId: config.safeGuardEvm.kmsKeyId })
  }

  // docs/TECHNICAL_DEBT_AUDIT.md #51 (F1) — real, transport-level bounded
  // liveness, not a Promise.race() wrapper. Confirmed by direct
  // inspection of the installed ethers@6.17.0 source
  // (node_modules/ethers/lib.commonjs/utils/geturl.js) plus an empirical
  // test against a TCP server that accepts a connection and never
  // responds: FetchRequest.timeout is applied via Node's own
  // http.ClientRequest.setTimeout(), which genuinely rejects a hung
  // request at the configured bound with a distinguishable TIMEOUT-coded
  // error — not merely a caller-side race against an uncancelled call.
  // (Honestly disclosed, not fixed here — would need a custom transport,
  // which this mission's Simplicity Rule forbids: ethers' own timeout
  // handler does not call request.destroy(), so the underlying TCP
  // connection is not guaranteed torn down immediately. There is no
  // overlapping-attempts concern from this, though — see
  // bounded-rpc.ts's withBoundedRetry() header for why.)
  private provider(): JsonRpcProvider {
    const connection = new FetchRequest(config.safeGuardEvm.rpcUrl)
    connection.timeout = config.safeGuardEvm.rpcRequestTimeoutMs
    return new JsonRpcProvider(connection)
  }

  // The Safe's 3 owners (buyer, seller, arbiter), 2-of-3 threshold — the
  // arbiter's own address is needed here even on the cooperative path,
  // since the owner list (and therefore the Safe's CREATE2 address) is
  // fixed at deployment regardless of whether a dispute ever happens.
  // This is a real, disclosed change from this file's previous
  // "cooperative path needs no AWS access" claim, which only ever applied
  // to co-SIGNING (`SailsSignerService.signDigest()`) — getAddress() below
  // is a read-only KMS `GetPublicKeyCommand`, never `Sign`, but it is now
  // unconditionally required to derive a Safe address at all.
  private async owners(escrow: Pick<SafeGuardEvmEscrowInput, 'tradeId' | 'buyerPubkey' | 'sellerPubkey'>): Promise<[string, string, string]> {
    const buyer = ethereumAddressFromCompressedHex(escrow.buyerPubkey, 'buyer', escrow.tradeId)
    const seller = ethereumAddressFromCompressedHex(escrow.sellerPubkey, 'seller', escrow.tradeId)
    const arbiter = await this.signerService().getAddress()
    return [buyer, seller, arbiter]
  }

  // The `NON_CUSTODIAL_PROVIDERS` write path (`escrow.service.ts`'s
  // `submitParticipantKey()`) — called once both buyer and seller pubkeys
  // have arrived, same timing MULTISIG/LIGHTNING_HODL already use. Pure
  // CREATE2 math once owners are known — no RPC needed.
  async getDepositAddress(tradeId: string, buyerPubkey: string, sellerPubkey: string): Promise<{ address: string }> {
    const owners = await this.owners({ tradeId, buyerPubkey, sellerPubkey })
    // Missão 11 Fase 5.2 — return shape widened to match
    // NON_CUSTODIAL_PROVIDERS' shared interface (escrow-providers.ts's own
    // comment). This provider's KMS-backed arbiter co-signer address is NOT
    // persisted here — out of this phase's explicit MULTISIG-only scope.
    return { address: predictSafeAddress(owners, deriveSaltNonce(tradeId)) }
  }

  private requireSafeAddress(escrow: SafeGuardEvmEscrowInput): string {
    if (!escrow.multisigAddr) {
      throw new EscrowError(
        `SAFE_GUARD_EVM provider: no Safe address recorded for trade ${escrow.tradeId} — submit both buyer and seller pubkeys first ` +
        '(POST /v1/settlement/escrow/:id/submit-key), which derives and persists it automatically.'
      )
    }
    return escrow.multisigAddr
  }

  private async buildUserOp(escrow: SafeGuardEvmEscrowInput, toAddress: string, guardAddress: string): Promise<PackedUserOperation> {
    const sender = this.requireSafeAddress(escrow)
    const rpc = this.provider()
    const entryPoint = new Contract(config.safeGuardEvm.entryPointAddress, ENTRY_POINT_IFACE, rpc)
    // Real nonce — INonceManager.getNonce(sender, key=0), read directly
    // from the installed @account-abstraction/contracts interface before
    // this was written. docs/TECHNICAL_DEBT_AUDIT.md #51 (F1) — timeout
    // is native (provider() above); safe retry (read-only, no side
    // effect) only.
    const nonce: bigint = await withBoundedRetry(() => entryPoint.getNonce(sender, 0), RPC_READ_RETRY)
    // Real check for whether the guard is already active — GuardManager
    // exposes no public getter, so this reads its own documented storage
    // slot directly. Expected to always be unset the one time this runs
    // per escrow (this protocol's one-shot-per-trade design), but checked
    // rather than assumed. Timeout is native (provider() above); safe
    // retry only, same as above.
    const guardStorage = await withBoundedRetry(() => rpc.getStorage(sender, GUARD_STORAGE_SLOT), RPC_READ_RETRY)
    const guardAlreadySet = BigInt(guardStorage) !== 0n
    const transferValue = weiFromDecimalString(escrow.lockedAmount)

    let callData: string
    if (guardAlreadySet) {
      // Guard already active (shouldn't happen in this protocol's
      // one-shot design, handled defensively anyway): a plain guarded
      // transfer, no MultiSend/setGuard needed — this is the shape
      // SailsEscrowSafe.checkTransaction() itself requires.
      callData = SAFE_4337_MODULE_IFACE.encodeFunctionData('executeUserOp', [toAddress, transferValue, '0x', 0])
    } else {
      // Bootstrap transaction — see this file's own header comment for
      // why bundling setGuard() with the transfer here, in the Safe's
      // very first transaction, is safe. Both sub-calls are plain
      // self-originated calls (operation=0) from the Safe, batched via a
      // DELEGATECALL (operation=1) to MultiSendCallOnly so `address(this)`
      // stays the Safe throughout.
      const setGuardData = GUARD_MANAGER_IFACE.encodeFunctionData('setGuard', [guardAddress])
      const multiSendData = MULTISEND_CALL_ONLY_IFACE.encodeFunctionData('multiSend', [
        concat([packMultiSendTx(sender, 0n, setGuardData), packMultiSendTx(toAddress, transferValue, '0x')]),
      ])
      callData = SAFE_4337_MODULE_IFACE.encodeFunctionData('executeUserOp', [config.safeGuardEvm.multiSendCallOnly, 0n, multiSendData, 1])
    }

    return {
      sender,
      nonce,
      initCode: '0x',
      callData,
      // Real gas ESTIMATION (as opposed to real gas FIELDS) is a separate,
      // bundler-specific concern (`eth_estimateUserOperationGas`) this
      // pass does not attempt — a real bundler will reject zero gas
      // limits with a clear, real error in broadcast() below, rather than
      // this code silently fabricating a plausible-looking estimate.
      accountGasLimits: ZERO_BYTES32,
      preVerificationGas: 0n,
      gasFees: ZERO_BYTES32,
      paymasterAndData: '0x',
      signature: '0x',
    }
  }

  private async buildBundle(
    escrow: SafeGuardEvmEscrowInput,
    toAddress: string,
    disputedPath: 'DISPUTED_RELEASE' | 'DISPUTED_REFUND'
  ): Promise<{ psbtBase64: string; requiredSigners: string[] }> {
    const releaseTo = ethereumAddressFromCompressedHex(escrow.buyerPubkey, 'buyer', escrow.tradeId)
    const refundTo = ethereumAddressFromCompressedHex(escrow.sellerPubkey, 'seller', escrow.tradeId)
    const lockedAmountWei = weiFromDecimalString(escrow.lockedAmount)
    const saltNonce = deriveSaltNonce(escrow.tradeId)
    const sender = this.requireSafeAddress(escrow)
    const guardAddress = predictGuardAddress(sender, releaseTo, refundTo, lockedAmountWei, saltNonce)
    const guardConstructorArgs = AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address', 'uint256'], [sender, releaseTo, refundTo, lockedAmountWei])
    const guardInitCode = concat([SAILS_ESCROW_SAFE_CREATION_CODE, guardConstructorArgs])
    const guardDeploymentSalt = zeroPadValue(toBeHex(saltNonce), 32)

    const userOp = await this.buildUserOp(escrow, toAddress, guardAddress)
    const hash = getUserOpHash(userOp, config.safeGuardEvm.chainId, config.safeGuardEvm.entryPointAddress)
    const bundle: SafeGuardBundle = {
      path: escrow.status === 'DISPUTED' ? disputedPath : 'COOPERATIVE',
      userOp: serializeUserOp(userOp),
      userOpHash: bytesToHex(hash),
      toAddress,
      guardAddress,
      guardDeployment: { to: config.safeGuardEvm.deterministicDeployer, data: concat([guardDeploymentSalt, guardInitCode]) },
    }

    if (escrow.status === 'DISPUTED') {
      const signer = this.signerService()
      const [signatureHex, address] = await Promise.all([
        signer.signDigest(hash).then(bytesToHex),
        signer.getAddress(),
      ])
      bundle.preEmbeddedSignature = { address, signatureHex }
      const requiredId = disputedPath === 'DISPUTED_RELEASE' ? escrow.buyerId : escrow.sellerId
      if (!requiredId) {
        throw new EscrowError(`SAFE_GUARD_EVM provider: missing ${disputedPath === 'DISPUTED_RELEASE' ? 'buyerId' : 'sellerId'} for disputed ${disputedPath.toLowerCase()} of trade ${escrow.tradeId}`)
      }
      return { psbtBase64: JSON.stringify(bundle), requiredSigners: [requiredId] }
    }

    if (!escrow.buyerId || !escrow.sellerId) {
      throw new EscrowError(`SAFE_GUARD_EVM provider: missing buyerId/sellerId for cooperative release/refund of trade ${escrow.tradeId}`)
    }
    return { psbtBase64: JSON.stringify(bundle), requiredSigners: [escrow.buyerId, escrow.sellerId] }
  }

  // Cooperative path: both buyer+seller required, arbiter never touched.
  // Disputed path: KMS arbiter pre-signs now (favoring the RELEASE
  // ruling), only the buyer is a real pending client signature.
  //
  // Missão 11 Fase 4 — rail-parity audit: fee-aware construction is
  // implemented for MULTISIG only this phase (see multisig.provider.ts).
  // Economic semantics remain identical (recordObligationForEscrowSettlement()
  // still fires for a SAFE_GUARD_EVM escrow via escrow-pending-tx.ts), but
  // this method's actual output construction is deliberately unchanged —
  // a policy-aware SAFE_GUARD_EVM escrow would need its own funding-exactness
  // and fee-output extension, not yet built. A smart-contract rail could
  // in principle enforce exact funding synchronously at deposit (Fase 3.4
  // §L) — a stronger mechanism than Bitcoin's after-the-fact check — but
  // that is a real, separate implementation this phase does not attempt.
  async buildUnsignedRelease(escrow: SafeGuardEvmEscrowInput, toAddress: string): Promise<{ psbtBase64: string; requiredSigners: string[] }> {
    return this.buildBundle(escrow, toAddress, 'DISPUTED_RELEASE')
  }

  // Mirror of buildUnsignedRelease(), refund-to-seller. Refund address =
  // the seller's own client-submitted-pubkey-derived Ethereum address —
  // same reference-stand-in gap dispute.service.ts's own comment already
  // flags for WDK's releaseToAddress, and the exact EVM analog of
  // MULTISIG's p2wpkh(sellerPubkey) refund address.
  async buildUnsignedRefund(escrow: SafeGuardEvmEscrowInput): Promise<{ psbtBase64: string; requiredSigners: string[]; toAddress: string }> {
    const toAddress = ethereumAddressFromCompressedHex(escrow.sellerPubkey, 'seller', escrow.tradeId)
    const result = await this.buildBundle(escrow, toAddress, 'DISPUTED_REFUND')
    return { ...result, toAddress }
  }

  // RFC-021 D9 (2026-08-02) — not supported, and not a service-layer gap:
  // SailsEscrowSafe.sol (contracts/contracts/SailsEscrowSafe.sol), the
  // Transaction Guard this whole provider is built around, hardcodes
  // `releaseTo`/`refundTo`/`lockedAmount` as immutable constructor
  // arguments and its checkTransaction() reverts with WrongAmount()
  // unless `value == lockedAmount` exactly — read directly from the
  // deployed contract source before writing this, not assumed. That's the
  // entire point of the guard (no server/arbiter can ever redirect this
  // Safe's funds anywhere else, non-custodial by construction) — it also
  // means there is no transaction this guard will ever authorize for a
  // partial amount to either address, let alone two. A real SPLIT here
  // would need a genuinely different guard contract (new constructor
  // shape, new checkTransaction() logic, new bytecode/CREATE2 address) —
  // a separate contracts-side undertaking, not attempted this pass.
  async buildUnsignedSplit(escrow: SafeGuardEvmEscrowInput, _buyerAddress: string, _sellerAddress: string, _buyerBps: number): Promise<{ psbtBase64: string; requiredSigners: string[] }> {
    throw new EscrowError(
      `SAFE_GUARD_EVM provider: SPLIT is not supported for trade ${escrow.tradeId} — the deployed SailsEscrowSafe guard contract only ` +
      'authorizes a transfer of the exact full lockedAmount to one of its two immutable releaseTo/refundTo addresses (checkTransaction() ' +
      'reverts WrongAmount() otherwise), by design, so no server-side change can make it accept a partial split. Use RELEASE or REFUND instead.',
      'UNSUPPORTED' // CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 39) — a real, structural rail limitation, not a config/policy/maturity gap
    )
  }

  // Real, tested logic: recovers each submitted signature's real signer
  // address, adds the pre-embedded arbiter one if present, sorts
  // ascending by address (Safe's real, documented checkNSignatures()
  // requirement — verified by reading Safe.sol directly before this was
  // written), and concatenates into Safe's real packed-signature format
  // (65 bytes per signer, no padding/separators). What happens after —
  // actually submitting this to a bundler — needs live infrastructure
  // this environment doesn't have.
  private async finalizeBundle(escrow: SafeGuardEvmEscrowInput, unsignedPsbtBase64: string, signedPsbtBase64List: string[], pendingTxId: string | undefined, kind: 'release' | 'refund'): Promise<{ txId: string }> {
    // Issue #240 - durable pre-submission evidence, written in the SAME call as the decision to
    // proceed (no `await` gap before it) — see signature-collection-finalization-truth.ts's own
    // header comment. escrow.id/pendingTxId are always present on the real call path.
    if (escrow.id && pendingTxId) {
      const ensured = await ensureFinalizationAttempt(escrow.id, pendingTxId, kind)
      if (ensured.action === 'RESUME_CONFIRMED') return { txId: ensured.txHash }
    }

    let bundle: SafeGuardBundle
    try {
      bundle = JSON.parse(unsignedPsbtBase64)
    } catch (err) {
      throw new EscrowError(`SAFE_GUARD_EVM provider: failed to parse the stored bundle for trade ${escrow.tradeId}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const digest = hexToBytes(bundle.userOpHash)

    const signatures: { address: string; signatureHex: string }[] = []
    if (bundle.preEmbeddedSignature) signatures.push(bundle.preEmbeddedSignature)
    for (const signatureHex of signedPsbtBase64List) {
      const address = recoverSignerAddress(signatureHex, digest)
      signatures.push({ address, signatureHex })
    }
    if (signatures.length === 0) {
      throw new EscrowError(`SAFE_GUARD_EVM provider: no signatures to finalize for trade ${escrow.tradeId}`)
    }

    signatures.sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1))
    const combined = '0x' + signatures.map((s) => (s.signatureHex.startsWith('0x') ? s.signatureHex.slice(2) : s.signatureHex)).join('')

    const userOp = deserializeUserOp(bundle.userOp)
    const result = await this.broadcast(userOp, combined)
    // eth_sendUserOperation returns the bundler-ACCEPTED userOpHash, not on-chain finality (this
    // method's own broadcast() comment) - recorded SUBMITTED, not CONFIRMED (see
    // signature-collection-finalization-truth.ts's own header comment on why this differs from
    // LIGHTNING_HODL). A thrown error above/in broadcast() leaves the durable row at
    // SUBMISSION_UNKNOWN, exactly the corrected lesson wdk-execution-truth.ts's header documents.
    if (escrow.id) await recordFinalizationOutcome(escrow.id, 'SUBMITTED', result.txId)
    return result
  }

  // Real eth_sendUserOperation submission — the standard ERC-4337 bundler
  // RPC method every bundler implementation (Alchemy, Pimlico, Stackup,
  // etc.) exposes. Returns the bundler-ACCEPTED userOpHash, not the
  // eventual on-chain transaction hash — that requires a separate,
  // later `eth_getUserOperationReceipt` poll once the bundler actually
  // includes it in a block, disclosed here rather than fabricated as an
  // immediate real txId.
  // docs/TECHNICAL_DEBT_AUDIT.md #51 (F1) — TIMEOUT_ONLY, deliberately no
  // retry: this submits a signed ERC-4337 UserOperation to a bundler. A
  // timeout after dispatch means the submission's real outcome is
  // UNKNOWN, not FAILED — the bundler may have already accepted it into
  // its mempool even though the HTTP response never arrived. Retrying is
  // not authorized by this mission (duplicate-submission idempotence
  // across bundler implementations is not proven); on timeout, the
  // bounded error propagates unchanged — no escrow-state semantics
  // change.
  private async broadcast(userOp: PackedUserOperation, combinedSignature: string): Promise<{ txId: string }> {
    if (!config.safeGuardEvm.bundlerUrl) {
      throw new EscrowError(
        'SAFE_GUARD_EVM provider: broadcasting requires SAFE_GUARD_EVM_BUNDLER_URL configured (.env.example) — the combined ' +
        'signature was built successfully; submission to a real bundler is the remaining gap.'
      )
    }
    const signedUserOp = {
      sender: userOp.sender,
      nonce: toBeHex(userOp.nonce),
      initCode: userOp.initCode,
      callData: userOp.callData,
      accountGasLimits: userOp.accountGasLimits,
      preVerificationGas: toBeHex(userOp.preVerificationGas),
      gasFees: userOp.gasFees,
      paymasterAndData: userOp.paymasterAndData,
      signature: combinedSignature,
    }
    const res = await boundedFetch(config.safeGuardEvm.bundlerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_sendUserOperation',
        params: [signedUserOp, config.safeGuardEvm.entryPointAddress],
      }),
    }, {
      timeoutMs: config.safeGuardEvm.rpcRequestTimeoutMs,
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.error) {
      throw new EscrowError(
        `SAFE_GUARD_EVM provider: bundler rejected the UserOperation for sender ${userOp.sender}: ${body.error?.message ?? res.statusText}`
      )
    }
    return { txId: body.result }
  }

  async finalizeRelease(escrow: SafeGuardEvmEscrowInput, unsignedPsbtBase64: string, signedPsbtBase64List: string[], pendingTxId?: string): Promise<{ txId: string }> {
    return this.finalizeBundle(escrow, unsignedPsbtBase64, signedPsbtBase64List, pendingTxId, 'release')
  }

  async finalizeRefund(escrow: SafeGuardEvmEscrowInput, unsignedPsbtBase64: string, signedPsbtBase64List: string[], pendingTxId?: string): Promise<{ txId: string }> {
    return this.finalizeBundle(escrow, unsignedPsbtBase64, signedPsbtBase64List, pendingTxId, 'refund')
  }

  // Non-custodial, same shape MULTISIG's own lockFunds() already uses:
  // the Safe's address was already derived and persisted by
  // getDepositAddress() above (submitParticipantKey()'s write path) — the
  // buyer/seller send their own collateral there directly; this method
  // only verifies external funding via a real on-chain balance check, it
  // never moves funds itself.
  async lockFunds(escrow: SafeGuardEvmEscrowInput): Promise<{ txId: string; address: string }> {
    const address = this.requireSafeAddress(escrow)
    // docs/TECHNICAL_DEBT_AUDIT.md #51 (F1) — timeout is native
    // (provider() above); safe retry (read-only balance check, no side
    // effect) only.
    const balance = await withBoundedRetry(() => this.provider().getBalance(address), RPC_READ_RETRY)
    const expected = weiFromDecimalString(escrow.lockedAmount)
    if (balance < expected) {
      throw new EscrowError(
        `No funding of at least ${expected} wei found at ${address} yet (currently ${balance} wei). This is a non-custodial ` +
        `provider — it verifies external funding, it does not move funds itself. Send the trade's collateral to ${address} first, then retry lockFunds.`
      )
    }
    // Unlike Bitcoin's UTXO model (MultisigProvider.fetchUtxos(), which
    // reports the real funding UTXO's own txid), a plain native-currency
    // balance check has no specific funding-transaction hash to report
    // without a third-party indexer/explorer API — disclosed here, not
    // fabricated as a real hash.
    return { txId: 'native-balance-verified-no-indexer', address }
  }

  // Not directly callable — same reasoning as MULTISIG/LIGHTNING_HODL:
  // buyer/seller keys are client-held, so a real release needs the
  // multi-step signature-collection flow above instead of a single
  // synchronous call.
  async releaseFunds(escrow: SafeGuardEvmEscrowInput, _toAddress: string): Promise<{ txId: string }> {
    throw new EscrowError(
      'SAFE_GUARD_EVM provider: releaseFunds() is not directly callable — buyer/seller keys are client-held. ' +
      `Use POST /v1/settlement/escrow/${escrow.tradeId}/initiate-release, then submit-transaction-signature, instead (see escrow.service.ts).`
    )
  }

  async refundFunds(escrow: SafeGuardEvmEscrowInput): Promise<{ txId: string }> {
    throw new EscrowError(
      'SAFE_GUARD_EVM provider: refundFunds() is not directly callable — buyer/seller keys are client-held. ' +
      `Use POST /v1/settlement/escrow/${escrow.tradeId}/initiate-refund, then submit-transaction-signature, instead (see escrow.service.ts).`
    )
  }
}

export const safeGuardEvmProvider = new SafeGuardEvmProvider()
