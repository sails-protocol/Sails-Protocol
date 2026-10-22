/**
 * #235 R7G-F6B — the WDK LOCK authority's pure decisions: signed-transaction self-verification (every
 * economically relevant field, against independently held intent), receipt classification (only 0x1/0x0
 * decide; NF2), exact base units (NF1: never truncated, never through a JS number) and which attempt
 * states prove no funds can exist. Real secp256k1 signatures (ethers), no network.
 */
jest.mock('@tetherto/wdk-wallet-evm', () => ({ __esModule: true, default: class FakeWalletManagerEvm {} }))

import { Interface, Wallet } from 'ethers'
import { classifyLockReceipt, toExactBaseUnits, verifySignedLock, WdkSignedTransactionMismatch } from '../src/modules/open-settlement/wdk-lock-authority'
import { wdkAttemptIsNonEconomic } from '../src/modules/open-settlement/wdk-attempt-economics'

const ERC20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])
const signer = new Wallet('0x' + '11'.repeat(32))
const other = new Wallet('0x' + '22'.repeat(32))
const TOKEN = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const intent = { chainId: 31337, from: signer.address, token: TOKEN, recipient: RECIPIENT, baseUnits: 5_000_000n, nonce: 7 }

const tx = (over: Record<string, unknown> = {}) => ({
  type: 2, chainId: 31337n, nonce: 7, to: TOKEN, value: 0n, data: ERC20.encodeFunctionData('transfer', [RECIPIENT, 5_000_000n]),
  gasLimit: 72_000n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, ...over,
})

describe('verifySignedLock() — E/U5/U6: every field is checked before any broadcast', () => {
  it('accepts the exact intent and returns the hash computed from the bytes', async () => {
    const raw = await signer.signTransaction(tx())
    const hash = verifySignedLock(raw, intent)
    expect(verifySignedLock(raw, intent, hash)).toBe(hash)
  })

  it.each([
    ['another chain (U6)', async () => signer.signTransaction(tx({ chainId: 1n })), /chainId/],
    ['chainId 0 (the WDK unpopulated-field footgun)', async () => signer.signTransaction(tx({ chainId: 0n })), /chainId/],
    ['another signer', async () => other.signTransaction(tx()), /signer/],
    ['another nonce (M9)', async () => signer.signTransaction(tx({ nonce: 8 })), /nonce/],
    ['another token contract', async () => signer.signTransaction(tx({ to: RECIPIENT })), /token contract/],
    ['another recipient (M11)', async () => signer.signTransaction(tx({ data: ERC20.encodeFunctionData('transfer', [other.address, 5_000_000n]) })), /recipient/],
    ['another amount (M12)', async () => signer.signTransaction(tx({ data: ERC20.encodeFunctionData('transfer', [RECIPIENT, 5_000_001n]) })), /amount/],
    ['a native value', async () => signer.signTransaction(tx({ value: 1n })), /value/],
    ['other calldata', async () => signer.signTransaction(tx({ data: '0xa9059cbb' })), /calldata/],
    ['a legacy (type 0) transaction', async () => signer.signTransaction({ ...tx(), type: 0, gasPrice: 1n, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined }), /type/],
    ['zero gas', async () => signer.signTransaction(tx({ gasLimit: 0n })), /gas/],
  ])('refuses %s', async (_label, make, pattern) => {
    const raw = await make()
    expect(() => verifySignedLock(raw, intent)).toThrow(WdkSignedTransactionMismatch)
    expect(() => verifySignedLock(raw, intent)).toThrow(pattern)
  })

  it('refuses bytes whose hash is not the persisted hash (M10/M33)', async () => {
    const raw = await signer.signTransaction(tx())
    expect(() => verifySignedLock(raw, intent, '0x' + 'ab'.repeat(32))).toThrow(/hash/)
  })

  it('refuses unsigned or undecodable bytes', async () => {
    const { Transaction } = require('ethers')
    expect(() => verifySignedLock(Transaction.from(tx()).unsignedSerialized, intent)).toThrow(/signature/)
    expect(() => verifySignedLock('0xdeadbeef', intent)).toThrow(/does not decode/)
  })
})

