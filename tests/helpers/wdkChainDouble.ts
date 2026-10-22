/**
 * #235 R7G-F6B — an in-memory EVM chain double for the WDK LOCK authority (the wdk-rpc.ts boundary).
 *
 * Faithful where the authority depends on it: real ethers decoding of every raw transaction (signer,
 * nonce, chain id, hash recomputed from the bytes), per-account nonces with gaps blocking later nonces,
 * "already known" / "nonce too low" / same-nonce replacement refusal, an ERC-20 transfer that moves token
 * balances or reverts, receipts only for mined transactions, block-tagged nonce history. Everything else
 * (fee markets, eviction policy, reorgs) is not modelled — those are REQUIRES_LIVE_ECONOMIC_REHEARSAL; the
 * local-EVM evidence covers a real node.
 *
 * #235 R7G-F6C — opt-in native gas accounting (gasAccounting = true): an account must hold
 * gasLimit x maxFeePerGas + value to have a transaction accepted, mining charges gasUsed x the effective price
 * (min(maxFee, baseFee + priority)) and moves a native value. Off by default, so suites written before it keep
 * their gas-free treasury.
 *
 * #235 R7G-F6B-P1 — corroboratorRpc() is a second observer of the same chain (the corroborating RPC), with
 * its own faults: unavailable, another chain, lagging behind the head (it then knows nothing past its own
 * head), or arbitrary receipt / nonce answers. It never accepts broadcasts.
 */
import { Interface, Transaction, getAddress, id } from 'ethers'

const ERC20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])

type Pending = { raw: string; hash: string; from: string; nonce: number; to: string | null; data: string; maxFeePerGas: bigint; maxPriorityFeePerGas?: bigint; gasLimit?: bigint; value?: bigint }
type Mined = { hash: string; from: string; nonce: number; blockNumber: number; blockHash: string; status: 0 | 1; pending: Pending }

export class WdkChainDouble {
  chainIdValue = 31337n
  head = 0
  readonly mempool = new Map<string, Pending>()
  readonly mined = new Map<string, Mined>()
  readonly minedNonce = new Map<string, number>()
  readonly nonceHistory: Array<Map<string, number>> = [new Map()]
  readonly tokenBalances = new Map<string, bigint>()
  /** #235 R7G-F6C — native gas accounting (see the header). */
  gasAccounting = false
  baseFee = 1_000_000_000n
  readonly nativeBalances = new Map<string, bigint>()
  readonly gasSpent = new Map<string, bigint>()
  static readonly TOKEN_TRANSFER_GAS = 50_000n
  static readonly NATIVE_TRANSFER_GAS = 21_000n
  readonly balanceHistory: Array<Map<string, bigint>> = [new Map()]
  /** Fork identity: blocks mined after a reorg get different hashes. */
  branch = 0
  blockHash(n: number) {
    return id(`wdk-chain-double:${this.branch}:${n}`)
  }
  sendCalls: string[] = []
  /** Test hooks. */
  hooks: {
    beforeSend?: (raw: string) => void | 'ACCEPT_THEN_THROW'
    receipt?: (hash: string) => unknown | undefined
    estimateGas?: () => bigint
    pendingNonce?: (address: string) => number | undefined
    /** The primary RPC lags this many blocks behind the head (it knows nothing past its own head). */
    headLag?: number
  } = {}
  /** Corroborating-RPC faults (#235 R7G-F6B-P1). */
  corroborator: {
    unavailable?: boolean
    chainId?: bigint
    headLag?: number
    receipt?: (hash: string) => unknown | undefined
    nonce?: (address: string, block: 'latest' | 'pending' | number) => number | undefined | Promise<number | undefined>
  } = {}
  corroboratorCalls = 0

  constructor(readonly token: string) {}

  fund(address: string, amount: bigint) {
    this.tokenBalances.set(getAddress(address), (this.tokenBalances.get(getAddress(address)) ?? 0n) + amount)
    this.balanceHistory[this.head] = new Map(this.tokenBalances)
  }
  balance(address: string) {
    return this.tokenBalances.get(getAddress(address)) ?? 0n
  }
  fundNative(address: string, wei: bigint) {
    this.nativeBalances.set(getAddress(address), this.nativeBalance(address) + wei)
  }
  nativeBalance(address: string) {
    return this.nativeBalances.get(getAddress(address)) ?? 0n
  }
  latestNonce(address: string, block?: number) {
    const a = getAddress(address)
    if (block === undefined) return this.minedNonce.get(a) ?? 0
    return this.nonceHistory[Math.min(block, this.head)]?.get(a) ?? 0
  }
  pendingNonce(address: string) {
    const a = getAddress(address)
    let n = this.latestNonce(a)
    const own = [...this.mempool.values()].filter((p) => p.from === a)
    while (own.some((p) => p.nonce === n)) n++
    return n
  }

