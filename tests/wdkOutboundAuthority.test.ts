/**
 * #235 R7G-F6C — WDK outbound authority, pure decisions: the gas-funding bytes are checked field by field
 * against their durable intent before any broadcast, a leg's maximum gas cost is read from its signed bytes,
 * and the outbound gas policy has no default. Real secp256k1 signatures (ethers), no network.
 */
jest.mock('@tetherto/wdk-wallet-evm', () => ({ __esModule: true, default: class FakeWalletManagerEvm {} }))

import { Wallet } from 'ethers'
import { legMaxGasCost, verifySignedGasFunding } from '../src/modules/open-settlement/wdk-outbound-authority'
import { WdkSignedTransactionMismatch } from '../src/modules/open-settlement/wdk-lock-authority'

const treasury = new Wallet('0x' + '11'.repeat(32))
const other = new Wallet('0x' + '22'.repeat(32))
const ESCROW = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const intent = { chainId: 31337, from: treasury.address, to: ESCROW, valueWei: 216_000_000_000_000n, nonce: 4 }
const tx = (over: Record<string, unknown> = {}) => ({
  type: 2, chainId: 31337n, nonce: 4, to: ESCROW, value: 216_000_000_000_000n, data: '0x',
  gasLimit: 21_000n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, ...over,
})

describe('verifySignedGasFunding() — the funding moves exactly the authorized value to the leg\'s account, nothing else', () => {
  it('accepts the exact intent and returns the hash computed from the bytes', async () => {
    const raw = await treasury.signTransaction(tx())
    const hash = verifySignedGasFunding(raw, intent)
    expect(verifySignedGasFunding(raw, intent, hash)).toBe(hash)
  })

  it.each([
    ['another chain', async () => treasury.signTransaction(tx({ chainId: 1n })), /chainId/],
    ['another signer', async () => other.signTransaction(tx()), /signer/],
    ['another nonce', async () => treasury.signTransaction(tx({ nonce: 5 })), /nonce/],
    ['another recipient (M10/M34)', async () => treasury.signTransaction(tx({ to: other.address })), /recipient/],
    ['more value (M14)', async () => treasury.signTransaction(tx({ value: 216_000_000_000_001n })), /value/],
    ['calldata (a token or contract call)', async () => treasury.signTransaction(tx({ data: '0xa9059cbb' })), /data/],
    ['a gas limit other than a plain transfer', async () => treasury.signTransaction(tx({ gasLimit: 50_000n })), /gas limit/],
    ['a legacy (type 0) transaction', async () => treasury.signTransaction({ ...tx(), type: 0, gasPrice: 1n, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined }), /type/],
  ])('refuses %s', async (_label, make, pattern) => {
    const raw = await make()
    expect(() => verifySignedGasFunding(raw, intent)).toThrow(WdkSignedTransactionMismatch)
    expect(() => verifySignedGasFunding(raw, intent)).toThrow(pattern)
  })

  it('refuses bytes whose hash is not the persisted hash, and undecodable bytes', async () => {
    const raw = await treasury.signTransaction(tx())
    expect(() => verifySignedGasFunding(raw, intent, '0x' + 'ab'.repeat(32))).toThrow(/hash/)
    expect(() => verifySignedGasFunding('0xdeadbeef', intent)).toThrow(/does not decode/)
  })
})

describe('legMaxGasCost() — the most a signed leg can spend on gas, from its own bytes', () => {
  it('is the signed gas limit times the signed maxFeePerGas', async () => {
    const raw = await treasury.signTransaction(tx({ to: ESCROW, data: '0x', gasLimit: 72_000n, maxFeePerGas: 3_000_000_000n }))
    expect(legMaxGasCost(raw)).toBe(72_000n * 3_000_000_000n)
  })
})

describe('outbound gas policy — no default, never a silently chosen production value', () => {
  const load = (env: Record<string, string>) => {
    const saved = { ...process.env }
    Object.assign(process.env, env)
    try {
      let mod!: { config: any; authority: any }
      jest.isolateModules(() => {
        mod = { config: require('../src/config').config, authority: require('../src/modules/open-settlement/wdk-outbound-authority') }
      })
      return mod
    } finally {
      process.env = saved
    }
  }

  it('unset by default; any missing piece refuses outbound before anything is claimed', () => {
    const { config, authority } = load({})
    expect([config.wdk.outboundMaxGasLimit, config.wdk.outboundMaxFeePerGasWei]).toEqual([undefined, undefined])
    expect(() => authority.assertWdkOutboundPolicy('e1')).toThrow(/no WDK_CHAIN_ID, WDK_FINALITY_CONFIRMATIONS, WDK_CORROBORATING_RPC_URL, WDK_OUTBOUND_MAX_GAS_LIMIT, WDK_OUTBOUND_MAX_FEE_PER_GAS_WEI configured/)
  })

  it('a complete explicit policy is accepted; a corroborator equal to the primary is not one', () => {
    const full = { WDK_CHAIN_ID: '31337', WDK_FINALITY_CONFIRMATIONS: '2', WDK_RPC_URL: 'http://a.test', WDK_CORROBORATING_RPC_URL: 'http://b.test', WDK_OUTBOUND_MAX_GAS_LIMIT: '100000', WDK_OUTBOUND_MAX_FEE_PER_GAS_WEI: '5000000000' }
    expect(() => load(full).authority.assertWdkOutboundPolicy('e1')).not.toThrow()
    expect(load(full).config.wdk.outboundMaxFeePerGasWei).toBe(5_000_000_000n)
    expect(() => load({ ...full, WDK_CORROBORATING_RPC_URL: 'HTTP://A.TEST' }).authority.assertWdkOutboundPolicy('e1')).toThrow(/no WDK_CORROBORATING_RPC_URL configured/)
    expect(() => load({ WDK_OUTBOUND_MAX_FEE_PER_GAS_WEI: '1.5' })).toThrow(/must be a positive integer/)
    expect(() => load({ WDK_OUTBOUND_MAX_FEE_PER_GAS_WEI: '0' })).toThrow(/must be a positive integer/)
  })
})