describe('classifyLockReceipt() — H/NF2: only 0x1 / 0x0 with a block number and block hash decide', () => {
  const h = '0x' + 'cd'.repeat(32)
  const bh = '0x' + 'ab'.repeat(32)
  it.each([
    [null, 'NONE'],
    [{ status: '0x1', blockNumber: '0x10', blockHash: bh, transactionHash: h }, 'MINED'],
    [{ status: '0x0', blockNumber: '0x10', blockHash: bh }, 'MINED'],
    [{ status: '0x1', blockNumber: '0x10' }, 'UNRESOLVED'],
    [{ status: '0x1', blockNumber: '0x10', blockHash: '0x1234' }, 'UNRESOLVED'],
    [{ status: null, blockNumber: '0x10' }, 'UNRESOLVED'],
    [{ blockNumber: '0x10' }, 'UNRESOLVED'],
    [{ status: '0x2', blockNumber: '0x10' }, 'UNRESOLVED'],
    [{ status: 1, blockNumber: '0x10' }, 'UNRESOLVED'],
    [{ status: '0x1' }, 'UNRESOLVED'],
    [{ status: '0x1', blockNumber: 16 }, 'UNRESOLVED'],
    [{ status: '0x1', blockNumber: '0x10', transactionHash: '0x' + 'ef'.repeat(32) }, 'UNRESOLVED'],
    ['garbage', 'UNRESOLVED'],
    [undefined, 'UNRESOLVED'],
  ])('%j -> %s', (raw, kind) => {
    expect(classifyLockReceipt(raw, h).kind).toBe(kind)
  })

  it('reports success and revert distinctly, with the block number and (normalized) block hash', () => {
    expect(classifyLockReceipt({ status: '0x1', blockNumber: '0x10', blockHash: bh.toUpperCase().replace('0X', '0x') }, h)).toEqual({ kind: 'MINED', success: true, blockNumber: 16, blockHash: bh })
    expect(classifyLockReceipt({ status: '0x0', blockNumber: '0x10', blockHash: bh }, h)).toEqual({ kind: 'MINED', success: false, blockNumber: 16, blockHash: bh })
  })
})

describe('toExactBaseUnits() — NF1: exact, never truncated', () => {
  it.each([['5', 5_000_000n], ['1.5', 1_500_000n], ['0.000001', 1n], ['1.12345600', 1_123_456n], ['0', 0n], ['123456789.000000', 123_456_789_000_000n]])('%s -> %s', (d, units) => {
    expect(toExactBaseUnits(d)).toBe(units)
  })
  it.each(['1.1234567', '0.00000001', '1e-8', '-1', '1,5', '', ' 1'])('refuses %j', (d) => {
    expect(() => toExactBaseUnits(d)).toThrow()
  })
})

describe('wdkAttemptIsNonEconomic() — Q: what lets a trade be cancelled / refunded from CREATED', () => {
  it.each([
    ['PREPARED', 'SIGNED_RAW_V1', true],
    ['FAILED_BEFORE_SUBMISSION', 'SIGNED_RAW_V1', true],
    ['REVERTED', 'SIGNED_RAW_V1', true],
    ['PREPARED', 'LEGACY_TRANSFER_V0', true],
    ['FAILED_BEFORE_SUBMISSION', 'LEGACY_TRANSFER_V0', true],
    ['REVERTED', 'LEGACY_TRANSFER_V0', false],
    ['SIGNED', 'SIGNED_RAW_V1', false],
    ['SUBMITTED', 'SIGNED_RAW_V1', false],
    ['CONFIRMED', 'SIGNED_RAW_V1', false],
    ['NONCE_CONSUMED_ELSEWHERE', 'SIGNED_RAW_V1', false],
    ['SUBMISSION_UNKNOWN', 'LEGACY_TRANSFER_V0', false],
    ['SUBMITTED', 'LEGACY_TRANSFER_V0', false],
    ['CONFIRMED', 'LEGACY_TRANSFER_V0', false],
    ['SOME_FUTURE_STATE', 'SIGNED_RAW_V1', false],
  ])('%s / %s -> %s', (status, authority, safe) => {
    expect(wdkAttemptIsNonEconomic({ status, authority })).toBe(safe)
  })
})

describe('#235 R7G-F6B-P — finality policy has no default (D1/D2: CTO_FINALITY_VALUE_REQUIRED)', () => {
  it('WDK_FINALITY_CONFIRMATIONS unset means no finality rule at all — never a silently chosen depth', () => {
    expect(process.env.WDK_FINALITY_CONFIRMATIONS ?? '').toBe('')
    const { config } = require('../src/config')
    expect(config.wdk.finalityConfirmations).toBeUndefined()
  })
})

