/**
 * #235 R7G-F6B — the EVM JSON-RPC primitives the WDK LOCK authority needs and @tetherto/wdk-wallet-evm
 * (1.0.0-beta.16) does not expose safely: raw-transaction broadcast (its sendTransaction(rawString)
 * re-populates and re-signs a different transaction), receipt/nonce/block reads, gas and fee quotes,
 * and the chain id the endpoint actually serves (WDK_SIGNED_RAW_BROADCAST_V1, pinned ethers 6.17.0).
 *
 * Results that carry economic meaning (receipts, the broadcast result) are returned exactly as the
 * endpoint sent them, so the caller classifies them itself and nothing is normalized into a value the
 * endpoint never said. One module so tests can substitute a chain double at this boundary only.
 */
import { JsonRpcProvider, Network } from 'ethers'

export interface WdkRpc {
  /** eth_chainId, as reported by the endpoint. */
  chainId(): Promise<bigint>
  blockNumber(): Promise<number>
  /** eth_getTransactionCount at a block tag or number. */
  nonce(address: string, block: 'latest' | 'pending' | number): Promise<number>
  /** eth_getBalance (native currency, wei) at a block tag. */
  balance(address: string, block: 'latest' | 'pending'): Promise<bigint>
  estimateGas(tx: { from: string; to: string; data: string }): Promise<bigint>
  feeData(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>
  /** eth_sendRawTransaction; the raw JSON-RPC result (normally the transaction hash). */
  sendRawTransaction(signedRawTx: string): Promise<unknown>
  /** eth_getTransactionReceipt; the raw JSON-RPC result (null when the endpoint has no receipt). */
  receipt(txHash: string): Promise<unknown>
}

const toBigInt = (value: unknown, what: string): bigint => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`RPC returned a malformed ${what}: ${JSON.stringify(value)}`)
  return BigInt(value)
}

export function createWdkRpc(url: string, chainId: number): WdkRpc {
  // staticNetwork: ethers never "detects" (and silently adopts) a network; the chain the endpoint
  // serves is checked explicitly through chainId() before every economic use.
  const provider = new JsonRpcProvider(url, Network.from(chainId), { staticNetwork: true })
  return {
    chainId: async () => toBigInt(await provider.send('eth_chainId', []), 'chain id'),
    blockNumber: async () => Number(toBigInt(await provider.send('eth_blockNumber', []), 'block number')),
    nonce: async (address, block) =>
      Number(toBigInt(await provider.send('eth_getTransactionCount', [address, typeof block === 'number' ? `0x${block.toString(16)}` : block]), 'nonce')),
    balance: async (address, block) => toBigInt(await provider.send('eth_getBalance', [address, block]), 'balance'),
    estimateGas: async (tx) => toBigInt(await provider.send('eth_estimateGas', [tx]), 'gas estimate'),
    feeData: async () => {
      const fee = await provider.getFeeData()
      if (fee.maxFeePerGas == null || fee.maxPriorityFeePerGas == null) {
        throw new Error('RPC returned no EIP-1559 fee data (maxFeePerGas / maxPriorityFeePerGas)')
      }
      return { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
    },
    sendRawTransaction: (signedRawTx) => provider.send('eth_sendRawTransaction', [signedRawTx]),
    receipt: (txHash) => provider.send('eth_getTransactionReceipt', [txHash]),
  }
}