  sendRaw(raw: string): string {
    this.sendCalls.push(raw)
    const directive = this.hooks.beforeSend?.(raw)
    const tx = Transaction.from(raw)
    if (tx.chainId !== this.chainIdValue) throw new Error(`invalid chain id ${tx.chainId}`)
    const from = getAddress(tx.from!)
    const hash = tx.hash!
    if (this.mined.has(hash) || tx.nonce < this.latestNonce(from)) throw new Error(`nonce too low: next nonce ${this.latestNonce(from)}, tx nonce ${tx.nonce}`)
    if (this.mempool.has(hash)) throw new Error('already known')
    const clash = [...this.mempool.values()].find((p) => p.from === from && p.nonce === tx.nonce)
    if (clash) throw new Error('replacement transaction underpriced')
    if (this.gasAccounting && this.nativeBalance(from) < tx.gasLimit * (tx.maxFeePerGas ?? 0n) + tx.value) {
      throw new Error(`insufficient funds for gas * price + value: balance ${this.nativeBalance(from)}, tx cost ${tx.gasLimit * (tx.maxFeePerGas ?? 0n) + tx.value}`)
    }
    this.mempool.set(hash, { raw, hash, from, nonce: tx.nonce, to: tx.to, data: tx.data, maxFeePerGas: tx.maxFeePerGas ?? 0n, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n, gasLimit: tx.gasLimit, value: tx.value })
    if (directive === 'ACCEPT_THEN_THROW') throw new Error('socket hang up (response lost after the node accepted the transaction)')
    return hash
  }

  /** A transaction Sails did not sign, from `from`, consuming its next nonce. */
  external(from: string) {
    const a = getAddress(from)
    const nonce = this.pendingNonce(a)
    const hash = `0x${'e'.repeat(56)}${nonce.toString(16).padStart(8, '0')}`
    this.mempool.set(hash, { raw: '', hash, from: a, nonce, to: null, data: '0x', maxFeePerGas: 0n })
    return hash
  }

  drop(hash: string) {
    this.mempool.delete(hash)
  }

  mine(blocks = 1) {
    for (let b = 0; b < blocks; b++) {
      this.head++
      let progressed = true
      while (progressed) {
        progressed = false
        for (const p of [...this.mempool.values()].sort((x, y) => x.nonce - y.nonce)) {
          if (p.nonce !== this.latestNonce(p.from)) continue
          let status: 0 | 1 = 1
          if (this.gasAccounting && p.raw) {
            const price = p.maxFeePerGas < this.baseFee + (p.maxPriorityFeePerGas ?? 0n) ? p.maxFeePerGas : this.baseFee + (p.maxPriorityFeePerGas ?? 0n)
            const used = p.data === '0x' ? WdkChainDouble.NATIVE_TRANSFER_GAS : WdkChainDouble.TOKEN_TRANSFER_GAS
            const cost = used * price
            if (this.nativeBalance(p.from) < cost + (p.value ?? 0n)) continue // not executable yet (cannot pay): stays pending
            this.nativeBalances.set(p.from, this.nativeBalance(p.from) - cost)
            this.gasSpent.set(p.from, (this.gasSpent.get(p.from) ?? 0n) + cost)
            if ((p.value ?? 0n) > 0n && p.to) {
              this.nativeBalances.set(p.from, this.nativeBalance(p.from) - (p.value as bigint))
              this.fundNative(p.to, p.value as bigint)
            }
          }
          if (p.data !== '0x' && p.to) {
            const d = ERC20.parseTransaction({ data: p.data })!
            const amount = d.args[1] as bigint
            if (getAddress(p.to) !== getAddress(this.token) || this.balance(p.from) < amount) status = 0
            else {
              this.tokenBalances.set(p.from, this.balance(p.from) - amount)
              this.fund(d.args[0] as string, amount)
            }
          }
          this.mempool.delete(p.hash)
          this.mined.set(p.hash, { hash: p.hash, from: p.from, nonce: p.nonce, blockNumber: this.head, blockHash: this.blockHash(this.head), status, pending: p })
          this.minedNonce.set(p.from, p.nonce + 1)
          progressed = true
        }
      }
      this.nonceHistory[this.head] = new Map(this.minedNonce)
      this.balanceHistory[this.head] = new Map(this.tokenBalances)
    }
  }