describe('#235 R7G-F6B-P1 — corroboration and backpressure configuration (A1/A2/H1-H6/O1/O2)', () => {
  const load = (env: Record<string, string>) => {
    const saved = { ...process.env }
    Object.assign(process.env, env)
    try {
      let mod!: { config: any; provider: any }
      jest.isolateModules(() => {
        mod = { config: require('../src/config').config, provider: require('../src/modules/open-settlement/wdk-settlement.provider').wdkSettlementProvider }
      })
      return mod
    } finally {
      process.env = saved
    }
  }

  it('no corroborating RPC and no stuck threshold by default — never a silently chosen production value', () => {
    const { config } = load({})
    expect([config.wdk.corroboratingRpcUrl, config.wdk.laneStuckBlocks, config.wdk.rpcLabel, config.wdk.corroboratingRpcLabel]).toEqual(['', undefined, 'primary', 'corroborator'])
    // H2: the default WDK_RPC_URL points at Sepolia, but no chain (hence no network policy) is ever implied
    expect([config.wdk.chainId, config.wdk.finalityConfirmations]).toEqual([undefined, undefined])
  })

  it.each([
    ['unset (A2)', { WDK_CHAIN_ID: '31337' }, /WDK_CORROBORATING_RPC_URL is not configured/],
    ['the primary URL (A1)', { WDK_CHAIN_ID: '31337', WDK_RPC_URL: 'http://a.test:8545', WDK_CORROBORATING_RPC_URL: 'HTTP://A.TEST:8545' }, /is the primary WDK_RPC_URL/],
    ['an unpinned chain', { WDK_RPC_URL: 'http://a.test:8545', WDK_CORROBORATING_RPC_URL: 'http://b.test:8545' }, /requires WDK_CHAIN_ID/],
    ['the same source label', { WDK_CHAIN_ID: '31337', WDK_RPC_URL: 'http://a.test:8545', WDK_CORROBORATING_RPC_URL: 'http://b.test:8545', WDK_RPC_LABEL: 'x', WDK_CORROBORATING_RPC_LABEL: 'x' }, /two different sources/],
  ])('a corroborating RPC that is %s is unavailable — no irreversible conclusion', (_label, env, pattern) => {
    const { provider } = load(env as Record<string, string>)
    expect(() => provider.corroboratorRpc()).toThrow(pattern)
  })

  it('a distinct corroborating RPC on a pinned chain is accepted; WDK_LANE_STUCK_BLOCKS must be a positive integer', () => {
    const { provider, config } = load({ WDK_CHAIN_ID: '31337', WDK_RPC_URL: 'http://a.test:8545', WDK_CORROBORATING_RPC_URL: 'http://b.test:8545', WDK_LANE_STUCK_BLOCKS: '12' })
    expect(provider.corroboratorRpc()).toBeDefined()
    expect(config.wdk.laneStuckBlocks).toBe(12)
    expect(() => load({ WDK_LANE_STUCK_BLOCKS: '0' })).toThrow()
    expect(() => load({ WDK_LANE_STUCK_BLOCKS: '1.5' })).toThrow()
  })
})

describe('#235 R7G-F6B-P1 — wdk:lane CLI arguments (N5-N9: no force, no setter, fail closed)', () => {
  const { parseLaneArgs } = require('../scripts/wdk-lane')
  const ACCOUNT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
  let exit: jest.SpyInstance
  let errors: jest.SpyInstance
  beforeEach(() => {
    exit = jest.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`) }) as never)
    errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => { exit.mockRestore(); errors.mockRestore() })
  const refused = (argv: string[]) => {
    expect(() => parseLaneArgs(argv)).toThrow('exit 1')
    return String(errors.mock.calls[errors.mock.calls.length - 1]?.[0])
  }

  it('parses status and a confirmed resume', () => {
    expect(parseLaneArgs(['status', '--chain-id', '31337', '--account', ACCOUNT])).toMatchObject({ command: 'status', chainId: 31337, account: ACCOUNT })
    expect(parseLaneArgs(['resume', '--chain-id', '31337', '--account', ACCOUNT, '--operator', 'ops-1', '--confirm'])).toMatchObject({ command: 'resume', operator: 'ops-1' })
  })

  it.each([
    [['resume', '--chain-id', '31337', '--account', ACCOUNT, '--operator', 'o', '--confirm', '--force'], /--force is not an option/],
    [['resume', '--chain-id', '31337', '--account', ACCOUNT, '--operator', 'o', '--confirm', '--next-nonce', '9'], /--next-nonce is not an option/],
    [['set-next-nonce', '--chain-id', '31337'], /command must be one of/],
    [['mark-confirmed'], /command must be one of/],
    [['resume', '--chain-id', '31337', '--account', ACCOUNT, '--operator', 'o'], /re-run with --confirm/],
    [['pause', '--chain-id', '31337', '--account', ACCOUNT, '--confirm'], /--operator <label> is required/],
    [['status', '--chain-id', '0x7a69', '--account', ACCOUNT], /--chain-id <positive integer>/],
    [['status', '--chain-id', '31337'], /--account <0x address> is required/],
    [['status', '--chain-id', '31337', '--account', ACCOUNT, '--chain-id', '1'], /given twice/],
  ])('refuses %j', (argv, pattern) => {
    expect(refused(argv as string[])).toMatch(pattern)
  })
})