  /** Reorg: drops the newest `depth` blocks; their transactions go back to the mempool (the fork is new). */
  reorg(depth: number) {
    const newHead = this.head - depth
    for (const [hash, m] of [...this.mined]) {
      if (m.blockNumber > newHead) {
        this.mined.delete(hash)
        if (m.pending.raw || m.pending.data === '0x') this.mempool.set(hash, m.pending)
      }
    }
    this.minedNonce.clear()
    for (const [a, n] of this.nonceHistory[newHead] ?? new Map()) this.minedNonce.set(a, n)
    this.tokenBalances.clear()
    for (const [a, v] of this.balanceHistory[newHead] ?? new Map()) this.tokenBalances.set(a, v)
    this.nonceHistory.length = newHead + 1
    this.balanceHistory.length = newHead + 1
    this.head = newHead
    this.branch++
  }

  receipt(hash: string): unknown {
    const override = this.hooks.receipt?.(hash)
    if (override !== undefined) return override
    const m = this.mined.get(hash)
    return m ? { transactionHash: hash, blockNumber: `0x${m.blockNumber.toString(16)}`, blockHash: m.blockHash, status: m.status ? '0x1' : '0x0' } : null
  }

  /** The wdk-rpc.ts WdkRpc this double serves. */
  rpc() {
    const lag = () => this.hooks.headLag ?? 0
    const head = () => Math.max(0, this.head - lag())
    return {
      chainId: async () => this.chainIdValue,
      blockNumber: async () => head(),
      nonce: async (address: string, block: 'latest' | 'pending' | number) =>
        block === 'pending' ? (this.hooks.pendingNonce?.(address) ?? this.pendingNonce(address))
          : this.latestNonce(address, block === 'latest' ? (lag() ? head() : undefined) : Math.min(block, head())),
      balance: async (address: string) => this.nativeBalance(address),
      estimateGas: async () => this.hooks.estimateGas?.() ?? 60_000n,
      feeData: async () => ({ maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
      sendRawTransaction: async (raw: string) => this.sendRaw(raw),
      receipt: async (hash: string) => {
        const r = this.receipt(hash) as { blockNumber?: string } | null
        return r && typeof r.blockNumber === 'string' && Number(BigInt(r.blockNumber)) > head() ? null : r
      },
    }
  }

  /** The corroborating RPC's view of this chain (evidence only: it refuses broadcasts). */
  corroboratorRpc() {
    const view = this.corroborator
    const up = () => {
      this.corroboratorCalls++
      if (view.unavailable) throw new Error('ETIMEDOUT (corroborating RPC unavailable)')
    }
    const head = () => Math.max(0, this.head - (view.headLag ?? 0))
    return {
      chainId: async () => { up(); return view.chainId ?? this.chainIdValue },
      blockNumber: async () => { up(); return head() },
      nonce: async (address: string, block: 'latest' | 'pending' | number) => {
        up()
        const override = await view.nonce?.(address, block)
        if (override !== undefined) return override
        return this.latestNonce(address, block === 'latest' || block === 'pending' ? head() : Math.min(block, head()))
      },
      balance: async (address: string) => { up(); return this.nativeBalance(address) },
      estimateGas: async () => { throw new Error('the corroborating RPC is evidence only (estimateGas)') },
      feeData: async () => { throw new Error('the corroborating RPC is evidence only (feeData)') },
      sendRawTransaction: async () => { throw new Error('the corroborating RPC must never broadcast') },
      receipt: async (hash: string) => {
        up()
        const override = view.receipt?.(hash)
        if (override !== undefined) return override
        const m = this.mined.get(hash)
        if (!m || m.blockNumber > head()) return null
        return { transactionHash: hash, blockNumber: `0x${m.blockNumber.toString(16)}`, blockHash: m.blockHash, status: m.status ? '0x1' : '0x0' }
      },
    }
  }

  /** Distinct signed transactions ever presented for broadcast, by hash. */
  distinctBroadcastHashes(): Set<string> {
    return new Set(this.sendCalls.map((raw) => Transaction.from(raw).hash!))
  }
}
